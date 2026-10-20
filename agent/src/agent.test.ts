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
