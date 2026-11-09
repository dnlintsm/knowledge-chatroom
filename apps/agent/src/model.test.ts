import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveModel } from "./model";

function withModel(model: string, fn: () => void) {
  const saved = { claude: process.env.CLAUDE_MODEL, anthropic: process.env.ANTHROPIC_MODEL };
  process.env.CLAUDE_MODEL = model;
  delete process.env.ANTHROPIC_MODEL;
  try {
    fn();
  } finally {
    for (const [key, value] of [["CLAUDE_MODEL", saved.claude], ["ANTHROPIC_MODEL", saved.anthropic]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("dotted Claude names become API ids", () => {
  withModel("claude-sonnet-4.6", () => assert.equal(resolveModel(), "claude-sonnet-4-6"));
});

test("gateway model ids keep their dots", () => {
  for (const id of ["openai/gpt-5.1", "anthropic/claude-sonnet-4.6", "qwen3.5-coder", "gemini-2.5-pro"]) {
    withModel(id, () => assert.equal(resolveModel(), id));
  }
});
