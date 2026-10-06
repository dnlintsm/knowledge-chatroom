/**
 * Tiny stand-in for the Claude agent server, used by the Playwright preview
 * when no ANTHROPIC_API_KEY is available (e.g. CI on pull requests).
 *
 * Speaks just enough AG-UI over SSE on the same port as the real agent
 * (`POST /` and `GET /health`): every run replies with one canned assistant
 * message, so the chat UI can be captured end to end without calling Claude.
 */

import http from "node:http";
import { randomUUID } from "node:crypto";

const PORT = Number.parseInt(process.env.AGENT_PORT || "8000", 10);

const REPLY =
  "Hi! I'm a mock agent running in CI, so this preview works without an " +
  "Anthropic API key. With a real key, Claude answers here instead.";

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url ?? "/", `http://${req.headers.host}`);

  if (req.method === "GET" && pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", mock: true }));
    return;
  }

  if (req.method !== "POST" || pathname !== "/") {
    res.writeHead(404).end();
    return;
  }

  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  let input = {};
  try {
    input = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
  } catch {
    // Fall through with empty ids; the run still completes.
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  const send = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);

  const threadId = input.threadId ?? randomUUID();
  const runId = input.runId ?? randomUUID();
  const messageId = randomUUID();

  send({ type: "RUN_STARTED", threadId, runId });
  send({ type: "TEXT_MESSAGE_START", messageId, role: "assistant" });
  for (const word of REPLY.split(/(?<= )/)) {
    send({ type: "TEXT_MESSAGE_CONTENT", messageId, delta: word });
    await new Promise((r) => setTimeout(r, 30));
  }
  send({ type: "TEXT_MESSAGE_END", messageId });
  send({ type: "RUN_FINISHED", threadId, runId });
  res.end();
});

server.listen(PORT, () => {
  console.log(`Mock AG-UI agent listening on http://localhost:${PORT}`);
});
