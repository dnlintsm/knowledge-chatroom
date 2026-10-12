/**
 * Claude Agent SDK (TypeScript) starter — AG-UI SSE server.
 *
 * Serves the agent (defined in src/agent.ts) over AG-UI: `POST /` streams
 * `adapter.run(input)`, `GET /health` reports status. Runs on port 8000.
 * When DATABASE_URL is set it also serves the workspace file API under
 * `/files`, the knowledge tree under `/nodes`, experiments under `/experiments`,
 * search under `/search`, proposed versions under `/proposals` and groups
 * and grants under `/access` (see
 * src/storage/http.ts). `/skills` lists the user's skills and their modes
 * (src/skills/http.ts), with or without storage.
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
import { IDENTITY_HEADER, identify, verifyIdentity } from "./storage/identity";
import { createSkillsHandler } from "./skills/http";
import { materialize, type RunSkills, type SkillUse } from "./skills/run";
import { SkillService } from "./skills/service";

const PORT = Number.parseInt(process.env.AGENT_PORT || "8000", 10);
const HOST = process.env.AGENT_HOST || "0.0.0.0";

// Storage is optional (DATABASE_URL) and starts in the background.
const storageConfig = storageConfigFromEnv();
startStorage(storageConfig);
const handleStorage = createStorageHandler(
  currentStorage,
  storageConfig?.maxUploadBytes ?? 0,
  storageState,
);
const skills = new SkillService(currentStorage);
const handleSkills = createSkillsHandler(skills, currentStorage, storageState);

/** The run's skills: built-in ones, plus the workspace's when storage is up. */
async function prepareSkills(storage: Storage | null, userId: string | null | undefined): Promise<RunSkills | null> {
  // With storage but nobody allowed (login without a user): no skills either.
  if (storage && !userId) return null;
  const owner = storage ? userId! : null;
  try {
    return await materialize(owner ?? "local", await skills.forRun(owner));
  } catch (err) {
    console.error(`[skills] couldn't prepare skills; running without them: ${err instanceof Error ? err.message : err}`);
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

  if (pathname === "/skills" || pathname.startsWith("/skills/")) {
    await handleSkills(req, res, url);
    return;
  }

  if (/^\/(files|nodes|access|experiments|search|proposals)(\/|$)/.test(pathname)) {
    await handleStorage(req, res, url);
    return;
  }

  if (req.method === "POST" && pathname === "/") {
    // With login on, a run must be for a signed-in user (the Next.js app
    // signs that into the header), and Claude's file tools act as that user.
    const secret = storageConfig?.authSecret;
    const header = req.headers[IDENTITY_HEADER];
    if (secret && !(typeof header === "string" && verifyIdentity(header, secret))) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Sign in first" }));
      return;
    }
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

    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);

    let input: RunAgentInput;
    try {
      input = JSON.parse(
        Buffer.concat(chunks).toString("utf-8"),
      ) as RunAgentInput;
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid JSON body" }));
      return;
    }

    const encoder = new EventEncoder({
      accept: req.headers.accept ?? "text/event-stream",
    });
    res.writeHead(200, {
      "Content-Type": encoder.getContentType(),
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    const runSkills = await prepareSkills(storage, userId);
    // Each skill the run uses goes to the browser as an AG-UI custom event
    // ("skill_used"), after RUN_STARTED, and into the usage history.
    let started = false;
    const pending: SkillUse[] = [];
    const emitSkill = (use: SkillUse) =>
      res.write(encoder.encode({ type: EventType.CUSTOM, name: "skill_used", value: use } as never));
    const onSkillUse = (use: SkillUse) => {
      if (res.writableEnded) return;
      if (started) emitSkill(use);
      else pending.push(use);
      void skills.record(storage ? (userId ?? null) : null, {
        threadId: input.threadId ?? "",
        runId: input.runId ?? "",
        ...use,
      });
    };

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
              pending.splice(0).forEach(emitSkill);
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
});
