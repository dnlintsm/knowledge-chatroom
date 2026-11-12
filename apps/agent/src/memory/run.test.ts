import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { z } from "zod";

import { chatTools, continuesAfterTool, memoryTools, type RunMemory } from "./run";

test("a run continuing after a browser tool's result counts as having used a tool", () => {
  assert.equal(continuesAfterTool([{ role: "user" }, { role: "assistant" }, { role: "tool" }]), true);
  assert.equal(continuesAfterTool([{ role: "tool" }, { role: "user" }]), false);
  assert.equal(continuesAfterTool([]), false);
  assert.equal(continuesAfterTool(undefined), false);
});

test("api-py's copy of the memory tools' schemas matches these tools", () => {
  // services/api-py serves /memory/agent for remote backends from this file (issue #190, step 8c).
  const memory = { run: { threadId: "t", runId: "r" }, mode: "on", shared: [], chats: {} } as unknown as RunMemory;
  const tools = [...memoryTools(memory), ...chatTools(memory)].map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: z.toJSONSchema(z.object(t.inputSchema)),
  }));
  const file = new URL("../../../../services/api-py/api_py/data/memory-tools.json", import.meta.url);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), tools);
});
