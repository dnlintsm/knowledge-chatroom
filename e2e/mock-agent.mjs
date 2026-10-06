/**
 * Tiny stand-in for the Claude agent server, used by the Playwright preview
 * when no ANTHROPIC_API_KEY is available (e.g. CI on pull requests).
 *
 * Speaks just enough AG-UI over SSE on the same port as the real agent
 * (`POST /` and `GET /health`): every run replies with one canned assistant
 * message, so the chat UI can be captured end to end without calling Claude.
 *
 * A message mentioning "artifacts/" instead calls the browser's
 * writeWorkspaceFile tool, so the preview also shows Claude creating a file;
 * the follow-up run (carrying the tool result) confirms it in one line.
 */

import http from "node:http";
import { randomUUID } from "node:crypto";

const PORT = Number.parseInt(process.env.AGENT_PORT || "8000", 10);

const REPLY =
  "Hi! I'm a mock agent running in CI, so this preview works without an " +
  "Anthropic API key. With a real key, Claude answers here instead.";

const ARTIFACT_PATH = "artifacts/welcome-summary.md";
const ARTIFACT = `# Summary

**TL;DR:** a three-pane workspace where Claude reads and writes your files.

- Notes, skills, uploads and artifacts live on the left.
- The middle pane previews or edits the open file.
- The chat sees the open file and your selection.
`;

const textOf = (message) =>
  typeof message?.content === "string"
    ? message.content
    : (message?.content ?? []).map((part) => part.text ?? "").join("");

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

  const messages = input.messages ?? [];
  const last = messages[messages.length - 1];
  const wantsArtifact = last?.role === "user" && textOf(last).includes("artifacts/");
  const reply =
    last?.role === "tool" ? `Saved the summary to ${ARTIFACT_PATH} and opened it.` : REPLY;

  send({ type: "RUN_STARTED", threadId, runId });
  if (wantsArtifact) {
    const toolCallId = randomUUID();
    send({
      type: "TOOL_CALL_START",
      toolCallId,
      toolCallName: "writeWorkspaceFile",
      parentMessageId: messageId,
    });
    send({
      type: "TOOL_CALL_ARGS",
      toolCallId,
      delta: JSON.stringify({ path: ARTIFACT_PATH, content: ARTIFACT }),
    });
    send({ type: "TOOL_CALL_END", toolCallId });
    send({ type: "RUN_FINISHED", threadId, runId });
    res.end();
    return;
  }
  send({ type: "TEXT_MESSAGE_START", messageId, role: "assistant" });
  for (const word of reply.split(/(?<= )/)) {
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
