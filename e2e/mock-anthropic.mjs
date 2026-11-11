/**
 * A stand-in for the Anthropic Messages API, so e2e tests can run a real
 * Claude Code engine without an API key or a model. The Python chat agent
 * (services/agent-py) runs Claude Code through the Claude Agent SDK, and
 * python-agent.spec.ts points its ANTHROPIC_BASE_URL here.
 *
 * `POST /v1/messages` streams one scripted assistant turn, chosen by the last
 * user turn of the request:
 *
 * - it holds a tool result: one line saying it's done (with the result's path);
 * - the user's words (not the workspace note) mention "artifacts/" and the
 *   browser's writeWorkspaceFile tool is offered: a call to it, writing ARTIFACT;
 * - it holds the tldr skill's instructions (a "/tldr" message): a TL;DR;
 * - anything else: REPLY.
 *
 * `POST /v1/messages/count_tokens` answers a small count, `GET /health` ok,
 * and `GET /last-request` the last chat turn's request (one with tools), so
 * tests can check what the engine sent (system prompt, tools, workspace note).
 */

import http from "node:http";
import { randomUUID } from "node:crypto";

const PORT = Number.parseInt(process.env.MOCK_MODEL_PORT || "9500", 10);

const REPLY = "Hello from the Python agent. I can see your workspace.";
const ARTIFACT = { path: "artifacts/python-agent.md", content: "# From the Python agent\n\nWritten through the browser's tool.\n" };
const TLDR = "**TL;DR:** RF power drives etch rate (via the tldr skill).";
/** A line of the tldr skill's SKILL.md (mock-agent.mjs), which Claude Code puts in the turn. */
const TLDR_MARKER = "Reply with one TL;DR line";

/** The last request with tools (a chat turn), for GET /last-request. */
let lastRequest = null;

const textOf = (content) =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((block) => (block?.type === "text" ? block.text : "")).join("\n")
      : "";

/** The `path` in a tool's JSON answer (which may come JSON-encoded again). */
function pathIn(text) {
  return /\\?"path\\?"\s*:\s*\\?"([^"\\]+)/.exec(text)?.[1] ?? null;
}

/** What the scripted model answers: text, or one tool call. */
function answer(request) {
  const turn = [...(request.messages ?? [])].reverse().find((m) => m.role === "user");
  const blocks = Array.isArray(turn?.content) ? turn.content : [];
  const result = blocks.find((block) => block?.type === "tool_result");
  if (result) {
    // The browser tool's answer, then (agent_py/place.py) a workspace note.
    const parts = typeof result.content === "string" ? [result.content] : (result.content ?? []).map((b) => b?.text ?? "");
    const path = parts.map(pathIn).find(Boolean);
    return { text: path ? `Saved ${path} and opened it.` : "Done." };
  }
  // The user's own words: not the workspace note, which quotes the open file.
  const text = textOf(turn?.content).replace(/<workspace>[\s\S]*?<\/workspace>/g, "");
  const write = (request.tools ?? []).find((tool) => /(^|__)writeWorkspaceFile$/.test(tool.name));
  if (write && text.includes("artifacts/")) return { tool: { name: write.name, input: ARTIFACT } };
  if (text.includes(TLDR_MARKER)) return { text: TLDR };
  return { text: REPLY };
}

function stream(res, request) {
  const { text, tool } = answer(request);
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
  const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  send("message_start", {
    message: {
      id: `msg_${randomUUID().replace(/-/g, "")}`,
      type: "message",
      role: "assistant",
      model: request.model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 100, output_tokens: 1 },
    },
  });
  if (tool) {
    send("content_block_start", {
      index: 0,
      content_block: { type: "tool_use", id: `toolu_${randomUUID().replace(/-/g, "")}`, name: tool.name, input: {} },
    });
    send("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(tool.input) } });
  } else {
    send("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
    for (const word of text.split(/(?<= )/)) send("content_block_delta", { index: 0, delta: { type: "text_delta", text: word } });
  }
  send("content_block_stop", { index: 0 });
  send("message_delta", { delta: { stop_reason: tool ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 20 } });
  send("message_stop", {});
  res.end();
}

const json = (res, status, body) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url ?? "/", "http://localhost");
  if (req.method === "GET" && pathname === "/health") return json(res, 200, { status: "ok" });
  if (req.method === "GET" && pathname === "/last-request") return json(res, 200, lastRequest);
  if (req.method !== "POST" || !pathname.startsWith("/v1/messages")) {
    return json(res, 404, { type: "error", error: { type: "not_found_error", message: `No ${req.method} ${pathname}` } });
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  let request;
  try {
    request = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
  } catch {
    return json(res, 400, { type: "error", error: { type: "invalid_request_error", message: "Not JSON" } });
  }
  if (pathname === "/v1/messages/count_tokens") return json(res, 200, { input_tokens: 100 });
  // Claude Code also makes side requests without tools (titles and the like).
  if (request.tools?.length) lastRequest = request;
  if (request.stream === false) {
    const { text } = answer(request);
    return json(res, 200, {
      id: `msg_${randomUUID().replace(/-/g, "")}`,
      type: "message",
      role: "assistant",
      model: request.model,
      content: [{ type: "text", text: text ?? "" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 100, output_tokens: 20 },
    });
  }
  stream(res, request);
});

server.listen(PORT, () => {
  console.log(`Mock Anthropic API listening on http://localhost:${PORT}`);
});
