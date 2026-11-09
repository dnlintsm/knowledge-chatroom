import assert from "node:assert/strict";
import { test } from "node:test";

import { ClaudeAgentAdapter } from "@ag-ui/claude-agent-sdk";
import { AbstractAgent, EventType, type BaseEvent } from "@ag-ui/client";
import type { RunAgentInput } from "@ag-ui/core";
import { Observable } from "rxjs";

// The agent only adds workspace file tools when storage is configured.
process.env.DATABASE_URL ||= process.env.TEST_DATABASE_URL || "postgres://localhost/unused";
process.env.MCP_SERVERS = JSON.stringify({ lab: { url: "http://lab/mcp", forwardIdentity: true } });
const { adapter, runAs } = await import("./agent");

const input = {
  threadId: "t",
  runId: "r",
  messages: [],
  tools: [],
  context: [],
  state: {},
  forwardedProps: {},
} as unknown as RunAgentInput;

test("each run gets file tools for its own user", () => {
  const shared = adapter.buildOptions(input).mcpServers?.copilotkit;
  const alice = runAs("alice", () => adapter.buildOptions(input).mcpServers?.copilotkit);
  const bob = runAs("bob", () => adapter.buildOptions(input).mcpServers?.copilotkit);
  assert.ok(shared && alice && bob);
  assert.notEqual(alice, shared);
  assert.notEqual(alice, bob);
  // Outside a run the shared server stays as configured.
  assert.equal(adapter.buildOptions(input).mcpServers?.copilotkit, shared);
});

test("a run with skills gets them, the Skill tool and its own working folder", () => {
  const skills = { cwd: "/tmp/skills-run", skills: [] };
  const options = runAs("alice", () => adapter.buildOptions(input), skills);
  assert.equal(options.cwd, "/tmp/skills-run");
  assert.deepEqual(options.tools, ["Skill"]);
  assert.ok(options.allowedTools?.includes("Skill"));
  // Without skills the run keeps no built-in tools.
  assert.deepEqual(runAs("alice", () => adapter.buildOptions(input)).tools, []);
});

test("a run with a workspace copy can read it with Read, Glob and Grep, and only there", () => {
  const workdir = { dir: "/tmp/skills-run/workspace", places: [], files: 3, bytes: 10, skipped: [] };
  const options = runAs("alice", () => adapter.buildOptions(input), { cwd: "/tmp/skills-run", skills: [], workdir });
  assert.deepEqual(options.tools, ["Skill", "Read", "Glob", "Grep"]);
  for (const name of ["Read", "Glob", "Grep", "mcp__copilotkit__save_file"]) {
    assert.ok(options.allowedTools?.includes(name), name);
  }
  assert.ok(options.hooks?.PreToolUse?.some((m) => m.matcher === "Read|Glob|Grep"));
  // The Skill hook stays.
  assert.ok(options.hooks?.PreToolUse?.some((m) => m.matcher === "Skill"));
  assert.match(String(options.systemPrompt), /workspace\/\.places\.json/);
  // No copy, no save_file.
  const plain = runAs("alice", () => adapter.buildOptions(input), { cwd: "/tmp/skills-run", skills: [] });
  assert.equal(plain.allowedTools?.includes("mcp__copilotkit__save_file"), false);
});

test("outside MCP servers are pre-approved and get each run's signed user", () => {
  const shared = adapter.buildOptions(input);
  assert.ok(shared.allowedTools?.includes("mcp__lab"));
  assert.deepEqual(shared.mcpServers?.lab, { type: "http", url: "http://lab/mcp", alwaysLoad: true });
  const run = runAs("alice", () => adapter.buildOptions(input), null, () => {}, (server) => `alice-for-${server}`);
  assert.deepEqual((run.mcpServers?.lab as { headers?: object }).headers, { "x-knowledge-user": "alice-for-lab" });
  assert.ok(run.mcpServers?.copilotkit);
});

// A Claude SDK stream for one turn: a thinking block, then the answer.
async function* thinkThenAnswer(turn: number) {
  const id = `msg_${turn}`;
  const event = (e: object) => ({ type: "stream_event", event: e });
  yield event({ type: "message_start", message: { id } });
  yield event({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } });
  yield event({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: `thought ${turn}` } });
  yield event({ type: "content_block_stop", index: 0 });
  yield event({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } });
  yield event({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: `answer ${turn}` } });
  yield event({ type: "content_block_stop", index: 1 });
  yield event({ type: "message_stop" });
  yield {
    type: "assistant",
    uuid: `uuid-${turn}`,
    message: { id, content: [{ type: "thinking", thinking: `thought ${turn}`, signature: "s" }, { type: "text", text: `answer ${turn}` }] },
  };
}

test("every turn keeps its thinking block after the reply finishes (#156)", async (t) => {
  // The adapter's own event handling, fed a recorded stream instead of Claude.
  type Stream = (...args: unknown[]) => Promise<void>;
  const proto = ClaudeAgentAdapter.prototype as unknown as { run: ClaudeAgentAdapter["run"]; streamMessages: Stream };
  const realRun = proto.run;
  t.after(() => {
    proto.run = realRun;
  });
  const inputs: RunAgentInput[] = [];
  proto.run = function (this: typeof proto, runInput: RunAgentInput) {
    inputs.push(runInput);
    return new Observable<BaseEvent>((sub) => {
      const { threadId, runId } = runInput;
      sub.next({ type: EventType.RUN_STARTED, threadId, runId } as BaseEvent);
      this.streamMessages(thinkThenAnswer(inputs.length), threadId, runId, runInput, new Set(), sub, { currentState: {} })
        .then(() => {
          sub.next({ type: EventType.RUN_FINISHED, threadId, runId } as BaseEvent);
          sub.complete();
        })
        .catch((err: unknown) => sub.error(err));
    });
  } as ClaudeAgentAdapter["run"];

  // The browser's side, as CopilotKit's chat applies the events.
  class Chat extends AbstractAgent {
    run(runInput: RunAgentInput) {
      return adapter.run(runInput);
    }
  }
  const chat = new Chat({ threadId: "t" });
  const debug = console.debug;
  console.debug = () => {};
  t.after(() => {
    console.debug = debug;
  });
  for (const turn of [1, 2, 3]) {
    chat.addMessage({ id: `user-${turn}`, role: "user", content: `question ${turn}` });
    await chat.runAgent();
  }

  assert.deepEqual(
    chat.messages.map((m) => `${m.role}: ${m.content}`),
    ["user: question 1", "reasoning: thought 1", "assistant: answer 1"]
      .concat(["user: question 2", "reasoning: thought 2", "assistant: answer 2"])
      .concat(["user: question 3", "reasoning: thought 3", "assistant: answer 3"]),
  );
  // The chat sends earlier thinking back; the adapter never gets it.
  assert.equal(inputs.length, 3);
  assert.ok(inputs.every((i) => i.messages.every((m) => m.role !== "reasoning")));
});
