import { test, expect } from "@playwright/test";
import type { Message } from "@ag-ui/client";
import {
  StepTimes,
  countSteps,
  currentActivity,
  formatDuration,
  groupSteps,
  humanize,
  readStepsMode,
  stepIds,
  stepLabel,
  stepsModeFrom,
  stepsSummary,
  writeStepsMode,
  STEPS_MODE_KEY,
} from "../../src/components/workspace/agent-steps";

const user = (id: string, content = "hi"): Message => ({ id, role: "user", content });
const text = (id: string, content: string): Message => ({ id, role: "assistant", content });
const thought = (id: string, content = "hmm"): Message => ({ id, role: "reasoning", content });
const calls = (id: string, names: [string, string, object?][], content?: string): Message => ({
  id,
  role: "assistant",
  ...(content ? { content } : {}),
  toolCalls: names.map(([callId, name, args]) => ({ id: callId, type: "function", function: { name, arguments: JSON.stringify(args ?? {}) } })),
});
const result = (id: string, toolCallId: string): Message => ({ id, role: "tool", toolCallId, content: "ok" });

/** The rows as ids: a message's id, or [the ids in a block]. */
const shape = (messages: Message[], running = false) =>
  groupSteps(messages, running).map((row) => (row.type === "message" ? row.message.id : row.messages.map((m) => m.id)));

test("a turn's thinking, tool calls and narration fold into one block before the answer", () => {
  const turn = [
    user("u1"),
    thought("r1"),
    calls("a1", [["c1", "mcp__copilotkit__read_file", { path: "notes/x.md" }]], "Let me read the file."),
    result("t1", "c1"),
    thought("r2"),
    calls("a2", [["c2", "mcp__copilotkit__search_files"], ["c3", "mcp__copilotkit__memory_search"]]),
    result("t2", "c2"),
    result("t3", "c3"),
    text("a3", "Your notes say …"),
  ];
  expect(shape(turn)).toEqual(["u1", ["r1", "a1", "t1", "r2", "a2", "t2", "t3"], "a3"]);
  const block = groupSteps(turn, false)[1];
  expect(block).toMatchObject({ type: "steps", key: "steps-r1" });
});

test("a turn without thinking or tools has no block", () => {
  expect(shape([user("u1"), text("a1", "Hello"), user("u2"), text("a2", "Again")])).toEqual(["u1", "a1", "u2", "a2"]);
});

test("each turn gets its own block", () => {
  const chat = [
    user("u1"), calls("a1", [["c1", "read_file"]]), result("t1", "c1"), text("a2", "One"),
    user("u2"), thought("r1"), text("a3", "Two"),
  ];
  expect(shape(chat)).toEqual(["u1", ["a1", "t1"], "a2", "u2", ["r1"], "a3"]);
});

test("while running, narration with a tool call folds in; when done the last text is the answer", () => {
  const live = [user("u1"), calls("a1", [["c1", "read_file"]], "Let me read the file.")];
  expect(shape(live, true)).toEqual(["u1", ["a1"]]);
  // A message whose text came with its tool calls is the answer once the run is over.
  expect(shape(live, false)).toEqual(["u1", "a1"]);
  // Text still streaming, before any tool: shown as the answer so far.
  expect(shape([user("u1"), thought("r1"), text("a1", "Let me")], true)).toEqual(["u1", ["r1"], "a1"]);
  // Only an earlier turn is never running.
  expect(shape([user("u1"), calls("a1", [["c1", "x"]], "Done"), result("t1", "c1"), user("u2")], true)).toEqual([
    "u1", "a1", "t1", "u2",
  ]);
});

test("a turn still thinking, with no answer yet, is all block", () => {
  expect(shape([user("u1"), thought("r1"), calls("a1", [["c1", "read_file"]])], true)).toEqual(["u1", ["r1", "a1"]]);
});

test("the answer's own tool results stay after it, and outcomes stay in the block", () => {
  const turn = [
    user("u1"),
    calls("a1", [["c1", "mcp__papers__search_papers", { query: "rag" }]]),
    result("t1", "c1"),
    { id: "act1", role: "activity", activityType: "a2ui", content: {} } as Message,
    calls("a2", [["c2", "openWorkspaceFile"]], "Here is the summary."),
    result("t2", "c2"),
  ];
  expect(shape(turn)).toEqual(["u1", ["a1", "t1", "act1"], "a2", "t2"]);
});

test("counts steps and lists the ids that time them", () => {
  const block = [thought("r1"), calls("a1", [["c1", "x"], ["c2", "y"]]), result("t1", "c1")];
  expect(countSteps(block)).toEqual({ tools: 2, thoughts: 1, total: 3 });
  expect(stepIds(block)).toEqual(["r1", "a1", "c1", "c2", "t1"]);
});

test("the live status line names the step under way", () => {
  expect(currentActivity([thought("r1")])).toBe("Thinking…");
  const reading = [calls("a1", [["c1", "mcp__copilotkit__read_file", { path: "notes/x.md" }]])];
  expect(currentActivity(reading)).toBe("Reading notes/x.md…");
  // Its result is in: Claude is thinking about the next step.
  expect(currentActivity([...reading, result("t1", "c1")])).toBe("Thinking…");
  expect(currentActivity([calls("a1", [["c1", "mcp__papers__search_papers", { query: "retrieval augmented generation" }]])])).toBe(
    "Searching papers for “retrieval augmented generation”…",
  );
});

test("step labels in plain words, from any server", () => {
  expect(stepLabel("mcp__copilotkit__edit_file", { path: "a.md" }, "done")).toBe("Edited a.md");
  expect(stepLabel("mcp__lab__search_papers", { query: "x" }, "running")).toBe("Searching papers for “x”");
  expect(stepLabel("Skill", { skill: "analysis" }, "done")).toBe("Used the analysis skill");
  expect(stepLabel("writeWorkspaceFile", { path: "artifacts/s.md" }, "running")).toBe("Writing artifacts/s.md");
  expect(stepLabel("mcp__lab__fit_model", {}, "running")).toBe("Using fit model");
  expect(stepLabel("listThings", {}, "done")).toBe("Used list things");
  expect(stepLabel("read_file", { path: "x".repeat(80) }, "done")).toMatch(/^Read x+…$/);
  expect(humanize("search_papers")).toBe("search papers");
  expect(humanize("listWorkspaceFiles")).toBe("list workspace files");
});

test("the block's summary", () => {
  const block = [thought("r1"), calls("a1", [["c1", "x"], ["c2", "y"]])];
  expect(stepsSummary(block, 14_200)).toBe("Worked for 14s · 3 steps");
  expect(stepsSummary(block, null)).toBe("3 steps");
  expect(stepsSummary([calls("a1", [["c1", "x"]])], 900)).toBe("Worked for 1s · 1 step");
  expect(stepsSummary([thought("r1")], 4_000)).toBe("Thought for 4s");
  expect(stepsSummary([thought("r1")], null)).toBe("Thought it through");
  expect(formatDuration(125_000)).toBe("2m 5s");
  expect(formatDuration(120_000)).toBe("2m");
});

test("step times: from the run's start to the block's last event, by the events' own clock", () => {
  const times = new StepTimes();
  times.record({ type: "RUN_STARTED", timestamp: 1_000 }, 50_000);
  times.record({ type: "REASONING_MESSAGE_START", messageId: "r1", timestamp: 1_500 });
  times.record({ type: "REASONING_MESSAGE_END", messageId: "r1", timestamp: 4_000 });
  times.record({ type: "TOOL_CALL_START", toolCallId: "c1", parentMessageId: "a1", timestamp: 4_100 });
  times.record({ type: "TOOL_CALL_RESULT", toolCallId: "c1", messageId: "t1", timestamp: 9_000 });
  times.record({ type: "TEXT_MESSAGE_START", messageId: "a2", timestamp: 9_500 });
  times.record({ type: "RUN_FINISHED", timestamp: 12_000 });
  expect(times.duration(["r1", "a1", "c1", "t1"])).toBe(8_000);
  expect(times.duration(["r1"])).toBe(3_000);
  // One step's own time: thinking after a tool call isn't timed from the run's start.
  times.record({ type: "REASONING_MESSAGE_START", messageId: "r2", timestamp: 9_100 });
  times.record({ type: "REASONING_MESSAGE_END", messageId: "r2", timestamp: 9_400 });
  expect(times.span(["r2"])).toBe(300);
  expect(times.span(["r1"])).toBe(2_500);
  expect(times.span(["unknown"])).toBeNull();
  expect(times.duration(["unknown"])).toBeNull();
  // The live timer counts from when this browser saw the run start.
  expect(times.liveStart(["r1"])).toBe(50_000);

  // A second run: its block is timed from its own start.
  times.record({ type: "RUN_STARTED", timestamp: 20_000 }, 60_000);
  times.record({ type: "TOOL_CALL_START", toolCallId: "c9", parentMessageId: "a9", timestamp: 21_000 });
  times.record({ type: "TOOL_CALL_END", toolCallId: "c9", timestamp: 26_000 });
  expect(times.duration(["a9", "c9"])).toBe(6_000);
});

test("step times tell listeners when a run starts or ends", () => {
  const times = new StepTimes();
  let calls = 0;
  const off = times.subscribe(() => calls++);
  const before = times.snapshot();
  times.record({ type: "RUN_STARTED" });
  times.record({ type: "TEXT_MESSAGE_CONTENT", messageId: "m" });
  times.record({ type: "RUN_FINISHED" });
  expect(calls).toBe(2);
  expect(times.snapshot()).toBe(before + 2);
  off();
});

test("the steps mode: the user's choice, else CHAT_STEPS", () => {
  expect(stepsModeFrom("Detailed")).toBe("detailed");
  expect(stepsModeFrom("compact")).toBe("compact");
  expect(stepsModeFrom(undefined)).toBe("compact");
  expect(stepsModeFrom("verbose")).toBe("compact");

  const data: Record<string, string> = {};
  const storage = { getItem: (k: string) => data[k] ?? null, setItem: (k: string, v: string) => void (data[k] = v) };
  expect(readStepsMode(storage, "detailed")).toBe("detailed");
  writeStepsMode(storage, "compact");
  expect(data[STEPS_MODE_KEY]).toBe("compact");
  expect(readStepsMode(storage, "detailed")).toBe("compact");
  data[STEPS_MODE_KEY] = "junk";
  expect(readStepsMode(storage, "detailed")).toBe("detailed");
  const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
  expect(readStepsMode(broken, "compact")).toBe("compact");
  expect(() => writeStepsMode(broken, "detailed")).not.toThrow();
});
