/**
 * Search by meaning over memory, and Claude searching past chats (issue #93,
 * step 5), against real Postgres with a stand-in embedding model. Skipped
 * unless TEST_DATABASE_URL is set, and like the other storage suites it wipes
 * that database first.
 *
 *   TEST_DATABASE_URL=postgres://knowledge:knowledge@localhost:5432/knowledge_test \
 *   npx tsx --test src/storage/memory-recall.test.ts
 */

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { AccessService } from "./access";
import { ChatService } from "./chats";
import { connect, migrate, prepareRowSecurity, type Sql } from "./db";
import { MemoryService } from "./memory";
import { SharedMemoryService } from "./shared-memory";
import type { Embedder, SemanticIndex } from "./semantic";
import type { Storage } from "./index";
import { MemoryRecall } from "../memory/recall";
import { chatTools, memoryPrompt, memoryTools, prepareMemory, type RunMemory } from "../memory/run";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

/** Words that mean the same thing share a dimension: a tiny embedding model. */
const CONCEPTS = [
  ["chart", "charts", "plot", "plots", "graph", "axes", "figure"],
  ["coffee", "tea", "drink"],
  ["etch", "wafer", "line", "process"],
];
class FakeEmbedder implements Embedder {
  readonly model = "fake-concepts";
  calls = 0;
  async embed(texts: string[]): Promise<number[][]> {
    this.calls += texts.length;
    return texts.map((t) => {
      const words = t.toLowerCase().match(/[a-z]+/g) ?? [];
      const v = [...CONCEPTS.map((c) => words.filter((w) => c.includes(w)).length), 0.01];
      const norm = Math.hypot(...v);
      return v.map((x) => x / norm);
    });
  }
}

type Tool = { name: string; handler: unknown };
const caller = (tools: Tool[]) => async (name: string, args: Record<string, unknown>) => {
  const result = await (tools.find((t) => t.name === name)!.handler as (a: unknown, e: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }>)(args, {});
  return { text: result.content[0].text, isError: result.isError ?? false };
};

describe("memory recall and past chats", { skip: !TEST_DATABASE_URL && "TEST_DATABASE_URL not set" }, () => {
  let sql: Sql;
  let memory: MemoryService;
  let shared: SharedMemoryService;
  let chats: ChatService;
  let me: string;
  let other: string;
  const embedder = new FakeEmbedder();
  const semantic = { ready: true, embedder, minSimilarity: 0.5 } as unknown as SemanticIndex;
  let storage: Storage;

  const say = (userId: string, id: string, user: string, assistant: string, name?: string) =>
    chats.appendRun(userId, id, {
      agentId: "default",
      runId: `${id}-run`,
      events: [],
      name: name ?? user,
      messages: [
        { id: `${id}-1`, role: "user", content: user },
        { id: `${id}-2`, role: "assistant", content: [{ type: "text", text: assistant }] },
        { id: `${id}-3`, role: "tool", content: "secret tool output mentioning anodize" },
      ],
    });

  before(async () => {
    const reset = connect(TEST_DATABASE_URL!);
    await reset`DROP SCHEMA public CASCADE`;
    await reset`CREATE SCHEMA public`;
    await reset.end();
    sql = connect(TEST_DATABASE_URL!);
    await migrate(sql);
    const rowSecurity = await prepareRowSecurity(sql);
    const [{ id: workspaceId }] = await sql<{ id: string }[]>`SELECT id FROM workspaces WHERE slug = 'default'`;
    memory = new MemoryService(sql, workspaceId, rowSecurity);
    shared = new SharedMemoryService(sql, workspaceId, rowSecurity);
    chats = new ChatService(sql, workspaceId, rowSecurity);
    const access = new AccessService(sql, workspaceId);
    me = await access.localUserId();
    other = await access.userForSubject("test|other", { name: "Other" });
    storage = { memory, sharedMemory: shared, chats, semantic } as unknown as Storage;
    process.env.MEMORY = "on";

    await memory.save(me, "plot-style", { description: "How they want figures", type: "preference", body: "No titles; units on the axes." }, "user");
    await memory.save(me, "morning", { description: "Daily routine", type: "profile", body: "Starts with coffee at 7." }, "user");
  });

  after(async () => {
    delete process.env.MEMORY;
    await sql?.end();
  });

  test("MemoryRecall finds notes close in meaning, and embeds each text once", async () => {
    const recall = new MemoryRecall(embedder, 0.5);
    const hits = await recall.search(memory, shared, me, null, "how should charts look");
    assert.deepEqual(hits.map((h) => h.name), ["plot-style"]);
    assert.ok(hits[0].similarity > 0.9);
    const before = embedder.calls;
    await recall.search(memory, shared, me, null, "what do they drink");
    assert.equal(embedder.calls - before, 1, "only the query is embedded again");
    assert.deepEqual(await recall.search(memory, shared, other, null, "charts"), [], "only the user's own notes");
  });

  test("memory_search adds notes close in meaning after the word matches", async () => {
    const run = (await prepareMemory(storage, me, { threadId: "now", runId: "r" }, () => {}))!;
    assert.ok(run.recall, "on when the embedding model is ready");
    const call = caller(memoryTools(run));
    const found = await call("memory_search", { query: "graph" });
    assert.match(found.text, /Close in meaning:\n- plot-style \(preference\): How they want figures/);
    // A word match isn't listed twice.
    const both = await call("memory_search", { query: "axes" });
    assert.doesNotMatch(both.text, /Close in meaning/);
    assert.match(both.text, /plot-style/);
    assert.equal(run.tainted, false, "personal notes don't mark the run");

    const off = (await prepareMemory({ ...storage, semantic: null } as unknown as Storage, me, { threadId: "now" }, () => {}))!;
    assert.equal(off.recall, null);
    assert.equal((await caller(memoryTools(off))("memory_search", { query: "graph" })).text, "No notes match.");
  });

  test("chats_search finds the user's own past chats, never incognito ones or this one", async () => {
    await say(me, "c-etch", "What was the etch rate on the wafer line?", "About 40 nm/min with the new recipe.");
    await say(me, "c-lunch", "Where should we get lunch?", "The place by the lab.");
    await say(me, "c-secret", "Etch numbers for the audit", "Here they are.");
    await memory.setIncognito(me, "c-secret", true);
    await say(me, "now", "etch again", "Sure.");
    await say(other, "c-theirs", "My etch notes", "Noted.");

    const run: RunMemory = (await prepareMemory(storage, me, { threadId: "now", runId: "r" }, () => {}))!;
    assert.match(memoryPrompt(run, true), /chats_search and chats_read/);
    assert.doesNotMatch(memoryPrompt(run), /chats_search/);
    const call = caller(chatTools(run));

    const found = await call("chats_search", { query: "etch rate" });
    assert.match(found.text, /^- c-etch: What was the etch rate/);
    assert.match(found.text, /user: What was the etch rate/);
    assert.doesNotMatch(found.text, /c-secret|c-theirs|- now:|c-lunch/);
    assert.equal(run.tainted, true, "past chats count as outside content");

    // Only what the user and Claude said counts, not tool output.
    assert.equal((await call("chats_search", { query: "anodize" })).text, "No past chats match.");
    // LIKE's wildcards are plain characters.
    assert.equal((await call("chats_search", { query: "%_" })).text, "No past chats match.");

    const read = await call("chats_read", { id: "c-etch" });
    assert.match(read.text, /User: What was the etch rate on the wafer line\?\n\nYou: About 40 nm\/min/);
    assert.doesNotMatch(read.text, /anodize/);
    assert.equal((await call("chats_read", { id: "c-secret" })).isError, true);
    assert.equal((await call("chats_read", { id: "c-theirs" })).isError, true);
  });

  test("chats_read pages long chats; nothing once memory is off", async () => {
    await say(me, "c-long", "Tell me everything", "x".repeat(20_000));
    const run = (await prepareMemory(storage, me, { threadId: "now", runId: "r" }, () => {}))!;
    const call = caller(chatTools(run));
    const first = await call("chats_read", { id: "c-long" });
    assert.match(first.text, /\(more: chats_read with offset 12000\)$/);
    const second = await call("chats_read", { id: "c-long", offset: 12_000 });
    assert.doesNotMatch(second.text, /\(more:/);

    await memory.setMode(me, "off");
    try {
      assert.equal((await call("chats_search", { query: "etch" })).isError, true);
    } finally {
      await memory.setMode(me, "on");
    }
    assert.deepEqual(chatTools({ ...run, chats: null }), [], "no chat tools without chat history");
  });
});
