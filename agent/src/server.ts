/**
 * Claude Agent SDK (TypeScript) starter — AG-UI SSE server.
 *
 * Serves the agent (defined in src/agent.ts) over AG-UI: `POST /` streams
 * `adapter.run(input)`, `POST /suggest` answers the chat's follow-up chips
 * (src/suggest.ts), `GET /health` reports status, `GET /identity/public-key`
 * gives outside services the key that verifies identity tokens. Runs on port 8000. With
 * AGENT_URL set, the app's chat goes to a remote backend instead and both chat
 * routes answer 404 (docs/remote-agent.md).
 * When DATABASE_URL is set it also serves the workspace file API under
 * `/files`, the knowledge tree under `/nodes`, experiments under `/experiments`,
 * search under `/search`, proposed versions under `/proposals`, each user's
 * chat history under `/chats` and groups and grants under `/access` (see
 * src/storage/http.ts). `/skills` lists the user's skills and their modes
 * (src/skills/http.ts), with or without storage; `/hub` is the skill hub.
 * With MEMORY=on and storage, `/memory` is each user's personalized memory
 * (src/memory/http.ts).
 *
 * (The TypeScript adapter ships no FastAPI-style helper like the Python package's
 * `add_claude_fastapi_endpoint`, so this is the tiny node:http equivalent.)
 */

import http from "node:http";

import { EventType } from "@ag-ui/core";
import type { RunAgentInput } from "@ag-ui/core";
import { EventEncoder } from "@ag-ui/encoder";

import { adapter, runAs } from "./agent";
import { currentStorage, startStorage, storageState, type Storage } from "./storage";
import { storageConfigFromEnv } from "./storage/config";
import { createStorageHandler } from "./storage/http";
import { clearWorkdir, syncWorkdir, workdirEnabled } from "./storage/workdir";
import { IDENTITY_HEADER, identify, signIdentity, verifyIdentity } from "./storage/identity";
import { SkillHub } from "./skills/hub";
import { createSkillsHandler } from "./skills/http";
import { createMemoryHandler } from "./memory/http";
import { prepareMemory } from "./memory/run";

/**
 * The knowledge node the user is in, from the app's run payload
 * (src/lib/chatroom-props.ts): its shared memory applies to the run. The
 * browser says it; reading it as the user decides whether it counts.
 */
function placeNode(props: unknown): string | null {
  const place = (props as { knowledge_chatroom?: { node?: { id?: unknown } | null } } | undefined)?.knowledge_chatroom;
  const id = place?.node?.id;
  return typeof id === "string" && /^[0-9a-f-]{36}$/i.test(id) ? id : null;
}
import { learningEnabled, MemoryLearner } from "./memory/learn";
import { keyRoute } from "./skills/keyproxy";
import { materialize, scriptsEnabled, type RunSkills, type SkillUse } from "./skills/run";
import { SkillService } from "./skills/service";
import { suggest } from "./suggest";
import { authSettings } from "../../shared/auth-mode";
import {
  STORAGE_AUDIENCE,
  identityFormat,
  identityPublicKey,
  storageTokenSeconds,
} from "../../shared/identity-token";
import type { RunTokens } from "./mcp";

const PORT = Number.parseInt(process.env.AGENT_PORT || "8000", 10);
// AGENT_URL set: the app's chat goes to a remote backend (docs/remote-agent.md),
// so this server keeps storage, skills and the hub, and its own chat is off.
const REMOTE_CHAT = Boolean(process.env.AGENT_URL?.trim());
const HOST = process.env.AGENT_HOST || "0.0.0.0";

// Login settings are checked at startup whether or not storage is on.
const authSecret = authSettings().secret;
identityFormat();
const STORAGE_TOKEN_SECONDS = storageTokenSeconds();
// Outside services (remote backends, MCP servers) verify identity tokens with
// this public key instead of AUTH_SECRET (docs/remote-agent.md).
const publicKey = authSecret ? identityPublicKey(authSecret) : null;
// Storage is optional (DATABASE_URL) and starts in the background.
const storageConfig = storageConfigFromEnv();
startStorage(storageConfig);
const handleStorage = createStorageHandler(
  currentStorage,
  storageConfig?.maxUploadBytes ?? 0,
  storageState,
);
const skills = new SkillService(currentStorage);
const hub = new SkillHub(currentStorage, skills);
const handleSkills = createSkillsHandler(skills, hub, currentStorage, storageState);
const handleMemory = createMemoryHandler(currentStorage, storageState);
// Learns from chats once they go quiet (MEMORY=on, storage; ./memory/learn.ts).
if (storageConfig && learningEnabled()) new MemoryLearner(currentStorage).start();

/** The run's skills: built-in ones, plus the workspace's when storage is up, in this chat's modes. */
async function prepareSkills(
  storage: Storage | null,
  userId: string | null | undefined,
  threadId: string | undefined,
): Promise<RunSkills | null> {
  // With storage but nobody allowed (login without a user): no skills either.
  if (storage && !userId) return null;
  const owner = storage ? userId! : null;
  try {
    const run = await materialize(owner ?? "local", await skills.forRun(owner, threadId));
    // Scripts run with a stand-in key; without the proxy, the run has no Bash.
    if (scriptsEnabled() && run.skills.some((s) => s.skill.needsExecution)) {
      run.keys = await keyRoute().catch((err) => {
        console.error(`[skills] key proxy didn't start; scripts are off for this run: ${err instanceof Error ? err.message : err}`);
        return undefined;
      });
    }
    // The workspace copy Claude reads with Read/Glob/Grep (./storage/workdir.ts).
    if (storage && userId && workdirEnabled()) {
      run.workdir = await syncWorkdir(storage.session({ userId, actor: "agent" }), run.cwd).catch((err) => {
        console.error(`[workdir] couldn't copy the workspace; running without it: ${err instanceof Error ? err.message : err}`);
        return undefined;
      });
    }
    // Without a fresh copy, no old one either: scripts can read the run folder.
    if (!run.workdir) await clearWorkdir(run.cwd);
    return run;
  } catch (err) {
    console.error(`[skills] couldn't prepare skills; running without them: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

/** With login on, only requests the Next.js app signed for a user get through. */
function signedIn(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  const secret = authSecret;
  const header = req.headers[IDENTITY_HEADER];
  if (secret && !(typeof header === "string" && verifyIdentity(header, secret))) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Sign in first" }));
    return false;
  }
  return true;
}

/**
 * Signs the run's user for one outside MCP server (./mcp.ts). forwardIdentity:
 * a token for audience "mcp:<server>", which the agent itself refuses, so a
 * server can't use it against the agent. storageAccess: a storage token via
 * "mcp:<server>", which only the storage API takes. The app's header expires
 * in minutes, so these last as long as a run may. None without login.
 */
function identityForTools(req: http.IncomingMessage): RunTokens | undefined {
  const secret = authSecret;
  const header = req.headers[IDENTITY_HEADER];
  const identity = secret && typeof header === "string" ? verifyIdentity(header, secret) : null;
  if (!secret || !identity) return undefined;
  const now = Math.floor(Date.now() / 1000);
  const user = { sub: identity.sub, email: identity.email, name: identity.name };
  return (server, kind = "identity") =>
    kind === "storage"
      ? signIdentity({ ...user, aud: STORAGE_AUDIENCE, via: `mcp:${server}`, exp: now + STORAGE_TOKEN_SECONDS }, secret)
      : signIdentity({ ...user, aud: `mcp:${server}`, exp: now + TOOL_IDENTITY_SECONDS }, secret);
}

const TOOL_IDENTITY_SECONDS = 60 * 60;

/** The AG-UI run input in the body; null after answering 400 when it isn't JSON. */
async function readInput(req: http.IncomingMessage, res: http.ServerResponse): Promise<RunAgentInput | null> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf-8")) as RunAgentInput;
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Invalid JSON body" }));
    return null;
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const pathname = url.pathname;

  if (req.method === "GET" && pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }

  if (req.method === "GET" && pathname === "/identity/public-key") {
    res.writeHead(publicKey ? 200 : 404, { "Content-Type": "application/json" });
    res.end(JSON.stringify(publicKey ? { alg: "Ed25519", key: publicKey } : { error: "Login is off: there are no identity tokens." }));
    return;
  }

  if (/^\/(skills|hub)(\/|$)/.test(pathname)) {
    await handleSkills(req, res, url);
    return;
  }

  if (/^\/memory(\/|$)/.test(pathname)) {
    await handleMemory(req, res, url);
    return;
  }

  if (/^\/(files|nodes|access|experiments|search|proposals|chats)(\/|$)/.test(pathname)) {
    await handleStorage(req, res, url);
    return;
  }

  if (req.method === "POST" && pathname === "/agent/report") {
    // The app's AGENT_URL points here, but it names a remote backend now.
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      error: "This is the knowledge-chatroom agent server, not a remote backend: set LOCAL_AGENT_URL to it and unset AGENT_URL.",
    }));
    return;
  }

  if (REMOTE_CHAT && req.method === "POST" && (pathname === "/" || pathname === "/suggest")) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Chat is served by the remote backend at AGENT_URL." }));
    return;
  }

  if (req.method === "POST" && pathname === "/suggest") {
    if (!signedIn(req, res)) return;
    const input = await readInput(req, res);
    if (!input) return;
    const encoder = new EventEncoder({ accept: req.headers.accept ?? "text/event-stream" });
    const events = await suggest(input);
    res.writeHead(200, { "Content-Type": encoder.getContentType(), "Cache-Control": "no-cache" });
    for (const event of events) res.write(encoder.encode(event as never));
    res.end();
    return;
  }

  if (req.method === "POST" && pathname === "/") {
    // With login on, a run must be for a signed-in user (the Next.js app
    // signs that into the header), and Claude's file tools act as that user.
    if (!signedIn(req, res)) return;
    // Undefined while storage is still starting: the tools then decide when
    // called (the local user without login, nobody with it).
    const storage = currentStorage();
    let userId: string | null | undefined;
    if (storage) {
      try {
        userId = (await identify(req, storage, "agent"))?.userId ?? null;
      } catch (err) {
        console.error(`[agent] couldn't look up the user: ${err instanceof Error ? err.message : err}`);
        userId = null;
      }
    }

    const input = await readInput(req, res);
    if (!input) return;

    const encoder = new EventEncoder({
      accept: req.headers.accept ?? "text/event-stream",
    });
    res.writeHead(200, {
      "Content-Type": encoder.getContentType(),
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    const runSkills = await prepareSkills(storage, userId, input.threadId);
    // Each skill the run uses goes to the browser as an AG-UI custom event
    // ("skill_used"), after RUN_STARTED, and into the usage history; so does
    // each memory note Claude reads or changes ("memory").
    let started = false;
    const pending: { name: string; value: unknown }[] = [];
    const emitCustom = ({ name, value }: { name: string; value: unknown }) =>
      res.write(encoder.encode({ type: EventType.CUSTOM, name, value } as never));
    const custom = (event: { name: string; value: unknown }) => {
      if (res.writableEnded) return;
      if (started) emitCustom(event);
      else pending.push(event);
    };
    const onSkillUse = (use: SkillUse) => {
      custom({ name: "skill_used", value: use });
      void skills.record(storage ? (userId ?? null) : null, {
        threadId: input.threadId ?? "",
        runId: input.runId ?? "",
        ...use,
      });
    };
    const runMemory = await prepareMemory(
      storage,
      userId,
      { threadId: input.threadId, runId: input.runId },
      (event) => custom({ name: "memory", value: event }),
      placeNode(input.forwardedProps),
    ).catch((err) => {
      console.error(`[memory] couldn't load memory; running without it: ${err instanceof Error ? err.message : err}`);
      return null;
    });

    // The adapter emits RUN_STARTED/RUN_FINISHED/RUN_ERROR itself; the error
    // callback surfaces the message as a clean RUN_ERROR (never a broken stream).
    runAs(
      userId,
      () =>
        adapter.run(input).subscribe({
          next: (event) => {
            res.write(encoder.encode(event));
            if (!started && event.type === EventType.RUN_STARTED) {
              started = true;
              pending.splice(0).forEach(emitCustom);
            }
          },
          error: (err) => {
            const message = err instanceof Error ? err.message : String(err);
            console.error(`[agent] run error: ${message}`);
            res.write(
              encoder.encode({ type: EventType.RUN_ERROR, message } as never),
            );
            res.end();
          },
          complete: () => res.end(),
        }),
      runSkills,
      onSkillUse,
      identityForTools(req),
      runMemory,
    );
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
});

server.listen(PORT, HOST, () => {
  console.log(
    `[agent] Claude Agent SDK (TypeScript) starter listening on http://${HOST}:${PORT}`,
  );
  if (REMOTE_CHAT) {
    console.log("[agent] AGENT_URL is set: chat goes to that backend; this server serves storage and skills.");
  }
  if (publicKey) console.log(`[agent] Identity tokens verify with KNOWLEDGE_PUBLIC_KEY=${publicKey}`);
});
