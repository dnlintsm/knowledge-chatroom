/**
 * Claude Agent SDK (TypeScript) starter — AG-UI SSE server.
 *
 * Serves the agent (defined in src/agent.ts) over AG-UI: `POST /` streams
 * `adapter.run(input)`, `GET /health` reports status. Runs on port 8000.
 * When DATABASE_URL is set it also serves the workspace file API under
 * `/files`, the knowledge tree under `/nodes`, experiments under `/experiments`,
 * search under `/search` and groups and grants under `/access` (see
 * src/storage/http.ts).
 *
 * (The TypeScript adapter ships no FastAPI-style helper like the Python package's
 * `add_claude_fastapi_endpoint`, so this is the tiny node:http equivalent.)
 */

import http from "node:http";

import { EventType } from "@ag-ui/core";
import type { RunAgentInput } from "@ag-ui/core";
import { EventEncoder } from "@ag-ui/encoder";

import { adapter, runAs } from "./agent";
import { currentStorage, startStorage, storageState } from "./storage";
import { storageConfigFromEnv } from "./storage/config";
import { createStorageHandler } from "./storage/http";
import { IDENTITY_HEADER, identify, verifyIdentity } from "./storage/identity";

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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const pathname = url.pathname;

  if (req.method === "GET" && pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }

  if (/^\/(files|nodes|access|experiments|search)(\/|$)/.test(pathname)) {
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

    // The adapter emits RUN_STARTED/RUN_FINISHED/RUN_ERROR itself; the error
    // callback surfaces the message as a clean RUN_ERROR (never a broken stream).
    runAs(userId, () => adapter.run(input).subscribe({
      next: (event) => res.write(encoder.encode(event)),
      error: (err) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[agent] run error: ${message}`);
        res.write(
          encoder.encode({ type: EventType.RUN_ERROR, message } as never),
        );
        res.end();
      },
      complete: () => res.end(),
    }));
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
