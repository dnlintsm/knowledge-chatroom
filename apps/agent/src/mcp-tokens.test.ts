import assert from "node:assert/strict";
import { test } from "node:test";

import { STORAGE_AUDIENCE } from "@knowledge-chatroom/contracts/identity-token";

import { mcpTokens } from "./mcp-tokens";
import { localMemoryToken, MEMORY_AUDIENCE, signIdentity, verifyIdentity } from "./storage/identity";

/** A remote backend trading its run's tokens for its MCP servers' (issue #176, step 5). */

const SECRET = "0123456789abcdef0123456789abcdef";
const NOW = Date.UTC(2030, 0, 1);
const s = Math.floor(NOW / 1000);
const alice = { sub: "kc|alice", email: "alice@example.com", name: "Alice" };
const storage = (claims: object = {}) =>
  signIdentity({ ...alice, aud: STORAGE_AUDIENCE, via: "remote", exp: s + 1800, ...claims }, SECRET);
const memory = (claims: object = {}) =>
  signIdentity({ ...alice, aud: MEMORY_AUDIENCE, via: "remote", thread: "t1", node: null, exp: s + 900, ...claims }, SECRET);
const all = { servers: { lab: ["identity", "storage", "memory"] } };

type Tokens = { tokens: Record<string, Record<string, string>> };
const tokensOf = (answer: { status: number; body: unknown }) => {
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  return (answer.body as Tokens).tokens;
};

test("each kind is made for the server, as the agent makes it for its own servers", () => {
  const { lab } = tokensOf(mcpTokens({ "x-knowledge-storage": storage(), "x-knowledge-memory": memory() }, all, SECRET, NOW));
  assert.deepEqual(verifyIdentity(lab.identity, SECRET, NOW, "mcp:lab"), { ...alice, aud: "mcp:lab", exp: s + 1800 });
  assert.deepEqual(verifyIdentity(lab.storage, SECRET, NOW, STORAGE_AUDIENCE), { ...alice, aud: "storage", via: "mcp:lab", exp: s + 1800 });
  // The chat's memory, expiring with the run's memory token, and only an outside server's.
  assert.deepEqual(verifyIdentity(lab.memory, SECRET, NOW, MEMORY_AUDIENCE), {
    ...alice,
    aud: "memory",
    via: "mcp:lab",
    thread: "t1",
    node: null,
    exp: s + 900,
  });
});

test("only what is asked for, and no memory without the chat's memory token", () => {
  const tokens = tokensOf(
    mcpTokens({ "x-knowledge-storage": storage() }, { servers: { lab: ["memory"], papers: ["identity"] } }, SECRET, NOW),
  );
  assert.deepEqual(tokens.lab, {});
  assert.deepEqual(Object.keys(tokens.papers), ["identity"]);
});

test("refused without the run's remote storage token", () => {
  assert.equal(mcpTokens({}, all, SECRET, NOW).status, 401);
  // A token made for an outside server can't be traded on.
  assert.equal(mcpTokens({ "x-knowledge-storage": storage({ via: "mcp:lab" }) }, all, SECRET, NOW).status, 401);
  assert.equal(mcpTokens({ "x-knowledge-storage": storage({ exp: s - 1 }) }, all, SECRET, NOW).status, 401);
  assert.equal(mcpTokens({ "x-knowledge-storage": memory() }, all, SECRET, NOW).status, 401);
});

test("someone else's memory token, or one made for a server, gives no memory token", () => {
  for (const other of [memory({ sub: "kc|bob" }), memory({ via: "mcp:other" })]) {
    const { lab } = tokensOf(mcpTokens({ "x-knowledge-storage": storage(), "x-knowledge-memory": other }, all, SECRET, NOW));
    assert.equal(lab.memory, undefined);
  }
});

test("bad requests are 400", () => {
  for (const body of [null, {}, { servers: [] }, { servers: { "a b": ["identity"] } }, { servers: { lab: ["root"] } }]) {
    assert.equal(mcpTokens({ "x-knowledge-storage": storage() }, body, SECRET, NOW).status, 400);
  }
});

test("without login: only memory, in the local form", () => {
  const local = localMemoryToken({ via: "remote", thread: "t1", node: null });
  const { lab } = tokensOf(mcpTokens({ "x-knowledge-memory": local }, all, null, NOW));
  assert.deepEqual(lab, { memory: localMemoryToken({ via: "mcp:lab", thread: "t1", node: null }) });
  const none = tokensOf(mcpTokens({ "x-knowledge-memory": localMemoryToken({ via: "mcp:x", thread: "t1", node: null }) }, all, null, NOW));
  assert.deepEqual(none.lab, {});
});
