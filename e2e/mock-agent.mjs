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
 *
 * A message asking what to "read next" gets an answer that cites workspace
 * lines, so the preview also shows file references opening the middle pane.
 *
 * A message asking for the "rules" calls the runAction tool (generate-rules),
 * and one naming the "litho" run calls focusRun, so the preview shows Claude
 * driving the workbench too.
 *
 * A message starting with "/<skill>" runs that skill: the run reports it with
 * a "skill_used" event (as the real agent does), so the preview shows the
 * skills status bar. Without STORAGE_URL, /skills answers with the built-in
 * skills and keeps their modes in memory.
 *
 * With STORAGE_URL set (the real agent server, run with DATABASE_URL), the
 * storage routes /files, /nodes, /access, /experiments, /search, /proposals,
 * /skills and /hub are forwarded there, so the preview can show server storage and the knowledge
 * tree without an API key.
 */

import http from "node:http";
import { randomUUID } from "node:crypto";

const PORT = Number.parseInt(process.env.AGENT_PORT || "8000", 10);
const STORAGE_URL = process.env.STORAGE_URL?.replace(/\/+$/, "");

const REPLY =
  "Hi! I'm a mock agent running in CI, so this preview works without an " +
  "Anthropic API key. With a real key, Claude answers here instead.";

// File references as the system prompt asks Claude to write them
// (src/components/workspace/file-refs.ts).
const CITING_REPLY =
  "Read [The Pragmatic Programmer](notes/reading-list.md#L7) next: it's the one marked Next. " +
  "Meanwhile [sales.csv:3-4](uploads/sales.csv#L3-L4) shows revenue still climbing.";

const ARTIFACT_PATH = "artifacts/welcome-summary.md";
const ARTIFACT = `# Summary

**TL;DR:** a three-pane workspace where Claude reads and writes your files.

- Notes, skills, uploads and artifacts live on the left.
- The middle pane previews or edits the open file.
- The chat sees the open file and your selection.
`;

const TOOL_REPLIES = {
  writeWorkspaceFile: `Saved the summary to ${ARTIFACT_PATH} and opened it.`,
  runAction: "Generated the run's general rules and opened them.",
  focusRun: "Switched to the litho-2026-10-03 run.",
};

// The agent's built-in skills (agent/skills/), as GET /skills lists them.
const SKILLS = [
  {
    name: "tldr",
    description:
      "Summarize the open file (or the user's selection) as a TL;DR line plus a few bullets. Use when the user asks for a summary, gist or recap of a document.",
    argumentHint: "[what to focus on]",
    modelInvocable: true,
    defaultMode: "auto",
  },
  {
    name: "write-skill",
    description:
      "Turn a workflow from this conversation, or one the user describes, into a reusable workspace skill (skills/<name>/SKILL.md). Use when the user asks to save, capture or automate how something was done.",
    argumentHint: "[what the skill should do]",
    modelInvocable: false,
    defaultMode: "manual",
  },
].map((s) => ({ ...s, source: "builtin", path: null, userInvocable: true, needsExecution: false }));

// Modes chosen for everyone, by the (one) user, and per chat: name → mode.
const skillModes = { workspace: new Map(), user: new Map(), chat: new Map() };

/** A skill as GET /skills shows it, in a chat; the agent's precedence and clamping. */
function skillInfo(skill, thread) {
  const workspaceMode = skillModes.workspace.get(skill.name) ?? null;
  const userMode = skillModes.user.get(skill.name) ?? null;
  const chatMode = (thread && skillModes.chat.get(thread)?.get(skill.name)) ?? null;
  let mode = chatMode ?? userMode ?? workspaceMode ?? skill.defaultMode;
  if (mode === "auto" && !skill.modelInvocable) mode = "manual";
  return { ...skill, mode, workspaceMode, userMode, chatMode };
}

const SKILL_REPLY =
  "**TL;DR:** RF power drives etch rate; pressure and gas flow matter far less.\n\n" +
  "- RF power has the largest effect on etch rate.\n- Pressure is a distant second.\n- Gas flow barely moves it.";

async function handleSkills(req, res, url) {
  const name = decodeURIComponent(url.pathname.slice("/skills".length).replace(/^\/+/, ""));
  const json = (body) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (req.method === "GET" && !name) {
    const thread = url.searchParams.get("thread");
    return json({ skills: SKILLS.map((s) => skillInfo(s, thread)), canSetDefaults: true });
  }
  const skill = SKILLS.find((s) => s.name === name);
  if (req.method === "PUT" && skill) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const { mode, scope = "user", thread } = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
    let map = skillModes[scope];
    if (scope === "chat") {
      if (!skillModes.chat.has(thread)) skillModes.chat.set(thread, new Map());
      map = skillModes.chat.get(thread);
    }
    if (mode === null) map.delete(name);
    else map.set(name, mode);
    return json(skillInfo(skill, scope === "chat" ? thread : null));
  }
  res.writeHead(404).end();
}

const textOf = (message) =>
  typeof message?.content === "string"
    ? message.content
    : (message?.content ?? []).map((part) => part.text ?? "").join("");

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const { pathname } = url;

  if (req.method === "GET" && pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", mock: true }));
    return;
  }

  if (STORAGE_URL && /^\/(files|nodes|access|experiments|search|proposals|skills|hub)(\/|$)/.test(pathname)) {
    forward(req, res);
    return;
  }

  if (pathname === "/skills" || pathname.startsWith("/skills/")) {
    await handleSkills(req, res, url);
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
  const asked = last?.role === "user" ? textOf(last) : "";
  // The frontend tool to call for this message, if any.
  const toolCall = asked.includes("artifacts/")
    ? { name: "writeWorkspaceFile", args: { path: ARTIFACT_PATH, content: ARTIFACT } }
    : asked.includes("rules")
      ? { name: "runAction", args: { id: "generate-rules" } }
      : asked.includes("litho")
        ? { name: "focusRun", args: { path: "runs/litho-2026-10-03" } }
        : null;
  // After a tool ran, one line about the tool that was called.
  const calledTool = messages
    .filter((m) => m.role === "assistant")
    .flatMap((m) => m.toolCalls ?? [])
    .pop()?.function?.name;
  // "/<name> ..." runs that skill, as the agent's slash commands do, unless it is off in this chat.
  const slashName = last?.role === "user" ? /^\/([a-z0-9-]+)/.exec(asked)?.[1] : undefined;
  const slashSkill = SKILLS.find((s) => s.name === slashName && skillInfo(s, input.threadId).mode !== "off")?.name;
  const reply =
    last?.role === "tool"
      ? (TOOL_REPLIES[calledTool] ?? "Done.")
      : slashSkill
        ? SKILL_REPLY
        : asked.includes("read next")
          ? CITING_REPLY
          : REPLY;

  send({ type: "RUN_STARTED", threadId, runId });
  if (slashSkill) {
    send({ type: "CUSTOM", name: "skill_used", value: { skill: slashSkill, source: "builtin", trigger: "slash" } });
  }
  if (toolCall) {
    const toolCallId = randomUUID();
    send({
      type: "TOOL_CALL_START",
      toolCallId,
      toolCallName: toolCall.name,
      parentMessageId: messageId,
    });
    send({
      type: "TOOL_CALL_ARGS",
      toolCallId,
      delta: JSON.stringify(toolCall.args),
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

/** Streams a request to the storage server and its answer back (SSE included). */
function forward(req, res) {
  const target = new URL(req.url ?? "/", STORAGE_URL);
  const upstream = http.request(
    target,
    { method: req.method, headers: { ...req.headers, host: target.host } },
    (answer) => {
      res.writeHead(answer.statusCode ?? 502, answer.headers);
      answer.pipe(res);
    },
  );
  upstream.on("error", () => {
    if (!res.headersSent) res.writeHead(503);
    res.end();
  });
  req.pipe(upstream);
}

server.listen(PORT, () => {
  console.log(`Mock AG-UI agent listening on http://localhost:${PORT}`);
});
