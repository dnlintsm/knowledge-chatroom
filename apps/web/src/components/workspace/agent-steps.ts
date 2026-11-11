import type { Message } from "@ag-ui/client";
import { splitToolName } from "./tool-chips";

/**
 * Collapsed agent steps (issue #154): each turn's thinking and tool calls fold
 * into one "Worked for 14s · 5 steps" block, and the answer stays below it.
 * Pure functions so they are unit-tested; the React side is
 * agent-steps-view.tsx.
 */

/** One row of the chat: a message on its own, or a turn's steps folded into a block. */
export type StepRow =
  | { type: "message"; message: Message }
  | { type: "steps"; key: string; messages: Message[] };

const hasText = (m: Message) => m.role === "assistant" && typeof m.content === "string" && m.content.trim().length > 0;
const toolCallsOf = (m: Message) => (m.role === "assistant" ? (m.toolCalls ?? []) : []);
const isStep = (m: Message) => m.role === "reasoning" || toolCallsOf(m).length > 0;

/**
 * The chat's rows. A turn is what follows a user message. Its answer is the
 * last assistant message with text; everything before it that is thinking, a
 * tool call, a tool result or narration ("Let me read the file") goes into
 * one steps block, placed where the turn's first step was. While the turn is
 * still running, text with tool calls is narration rather than the answer,
 * so it folds in as soon as Claude starts a tool. A turn without thinking or
 * tool calls has no block. Outcomes inside a block (paper cards, charts,
 * A2UI, anything waiting for the user) still show when it is collapsed;
 * that is up to their renderers, see agent-steps-view.tsx.
 */
export function groupSteps(messages: Message[], running: boolean): StepRow[] {
  const rows: StepRow[] = [];
  let turn: Message[] = [];
  const flush = (last: boolean) => {
    if (turn.length) rows.push(...groupTurn(turn, running && last));
    turn = [];
  };
  for (const message of messages) {
    if (message.role === "user") {
      flush(false);
      rows.push({ type: "message", message });
    } else {
      turn.push(message);
    }
  }
  flush(true);
  return rows;
}

function groupTurn(turn: Message[], running: boolean): StepRow[] {
  let answer = -1;
  for (let i = turn.length - 1; i >= 0; i--) {
    if (!hasText(turn[i])) continue;
    if (running && toolCallsOf(turn[i]).length > 0) continue;
    answer = i;
    break;
  }
  const before = answer < 0 ? turn : turn.slice(0, answer);
  const after = answer < 0 ? [] : turn.slice(answer);
  // Only the steps' kinds fold; anything else (system notes, say) keeps its own row.
  const folds = (m: Message) => m.role === "reasoning" || m.role === "tool" || m.role === "assistant" || m.role === "activity";
  if (!before.some(isStep)) return turn.map((message) => ({ type: "message", message }));
  const steps = before.filter(folds);
  const rows: StepRow[] = [];
  let placed = false;
  for (const message of before) {
    if (folds(message)) {
      if (!placed) rows.push({ type: "steps", key: `steps-${message.id}`, messages: steps });
      placed = true;
    } else {
      rows.push({ type: "message", message });
    }
  }
  for (const message of after) rows.push({ type: "message", message });
  return rows;
}

/** How many steps a block holds: tool calls and thinking blocks. */
export function countSteps(messages: Message[]): { tools: number; thoughts: number; total: number } {
  const tools = messages.reduce((n, m) => n + toolCallsOf(m).length, 0);
  const thoughts = messages.filter((m) => m.role === "reasoning").length;
  return { tools, thoughts, total: tools + thoughts };
}

/** The ids whose events time a block: its messages and their tool calls. */
export function stepIds(messages: Message[]): string[] {
  return messages.flatMap((m) => [m.id, ...toolCallsOf(m).map((c) => c.id)]);
}

export function parseArgs(args: unknown): Record<string, unknown> {
  if (typeof args === "string") {
    try {
      const parsed = JSON.parse(args) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return args && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
}

/** What the block's header says while it runs: the step under way. */
export function currentActivity(messages: Message[]): string {
  const done = new Set(messages.flatMap((m) => (m.role === "tool" ? [m.toolCallId] : [])));
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "reasoning") return "Thinking…";
    const calls = toolCallsOf(m);
    const pending = [...calls].reverse().find((c) => !done.has(c.id));
    if (pending) return `${stepLabel(pending.function.name, parseArgs(pending.function.arguments), "running")}…`;
    if (calls.length) break;
  }
  return "Thinking…";
}

const short = (value: unknown, max = 48) => {
  if (typeof value !== "string" || !value.trim()) return "";
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
};
const quoted = (value: unknown) => (short(value) ? ` for “${short(value)}”` : "");
const host = (value: unknown) => {
  try {
    return typeof value === "string" ? new URL(value).host : "";
  } catch {
    return "";
  }
};

type Verb = [running: string, done: string];
/** [while running, once done], with what the arguments add. */
const LABELS: Record<string, (args: Record<string, unknown>) => Verb> = {
  // The agent's storage and memory tools (apps/agent/src/storage/tools.ts, apps/agent/src/memory).
  read_file: (a) => [`Reading ${short(a.path) || "a file"}`, `Read ${short(a.path) || "a file"}`],
  write_file: (a) => [`Writing ${short(a.path) || "a file"}`, `Wrote ${short(a.path) || "a file"}`],
  save_file: (a) => [`Saving ${short(a.path) || "a file"}`, `Saved ${short(a.path) || "a file"}`],
  edit_file: (a) => [`Editing ${short(a.path) || "a file"}`, `Edited ${short(a.path) || "a file"}`],
  list_files: () => ["Listing files", "Listed files"],
  search_files: (a) => [`Searching your files${quoted(a.query)}`, `Searched your files${quoted(a.query)}`],
  list_nodes: () => ["Looking at the knowledge tree", "Looked at the knowledge tree"],
  create_node: (a) => [`Creating ${short(a.name) || "a node"}`, `Created ${short(a.name) || "a node"}`],
  memory_search: (a) => [`Checking memory${quoted(a.query)}`, `Checked memory${quoted(a.query)}`],
  memory_view: () => ["Checking memory", "Checked memory"],
  memory_save: () => ["Saving to memory", "Saved to memory"],
  memory_edit: () => ["Updating memory", "Updated memory"],
  memory_delete: () => ["Forgetting a note", "Forgot a note"],
  chats_search: (a) => [`Looking through past chats${quoted(a.query)}`, `Looked through past chats${quoted(a.query)}`],
  chats_read: () => ["Reading a past chat", "Read a past chat"],
  list_experiments: () => ["Looking at experiments", "Looked at experiments"],
  create_experiment: () => ["Setting up an experiment", "Set up an experiment"],
  propose_experiment: () => ["Proposing an experiment", "Proposed an experiment"],
  update_experiment: () => ["Updating the experiment", "Updated the experiment"],
  set_experiment_results: () => ["Recording the experiment's results", "Recorded the experiment's results"],
  // Paper search (services/papers-mcp).
  search_papers: (a) => [`Searching papers${quoted(a.query)}`, `Searched papers${quoted(a.query)}`],
  related_papers: () => ["Finding related papers", "Found related papers"],
  get_paper: () => ["Looking up a paper", "Looked up a paper"],
  save_paper: () => ["Saving a paper", "Saved a paper"],
  // Claude Code's own tools.
  Skill: (a) => [`Using the ${short(a.skill) || "a"} skill`, `Used the ${short(a.skill) || "a"} skill`],
  Bash: () => ["Running a command", "Ran a command"],
  Read: (a) => [`Reading ${short(a.file_path) || "a file"}`, `Read ${short(a.file_path) || "a file"}`],
  Write: (a) => [`Writing ${short(a.file_path) || "a file"}`, `Wrote ${short(a.file_path) || "a file"}`],
  Edit: (a) => [`Editing ${short(a.file_path) || "a file"}`, `Edited ${short(a.file_path) || "a file"}`],
  Grep: (a) => [`Searching${quoted(a.pattern)}`, `Searched${quoted(a.pattern)}`],
  Glob: () => ["Finding files", "Found files"],
  WebSearch: (a) => [`Searching the web${quoted(a.query)}`, `Searched the web${quoted(a.query)}`],
  WebFetch: (a) => [`Reading ${host(a.url) || "a web page"}`, `Read ${host(a.url) || "a web page"}`],
  TodoWrite: () => ["Planning", "Planned"],
  // The browser's tools (agent-bridge.tsx).
  listWorkspaceFiles: () => ["Listing files", "Listed files"],
  readWorkspaceFile: (a) => [`Reading ${short(a.path) || "a file"}`, `Read ${short(a.path) || "a file"}`],
  writeWorkspaceFile: (a) => [`Writing ${short(a.path) || "a file"}`, `Wrote ${short(a.path) || "a file"}`],
  editWorkspaceFile: (a) => [`Editing ${short(a.path) || "a file"}`, `Edited ${short(a.path) || "a file"}`],
  openWorkspaceFile: (a) => [`Opening ${short(a.path) || "a file"}`, `Opened ${short(a.path) || "a file"}`],
  openTaskBoard: () => ["Opening the task board", "Opened the task board"],
  showPane: () => ["Showing a pane", "Showed a pane"],
  hidePane: () => ["Hiding a pane", "Hid a pane"],
  // listRuns and openRun keep their names (saved chats call them by name);
  // only what the user reads changed when "run" became "experiment" (#185).
  listRuns: () => ["Looking at experiments", "Looked at experiments"],
  openRun: () => ["Opening an experiment", "Opened an experiment"],
  listActions: () => ["Looking at actions", "Looked at actions"],
  runAction: (a) => [`Running ${short(a.id) || "an action"}`, `Ran ${short(a.id) || "an action"}`],
};

/** "search_papers" or "listWorkspaceFiles" as words: "search papers", "list workspace files". */
export function humanize(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * A step's label in plain words, from the tool's name and arguments, e.g.
 * "Reading notes/x.md" while it runs and "Read notes/x.md" once done.
 * Outside servers' tools (mcp__<server>__<tool>) are named by their tool.
 */
export function stepLabel(name: string, args: Record<string, unknown>, state: "running" | "done"): string {
  const tool = splitToolName(name)?.tool ?? name;
  const verb = LABELS[tool]?.(args);
  if (verb) return state === "running" ? verb[0] : verb[1];
  return `${state === "running" ? "Using" : "Used"} ${humanize(tool) || "a tool"}`;
}

/** "14s", "2m 5s": how long the steps took. */
export function formatDuration(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s ? `${m}m ${s}s` : `${m}m`;
}

/** The block's header once the turn is done, e.g. "Worked for 14s · 5 steps". */
export function stepsSummary(messages: Message[], ms: number | null): string {
  const { tools, total } = countSteps(messages);
  const time = ms !== null && ms > 0 ? formatDuration(ms) : null;
  if (tools === 0) return time ? `Thought for ${time}` : "Thought it through";
  const steps = `${total} step${total === 1 ? "" : "s"}`;
  return time ? `Worked for ${time} · ${steps}` : steps;
}

/**
 * When each step happened, from the run's AG-UI events. The chat runner
 * stamps every event with the server's time before it streams or saves it
 * (src/lib/chat-runner.ts), so a chat reopened from the history still knows
 * how long its steps took. Events without a time use the browser's clock.
 */
export class StepTimes {
  /** id (message or tool call) → first and last event time. */
  private readonly seen = new Map<string, { first: number; last: number }>();
  /** Each run's start: its event time, and when this browser saw it. */
  private readonly starts: { at: number; local: number }[] = [];
  private version = 0;
  private readonly listeners = new Set<() => void>();

  record(event: { type: string; timestamp?: number; [key: string]: unknown }, now = Date.now()) {
    const at = typeof event.timestamp === "number" ? event.timestamp : now;
    if (event.type === "RUN_STARTED") {
      this.starts.push({ at, local: now });
      this.starts.sort((a, b) => a.at - b.at);
      this.changed();
      return;
    }
    for (const key of ["messageId", "toolCallId", "parentMessageId"] as const) {
      const id = event[key];
      if (typeof id !== "string") continue;
      const times = this.seen.get(id);
      this.seen.set(id, times ? { first: Math.min(times.first, at), last: Math.max(times.last, at) } : { first: at, last: at });
    }
    if (event.type === "RUN_FINISHED" || event.type === "RUN_ERROR") this.changed();
  }

  /** The run start a block belongs to: the latest one at or before its first event. */
  private start(ids: string[]) {
    const firsts = ids.flatMap((id) => (this.seen.has(id) ? [this.seen.get(id)!.first] : []));
    if (!firsts.length) return null;
    const first = Math.min(...firsts);
    const last = Math.max(...ids.flatMap((id) => (this.seen.has(id) ? [this.seen.get(id)!.last] : [])));
    const start = [...this.starts].reverse().find((s) => s.at <= first) ?? null;
    return { start, first, last };
  }

  /** How long the block's steps took: from its run's start (else its first event) to its last event. */
  duration(ids: string[]): number | null {
    const span = this.start(ids);
    if (!span) return null;
    return span.last - (span.start?.at ?? span.first);
  }

  /** How long one step took on its own: from its first event to its last, e.g. a thinking block. */
  span(ids: string[]): number | null {
    const span = this.start(ids);
    return span ? span.last - span.first : null;
  }

  /** When, by this browser's clock, the block's run started: for the live timer. */
  liveStart(ids: string[]): number | null {
    return this.start(ids)?.start?.local ?? null;
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  snapshot = () => this.version;

  private changed() {
    this.version++;
    for (const listener of this.listeners) listener();
  }
}

/** How much of the steps the chat shows: folded (default) or open with each tool's arguments. */
export type StepsMode = "compact" | "detailed";
export const STEPS_MODE_KEY = "knowledge-chatroom.chat.steps-mode.v1";

/** CHAT_STEPS as the server read it; anything but "detailed" is compact. */
export function stepsModeFrom(value: string | undefined | null): StepsMode {
  return value?.trim().toLowerCase() === "detailed" ? "detailed" : "compact";
}

type BrowserStorage = Pick<Storage, "getItem" | "setItem">;

/** This user's choice, else the deployment's default. */
export function readStepsMode(storage: BrowserStorage | null, fallback: StepsMode): StepsMode {
  try {
    const saved = storage?.getItem(STEPS_MODE_KEY);
    return saved === "compact" || saved === "detailed" ? saved : fallback;
  } catch {
    return fallback;
  }
}

export function writeStepsMode(storage: BrowserStorage | null, mode: StepsMode) {
  try {
    storage?.setItem(STEPS_MODE_KEY, mode);
  } catch {
    // Private mode or a full store: the choice lasts until reload.
  }
}
