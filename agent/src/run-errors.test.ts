import assert from "node:assert/strict";
import { test } from "node:test";

import { ClaudeAgentAdapter } from "@ag-ui/claude-agent-sdk";
import type { SDKMessage, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";

import { failureReason, keepFailureReason, withReason } from "./run-errors";

const result = (fields: Record<string, unknown>) => ({ type: "result", is_error: true, ...fields }) as unknown as SDKResultMessage;

test("failureReason gives the API error text, or the error subtype and details", () => {
  assert.equal(failureReason(result({ subtype: "success", result: " Invalid API key · Fix external API key \n" })), "Invalid API key · Fix external API key");
  assert.equal(failureReason(result({ subtype: "success", result: "", api_error_status: 404 })), "API error 404");
  assert.equal(failureReason(result({ subtype: "error_max_turns", errors: [] })), "error_max_turns");
  assert.equal(
    failureReason(result({ subtype: "error_during_execution", errors: ["spawn failed", " "] })),
    "error_during_execution: spawn failed",
  );
});

test("withReason only rewrites the adapter's generic error", () => {
  const generic = new Error("SDK resume/run failed; check the original files, tools, credentials and execution configuration.");
  assert.equal((withReason(generic, "Invalid API key") as Error).message, "Claude run failed: Invalid API key");
  assert.equal(withReason(generic, undefined), generic);
  const other = new Error("Original SDK session is unavailable.");
  assert.equal(withReason(other, "Invalid API key"), other);
});

test("keepFailureReason puts the failed result's reason into the adapter's error", async () => {
  // A stand-in with the adapter's behavior: throw the generic error on a failed result.
  class Fake extends ClaudeAgentAdapter {}
  (Fake.prototype as unknown as Record<string, unknown>).observeRecovery = async function* (stream: AsyncIterable<SDKMessage>) {
    for await (const message of stream) {
      if (message.type === "result" && message.is_error) throw new Error("SDK resume/run failed; check ...");
      yield message;
    }
  };
  keepFailureReason(Fake as unknown as typeof ClaudeAgentAdapter);
  async function* sdk() {
    yield result({ subtype: "success", result: "API Error: 401 invalid x-api-key" }) as SDKMessage;
  }
  const observe = (Fake.prototype as unknown as { observeRecovery: (s: AsyncIterable<SDKMessage>) => AsyncGenerator<SDKMessage> }).observeRecovery;
  await assert.rejects(async () => {
    for await (const _ of observe.call(new Fake({}), sdk())) void _;
  }, /Claude run failed: API Error: 401 invalid x-api-key/);
});

test("the installed adapter still has observeRecovery to wrap", () => {
  assert.equal(typeof (ClaudeAgentAdapter.prototype as unknown as Record<string, unknown>).observeRecovery, "function");
});
