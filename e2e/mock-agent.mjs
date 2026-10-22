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
 * and one asking to open a run by its id calls openRun, so the preview shows
 * Claude driving the workbench too.
 *
 * A message starting with "/<skill>" runs that skill: the run reports it with
 * a "skill_used" event (as the real agent does), so the preview shows the
 * skills status bar. Without STORAGE_URL, /skills answers with the built-in
 * skills and keeps their modes in memory.
 *
 * A message starting with "Remember" saves it as a memory note (reply-style),
 * as Claude would with its memory tools, and reports it with a "memory" event,
 * unless memory is off or the chat is incognito; with memory set to "ask" it
 * proposes the note to the inbox instead. /memory answers like the
 * agent's memory API (src/memory/http.ts) with notes kept in memory.
 *
 * `POST /suggest` answers the chat's follow-up chips with two canned ones
 * (FOLLOW_UPS), as the real agent's src/suggest.ts does with a small model.
 *
 * `POST /agent/report` answers like `POST /`, as a remote backend would
 * (AGENT_URL, docs/remote-agent.md), and `GET /last-run` returns the input of
 * the last chat run, so tests can check what the app sent.
 *
 * With STORAGE_URL set (the real agent server, run with DATABASE_URL), the
 * storage routes /files, /nodes, /access, /experiments, /search, /proposals, /chats,
 * /skills, /hub and /memory are forwarded there, so the preview can show server storage and the knowledge
 * tree without an API key.
 */

import http from "node:http";
import { randomUUID } from "node:crypto";

const PORT = Number.parseInt(process.env.AGENT_PORT || "8000", 10);
const STORAGE_URL = process.env.STORAGE_URL?.replace(/\/+$/, "");

/** The input of the last chat run, for GET /last-run. */
let lastRun = null;

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

// What POST /suggest answers after every reply.
const FOLLOW_UPS = [
  { title: "Check the evidence", message: "How strong is the evidence for that? Point me to the lines that support it." },
  { title: "Save it as a note", message: "Save what you just told me as a short note next to the report." },
];

const TOOL_REPLIES = {
  writeWorkspaceFile: `Saved the summary to ${ARTIFACT_PATH} and opened it.`,
  runAction: "Generated the run's general rules and opened them.",
  openRun: "Switched to the other run.",
};

// The agent's built-in skills (agent/skills/), as GET /skills lists them.
const SKILLS = [
  {
    name: "analysis",
    description:
      "Analyze files the user uploaded (CSV, tables, measurement logs, notes) as a run - a new experiment with the files as inputs, a written report and recorded results. Use when the user asks to analyze, evaluate or run an analysis on their data, or to rerun an earlier analysis.",
    argumentHint: "[files or question]",
    modelInvocable: true,
    defaultMode: "auto",
    needsExecution: true,
  },
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
].map((s) => ({ needsExecution: false, ...s, source: "builtin", path: null, userInvocable: true }));

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

// Memory (the agent's src/memory/http.ts, in memory): name → { note, versions }.
const memory = { mode: "on", incognito: new Set(), notes: new Map(), events: new Map(), inbox: [], activity: [] };
const MEMORY_TYPES = ["preference", "profile", "project", "reference", "feedback"];
// The list has no bodies.
const summary = (note) => ({ ...note, body: undefined });

// Shared memory (step 3): one workspace note to start with, which you edit.
const WORKSPACE = { scope: "workspace", nodeId: null, groupId: null, label: "Workspace" };
const shared = new Map();
function putShared(place, name, input, pack = null, mode = "auto") {
  const id = randomUUID();
  shared.set(id, {
    id, name, description: input.description, type: input.type ?? "reference", body: input.body ?? "", version: 1,
    place, canEdit: true, mode, myMode: null, everyoneMode: mode, pack, updatedAt: new Date().toISOString(),
  });
  return shared.get(id);
}
putShared(WORKSPACE, "lab-conventions", { description: "How the lab names runs and units", body: "Units are nm. Runs are named <tool>-<date>." });

// Memory packs (step 4): one on the hub; installing adds its notes, Manual.
const PACK_VERSION = {
  version: 1, description: "Terms the thin-film team uses, and what they mean", notes: 2, flags: [], publishedBy: "Ana",
  publishedAt: new Date().toISOString(), verified: true, yanked: false, yankReason: null,
};
const PACK_NOTES = [
  { name: "film-terms", description: "What the team means by film, stack and anneal", type: "reference", body: "A stack is the layers of one sample, bottom first. Anneal = 1 h at 400 C unless said." },
  { name: "sample-ids", description: "How samples are numbered", type: "reference", body: "Samples are TF-<year>-<n>, n from 1 each year." },
];
const packs = [{ name: "thin-film-glossary", owner: "Ana", mine: false, latest: PACK_VERSION, updatedAt: PACK_VERSION.publishedAt }];
const installs = [];

/** Saves a note as the user or Claude; returns the event for Claude's changes. */
function saveMemory(name, input, by) {
  const now = new Date().toISOString();
  const entry = memory.notes.get(name);
  const kind = !entry || entry.note.archived ? "create" : "update";
  const version = entry ? entry.note.version + 1 : 1;
  const note = {
    name, description: input.description, type: input.type ?? "preference", body: input.body ?? "",
    version, createdBy: entry?.note.createdBy ?? by, updatedBy: by, archived: false,
    createdAt: entry?.note.createdAt ?? now, updatedAt: now, lastUsedAt: entry?.note.lastUsedAt ?? null,
  };
  const versions = [{ version, description: note.description, type: note.type, body: note.body, changedBy: by, threadId: null, createdAt: now }, ...(entry?.versions ?? [])];
  memory.notes.set(name, { note, versions });
  for (const older of memory.activity) if (older.name === name) older.undoable = false;
  if (by !== "agent") return { note, event: null };
  const event = { id: randomUUID(), name, description: note.description, kind, version };
  memory.events.set(event.id, { ...event, before: entry ?? null });
  memory.activity.unshift({ id: event.id, name, kind, source: "chat", at: now, undone: false, undoable: true });
  return { note, event };
}

async function handleMemory(req, res, url) {
  const [section, name, action] = url.pathname.slice("/memory".length).split("/").filter(Boolean).map(decodeURIComponent);
  const json = (body, status = 200) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const input = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf-8")) : {};
  const entry = name ? memory.notes.get(name) : undefined;
  if (req.method === "GET" && !section) {
    const thread = url.searchParams.get("thread");
    const notes = [...memory.notes.values()].map((e) => summary(e.note));
    notes.sort((a, b) => Number(a.archived) - Number(b.archived) || b.updatedAt.localeCompare(a.updatedAt));
    return json({
      mode: memory.mode, incognito: memory.incognito.has(thread), notes, inbox: memory.inbox, types: MEMORY_TYPES,
      shared: [...shared.values()].map(summary), sharedProposals: [], targets: [{ ...WORKSPACE, canEdit: true }], installs,
    });
  }
  if (req.method === "POST" && section === "import") {
    const text = String(input.text ?? "").trim();
    if (!text) return json({ error: "Nothing to import: paste the memory or pick a file" }, 400);
    // Claude sorts each line into a note; here, one note per "- " line.
    const lines = text.split("\n").map((l) => l.replace(/^[-*]\s*/, "").trim()).filter(Boolean);
    lines.forEach((line, i) => {
      const name = i === 0 ? "work-role" : `imported-${i + 1}`;
      memory.inbox.push({
        id: randomUUID(), op: memory.notes.has(name) ? "update" : "add", name, description: line.slice(0, 80), type: "profile",
        body: line, source: "import", reason: `Imported from ${input.label ?? "another assistant"}`, createdAt: new Date().toISOString(),
      });
    });
    return json({ proposed: lines.length, skipped: 0, how: "text" });
  }
  if (section === "packs") {
    if (req.method === "GET" && !name) return json({ packs, isAdmin: false });
    const pack = packs.find((p) => p.name === name);
    if (!pack) return json({ error: `No pack ${name}` }, 404);
    if (req.method === "GET") {
      return json({ pack: { ...pack, versions: [PACK_VERSION], version: PACK_VERSION, notes: PACK_NOTES, isAdmin: false } });
    }
    if (req.method === "POST" && action === "install") {
      if (installs.some((i) => i.name === name)) return json({ install: installs.find((i) => i.name === name) });
      const install = { id: randomUUID(), name, version: 1, latest: null, place: WORKSPACE, canEdit: true, notes: PACK_NOTES.length, installedAt: new Date().toISOString() };
      installs.push(install);
      for (const note of PACK_NOTES) putShared(WORKSPACE, note.name, note, { installId: install.id, name, version: 1 }, "manual");
      return json({ install });
    }
  }
  if (section === "installs" && name) {
    const at = installs.findIndex((i) => i.id === name);
    if (at < 0) return json({ error: "No such install" }, 404);
    const [install] = installs.splice(at, 1);
    for (const [id, note] of shared) {
      if (note.pack?.installId !== install.id) continue;
      if (action === "fork") note.pack = null;
      else shared.delete(id);
    }
    return json({ id: name, deleted: true });
  }
  if (section === "shared") {
    if (req.method === "POST" && !name) {
      if ([...shared.values()].some((n) => n.name === input.name)) return json({ error: `There is already a shared note named ${input.name} there` }, 409);
      return json({ note: putShared(WORKSPACE, input.name, input), proposal: null });
    }
    const note = shared.get(name);
    if (!note) return json({ error: `No memory named shared:${name}` }, 404);
    if (req.method === "GET" && !action) {
      return json({ note, versions: [{ version: note.version, description: note.description, type: note.type, body: note.body, changedBy: "You", changedAs: "user", createdAt: note.updatedAt }] });
    }
    if (req.method === "PUT" && action === "mode") {
      if (input.everyone) note.everyoneMode = input.mode;
      else note.myMode = input.mode;
      note.mode = note.myMode ?? note.everyoneMode;
      return json({ note: summary(note) });
    }
    if (req.method === "PUT" && !action) {
      Object.assign(note, { description: input.description, type: input.type, body: input.body, version: note.version + 1 });
      return json({ note });
    }
    if (req.method === "DELETE") {
      shared.delete(name);
      return json({ id: name, deleted: true });
    }
  }
  if (req.method === "PUT" && section === "settings") {
    if (input.mode) memory.mode = input.mode;
    if (input.incognito === true) memory.incognito.add(input.thread);
    if (input.incognito === false) memory.incognito.delete(input.thread);
    return json({ mode: memory.mode, incognito: memory.incognito.has(input.thread) });
  }
  if (req.method === "GET" && section === "activity") return json({ activity: memory.activity });
  if (req.method === "POST" && section === "inbox" && (action === "accept" || action === "reject")) {
    const item = memory.inbox.find((i) => i.id === name);
    if (!item) return json({ error: "No such change in the inbox" }, 404);
    memory.inbox = memory.inbox.filter((i) => i !== item);
    if (action === "reject") return json({ id: name, status: "rejected" });
    const { note, event } = saveMemory(item.name, item, "agent");
    memory.activity[0] = { ...memory.activity[0], source: "inbox" };
    memory.events.get(event.id).source = "inbox";
    return json({ id: name, status: "accepted", note });
  }
  if (req.method === "GET" && section === "export") {
    // An empty .zip.
    res.writeHead(200, { "Content-Type": "application/zip" });
    return res.end(Buffer.from([0x50, 0x4b, 5, 6, ...new Array(18).fill(0)]));
  }
  if (section === "notes" && name && !action) {
    if (req.method === "GET") return entry ? json({ note: entry.note, versions: entry.versions }) : json({ error: `No memory named ${name}` }, 404);
    if (req.method === "PUT") {
      if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) return json({ error: "A memory's name is lowercase letters, digits and dashes" }, 400);
      if (!input.description?.trim()) return json({ error: "A memory needs a one-line description" }, 400);
      return json({ note: saveMemory(name, input, "user").note });
    }
    if (req.method === "DELETE") return memory.notes.delete(name) ? json({ name, deleted: true }) : json({ error: "Not found" }, 404);
  }
  if (req.method === "POST" && section === "notes" && entry && action === "archive") {
    entry.note = { ...entry.note, archived: input.archived !== false };
    return json({ note: entry.note });
  }
  if (req.method === "POST" && section === "notes" && entry && action === "restore") {
    const old = entry.versions.find((v) => v.version === input.version);
    return json({ note: saveMemory(name, old, "user").note });
  }
  if (req.method === "POST" && section === "events" && action === "undo") {
    const event = memory.events.get(name);
    if (!event || event.undone) return json({ error: "Nothing to undo" }, 409);
    event.undone = true;
    const listed = memory.activity.find((a) => a.id === event.id);
    if (listed) Object.assign(listed, { undone: true, undoable: false });
    if (event.before) memory.notes.set(event.name, event.before);
    else memory.notes.delete(event.name);
    return json({ name: event.name, note: memory.notes.get(event.name)?.note ?? null });
  }
  json({ error: "Not found" }, 404);
}

const REMEMBER_REPLY = "Got it: I'll keep that in mind in your future chats.";

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

  if (STORAGE_URL && /^\/(files|nodes|access|experiments|search|proposals|chats|skills|hub|memory)(\/|$)/.test(pathname)) {
    forward(req, res);
    return;
  }

  if (pathname === "/memory" || pathname.startsWith("/memory/")) {
    await handleMemory(req, res, url);
    return;
  }

  if (pathname === "/skills" || pathname.startsWith("/skills/")) {
    await handleSkills(req, res, url);
    return;
  }

  if (req.method === "GET" && pathname === "/last-run") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(lastRun));
    return;
  }

  if (req.method !== "POST" || (pathname !== "/" && pathname !== "/agent/report" && pathname !== "/suggest")) {
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

  if (pathname === "/suggest") {
    // Canned follow-up chips, as the real agent's small-model call returns them.
    const toolCallId = randomUUID();
    send({ type: "RUN_STARTED", threadId, runId });
    send({ type: "TOOL_CALL_START", toolCallId, toolCallName: "copilotkitSuggest", parentMessageId: messageId });
    send({ type: "TOOL_CALL_ARGS", toolCallId, delta: JSON.stringify({ suggestions: FOLLOW_UPS }) });
    send({ type: "TOOL_CALL_END", toolCallId });
    send({ type: "RUN_FINISHED", threadId, runId });
    res.end();
    return;
  }

  lastRun = input;
  const messages = input.messages ?? [];
  const last = messages[messages.length - 1];
  const asked = last?.role === "user" ? textOf(last) : "";
  // The frontend tool to call for this message, if any.
  const toolCall = asked.includes("artifacts/")
    ? { name: "writeWorkspaceFile", args: { path: ARTIFACT_PATH, content: ARTIFACT } }
    : asked.includes("rules")
      ? { name: "runAction", args: { id: "generate-rules" } }
      : /open the run [0-9a-f-]{36}/.test(asked)
        ? { name: "openRun", args: { id: /[0-9a-f-]{36}/.exec(asked)[0] } }
        : null;
  // After a tool ran, one line about the tool that was called.
  const calledTool = messages
    .filter((m) => m.role === "assistant")
    .flatMap((m) => m.toolCalls ?? [])
    .pop()?.function?.name;
  // "/<name> ..." runs that skill, as the agent's slash commands do, unless it is off in this chat.
  const slashName = last?.role === "user" ? /^\/([a-z0-9-]+)/.exec(asked)?.[1] : undefined;
  const slashSkill = SKILLS.find((s) => s.name === slashName && skillInfo(s, input.threadId).mode !== "off")?.name;
  // "Remember …" saves a note, where memory is on for this chat.
  const remember =
    last?.role === "user" && /^remember\b/i.test(asked) && memory.mode !== "off" && !memory.incognito.has(input.threadId);
  const reply =
    last?.role === "tool"
      ? (TOOL_REPLIES[calledTool] ?? "Done.")
      : slashSkill
        ? SKILL_REPLY
        : asked.includes("read next")
          ? CITING_REPLY
          : remember
            ? REMEMBER_REPLY
            : REPLY;

  send({ type: "RUN_STARTED", threadId, runId });
  if (slashSkill) {
    send({ type: "CUSTOM", name: "skill_used", value: { skill: slashSkill, source: "builtin", trigger: "slash" } });
  }
  if (remember && memory.mode === "ask") {
    const item = {
      id: randomUUID(), op: memory.notes.has("reply-style") ? "update" : "add", name: "reply-style",
      description: "Prefers short answers that lead with the result", type: "preference",
      body: asked.replace(/^remember( that)?\s*/i, ""), source: "chat", reason: null, createdAt: new Date().toISOString(),
    };
    memory.inbox.push(item);
    send({ type: "CUSTOM", name: "memory", value: { id: item.id, name: item.name, description: item.description, kind: "propose", version: 0 } });
  } else if (remember) {
    const { event } = saveMemory(
      "reply-style",
      { description: "Prefers short answers that lead with the result", type: "preference", body: asked.replace(/^remember( that)?\s*/i, "") },
      "agent",
    );
    send({ type: "CUSTOM", name: "memory", value: { id: event.id, name: event.name, description: event.description, kind: event.kind, version: event.version } });
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
