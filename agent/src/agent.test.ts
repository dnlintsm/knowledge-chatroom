import assert from "node:assert/strict";
import { test } from "node:test";

import type { RunAgentInput } from "@ag-ui/core";

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

test("outside MCP servers are pre-approved and get each run's signed user", () => {
  const shared = adapter.buildOptions(input);
  assert.ok(shared.allowedTools?.includes("mcp__lab"));
  assert.deepEqual(shared.mcpServers?.lab, { type: "http", url: "http://lab/mcp", alwaysLoad: true });
  const run = runAs("alice", () => adapter.buildOptions(input), null, () => {}, (server) => `alice-for-${server}`);
  assert.deepEqual((run.mcpServers?.lab as { headers?: object }).headers, { "x-knowledge-user": "alice-for-lab" });
  assert.ok(run.mcpServers?.copilotkit);
});
