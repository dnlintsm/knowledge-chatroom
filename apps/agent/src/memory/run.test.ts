import assert from "node:assert/strict";
import { test } from "node:test";

import { continuesAfterTool } from "./run";

test("a run continuing after a browser tool's result counts as having used a tool", () => {
  assert.equal(continuesAfterTool([{ role: "user" }, { role: "assistant" }, { role: "tool" }]), true);
  assert.equal(continuesAfterTool([{ role: "tool" }, { role: "user" }]), false);
  assert.equal(continuesAfterTool([]), false);
  assert.equal(continuesAfterTool(undefined), false);
});
