/**
 * Outside MCP servers using memory (issue #93, step 5): /memory/agent with
 * X-Knowledge-Memory tokens, against real Postgres. Skipped unless
 * TEST_DATABASE_URL is set, and like the other storage suites it wipes that
 * database first.
 *
 *   TEST_DATABASE_URL=postgres://knowledge:knowledge@localhost:5432/knowledge_test \
 *   npx tsx --test src/storage/memory-agent.test.ts
 */

import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";

import { AccessService } from "./access";
import { connect, migrate, prepareRowSecurity, type Sql } from "./db";
import { localMemoryToken, MEMORY_HEADER, signIdentity } from "./identity";
import { MemoryService } from "./memory";
import { MemoryPackHub } from "./memory-packs";
import { SharedMemoryService } from "./shared-memory";
import type { Storage } from "./index";
import { createMemoryHandler } from "../memory/http";
import { trackLiveRun } from "../memory/run";
import type { MemoryEvent } from "./memory";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const SECRET = "m".repeat(32);

describe("memory for outside MCP servers", { skip: !TEST_DATABASE_URL && "TEST_DATABASE_URL not set" }, () => {
  let sql: Sql;
  let memory: MemoryService;
  let shared: SharedMemoryService;
  let access: AccessService;
  let workspaceId: string;
  let alice: string;
  let server: http.Server;
  let base: string;
  /** Login on (AUTH_SECRET) or off. */
  let secret: string | undefined = SECRET;
  const exp = () => Math.floor(Date.now() / 1000) + 600;
  const token = (claims: Record<string, unknown>) =>
    signIdentity({ sub: "test|alice", name: "Alice", aud: "memory", via: "mcp:lab", thread: "t-1", node: null, exp: exp(), ...claims } as never, SECRET);

  const call = async (method: string, path: string, header: string | null, body?: unknown) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { "Content-Type": "application/json", ...(header ? { [MEMORY_HEADER]: header } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };

  before(async () => {
    const reset = connect(TEST_DATABASE_URL!);
    await reset`DROP SCHEMA public CASCADE`;
    await reset`CREATE SCHEMA public`;
    await reset.end();
    sql = connect(TEST_DATABASE_URL!);
    await migrate(sql);
    const rowSecurity = await prepareRowSecurity(sql);
    [{ id: workspaceId }] = await sql<{ id: string }[]>`SELECT id FROM workspaces WHERE slug = 'default'`;
    memory = new MemoryService(sql, workspaceId, rowSecurity);
    shared = new SharedMemoryService(sql, workspaceId, rowSecurity);
    access = new AccessService(sql, workspaceId);
    await access.userForSubject("test|first", { name: "First" });
    alice = await access.userForSubject("test|alice", { name: "Alice" });
    await memory.save(alice, "reply-style", { description: "Short answers", type: "preference", body: "Lead with the result." }, "user");

    process.env.MEMORY = "on";
    const storage = {
      memory,
      sharedMemory: shared,
      memoryPacks: new MemoryPackHub(sql, workspaceId),
      access,
      get config() {
        return { authSecret: secret };
      },
    } as unknown as Storage;
    const handler = createMemoryHandler(() => storage, () => "ready");
    server = http.createServer((req, res) => void handler(req, res, new URL(req.url ?? "/", "http://x")));
    await new Promise<void>((resolve) => server.listen(0, resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    server?.close();
    delete process.env.MEMORY;
    await sql?.end();
  });

  test("only a memory token for the run gets in", async () => {
    assert.equal((await call("GET", "/memory/agent", null)).status, 401);
    // Other kinds of tokens, and forged or expired ones, don't count.
    assert.equal((await call("GET", "/memory/agent", token({ aud: "storage" }))).status, 401);
    assert.equal((await call("GET", "/memory/agent", token({ thread: undefined }))).status, 401);
    assert.equal((await call("GET", "/memory/agent", token({ exp: 1 }))).status, 401);
    assert.equal((await call("GET", "/memory/agent", localMemoryToken({ via: "mcp:lab", thread: "t-1", node: null }))).status, 401);
    const ok = await call("GET", "/memory/agent", token({}));
    assert.equal(ok.status, 200);
    assert.match(String(ok.body.prompt), /reply-style \(preference\): Short answers/);
    assert.match(String(ok.body.prompt), /wait in their Memory inbox/);
    const tools = ok.body.tools as { name: string; inputSchema: { properties: object } }[];
    assert.deepEqual(tools.map((t) => t.name), ["memory_view", "memory_search", "memory_save", "memory_edit", "memory_delete"]);
    assert.ok("name" in tools[0].inputSchema.properties);
  });

  test("reads work; changes wait in the inbox and show in the live run", async () => {
    const events: MemoryEvent[] = [];
    const untrack = trackLiveRun("t-1", (e) => events.push(e));
    try {
      const view = await call("POST", "/memory/agent/tools/memory_view", token({}), { name: "reply-style" });
      assert.equal(view.status, 200);
      assert.match(String(view.body.text), /Lead with the result\./);
      assert.equal(view.body.isError, false);

      const save = await call("POST", "/memory/agent/tools/memory_save", token({}), {
        name: "lab-role", description: "Process engineer", type: "profile", body: "Runs the etch line.",
      });
      assert.match(String(save.body.text), /waits in the user's Memory inbox/);
      assert.equal(await memory.get(alice, "lab-role"), null, "not saved directly");
      const [item] = await memory.inbox(alice);
      assert.deepEqual([item.op, item.name, item.threadId], ["add", "lab-role", "t-1"]);
      assert.deepEqual(events.map((e) => e.kind), ["read", "propose"]);

      const missing = await call("POST", "/memory/agent/tools/memory_view", token({}), { name: "nope" });
      assert.equal(missing.body.isError, true);
      assert.equal((await call("POST", "/memory/agent/tools/memory_view", token({}), { wrong: 1 })).status, 400);
      assert.equal((await call("POST", "/memory/agent/tools/rm_rf", token({}), {})).status, 404);
    } finally {
      untrack();
    }
  });

  test("nothing in an incognito chat, or with memory off", async () => {
    await memory.setIncognito(alice, "t-2", true);
    assert.equal((await call("GET", "/memory/agent", token({ thread: "t-2" }))).status, 403);
    await memory.setMode(alice, "off");
    assert.equal((await call("POST", "/memory/agent/tools/memory_search", token({}), { query: "short" })).status, 403);
    await memory.setMode(alice, "on");
    assert.equal((await call("POST", "/memory/agent/tools/memory_search", token({}), { query: "short" })).status, 200);
  });

  test("without login, the unsigned local token is the local user's", async () => {
    secret = undefined;
    try {
      const local = await access.localUserId();
      await memory.save(local, "local-note", { description: "Local", type: "reference", body: "Here." }, "user");
      const ok = await call("GET", "/memory/agent", localMemoryToken({ via: "mcp:lab", thread: "t-9", node: null }));
      assert.equal(ok.status, 200);
      assert.match(String(ok.body.prompt), /local-note/);
      assert.equal((await call("GET", "/memory/agent", token({}))).status, 401);
    } finally {
      secret = SECRET;
    }
  });
});
