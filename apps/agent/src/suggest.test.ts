import assert from "node:assert/strict";
import { test } from "node:test";

import { EventType } from "@ag-ui/core";
import type { RunAgentInput } from "@ag-ui/core";

import { DEFAULT_SUGGESTIONS_MODEL, suggest, suggestPrompt, suggestionsModel, type CreateMessage } from "./suggest";

const SUGGEST = {
  name: "copilotkitSuggest",
  description: "Suggest what the user could say next.",
  parameters: { type: "object", properties: { suggestions: { type: "array" } }, required: ["suggestions"] },
};

function input(overrides: Partial<RunAgentInput> = {}): RunAgentInput {
  return {
    threadId: "t1",
    runId: "r1",
    state: {},
    forwardedProps: {},
    tools: [SUGGEST],
    context: [{ description: "The user's knowledge workspace", value: '{"openFile":"runs/etch/report.md"}' }],
    messages: [
      { id: "1", role: "user", content: "Analyze the etch report" },
      {
        id: "2",
        role: "assistant",
        content: "RF power dominates etch rate.",
        toolCalls: [{ id: "c1", type: "function", function: { name: "readWorkspaceFile", arguments: "{}" } }],
      },
      { id: "3", role: "tool", toolCallId: "c1", content: "file body that should not be quoted" },
      {
        id: "4",
        role: "user",
        content:
          "Suggest what the user could say next.\nProvide at least 2 and at most 3 suggestions.\n" +
          'The user has the following tools available: [{"name":"readWorkspaceFile"}].\n Prefer next steps on the run.',
      },
    ],
    ...overrides,
  } as RunAgentInput;
}

function setEnv(env: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

function withEnv(env: Record<string, string | undefined>, fn: () => void) {
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  setEnv(env);
  try {
    fn();
  } finally {
    setEnv(saved);
  }
}

test("the prompt carries the conversation, the workspace and the request, not tool output", () => {
  const prompt = suggestPrompt(input())!;
  assert.match(prompt.user, /User: Analyze the etch report/);
  assert.match(prompt.user, /Claude: RF power dominates etch rate\./);
  assert.match(prompt.user, /\(Claude used readWorkspaceFile\)/);
  assert.match(prompt.user, /runs\/etch\/report\.md/);
  assert.match(prompt.user, /Prefer next steps on the run\./);
  assert.doesNotMatch(prompt.user, /should not be quoted/);
  assert.doesNotMatch(prompt.user, /The user has the following tools available/);
  assert.equal(prompt.tool.name, "copilotkitSuggest");
  assert.deepEqual(prompt.tool.input_schema, SUGGEST.parameters);
});

test("only suggestion requests get a prompt", () => {
  assert.equal(suggestPrompt(input({ tools: [] })), null);
  assert.equal(suggestPrompt(input({ messages: [] })), null);
});

test("a long conversation keeps its newest lines", () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ id: `m${i}`, role: "user" as const, content: `message ${i} ${"x".repeat(1500)}` }));
  const prompt = suggestPrompt(input({ messages: [...many, input().messages.at(-1)!] }))!;
  assert.match(prompt.user, /message 39 /);
  assert.doesNotMatch(prompt.user, /message 0 /);
});

test("the model is small by default and follows a gateway's model otherwise", () => {
  withEnv({ SUGGESTIONS_MODEL: undefined, CLAUDE_MODEL: "claude-sonnet-5", ANTHROPIC_MODEL: undefined }, () =>
    assert.equal(suggestionsModel(), DEFAULT_SUGGESTIONS_MODEL),
  );
  withEnv({ SUGGESTIONS_MODEL: undefined, CLAUDE_MODEL: "openai/gpt-5.1", ANTHROPIC_MODEL: undefined }, () =>
    assert.equal(suggestionsModel(), "openai/gpt-5.1"),
  );
  withEnv({ SUGGESTIONS_MODEL: "claude-haiku-4.5", CLAUDE_MODEL: undefined, ANTHROPIC_MODEL: undefined }, () =>
    assert.equal(suggestionsModel(), "claude-haiku-4-5"),
  );
});

test("the answer is one forced copilotkitSuggest call streamed as AG-UI events", async () => {
  const chips = { suggestions: [{ title: "Compare with litho run", message: "Compare this run with litho." }] };
  let sent: Parameters<CreateMessage>[0] | undefined;
  const create: CreateMessage = async (params) => {
    sent = params;
    return { content: [{ type: "tool_use", id: "x", name: "copilotkitSuggest", input: chips }] } as never;
  };
  const events = await suggest(input(), create);
  assert.deepEqual(sent?.tool_choice, { type: "tool", name: "copilotkitSuggest" });
  assert.deepEqual(
    events.map((e) => e.type),
    [EventType.RUN_STARTED, EventType.TOOL_CALL_START, EventType.TOOL_CALL_ARGS, EventType.TOOL_CALL_END, EventType.RUN_FINISHED],
  );
  const args = events.find((e) => e.type === EventType.TOOL_CALL_ARGS) as unknown as { delta: string };
  assert.deepEqual(JSON.parse(args.delta), chips);
});

test("a failed call ends the run with an error instead of chips", async () => {
  const original = console.error;
  console.error = () => {};
  try {
    const events = await suggest(input(), async () => {
      throw new Error("overloaded");
    });
    assert.deepEqual(events.map((e) => e.type), [EventType.RUN_STARTED, EventType.RUN_ERROR]);
  } finally {
    console.error = original;
  }
});
