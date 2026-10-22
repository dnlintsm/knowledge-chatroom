/**
 * Personalized memory (issue #93) against real Postgres; no object store
 * needed. Skipped unless TEST_DATABASE_URL is set, like storage.test.ts, and
 * like it wipes that database first.
 *
 *   TEST_DATABASE_URL=postgres://knowledge:knowledge@localhost:5432/knowledge_test \
 *   npx tsx --test src/storage/memory.test.ts
 */

import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";

import { strFromU8, unzipSync } from "fflate";

import { AccessService } from "./access";
import { asUser, connect, migrate, prepareRowSecurity, type Sql } from "./db";
import {
  MemoryConflictError,
  MemoryError,
  MemoryNotFoundError,
  MemoryService,
  type MemoryRun,
} from "./memory";
import type { Storage } from "./index";
import { createMemoryHandler } from "../memory/http";
import { memoryPrompt, memoryTools, prepareMemory } from "../memory/run";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

describe("personalized memory", { skip: !TEST_DATABASE_URL && "TEST_DATABASE_URL not set" }, () => {
  let sql: Sql;
  let memory: MemoryService;
  let rowSecurity: boolean;
  let workspaceId: string;
  let me: string;
  let other: string;
  const run: MemoryRun = { threadId: "chat-1", runId: "run-1" };
  const note = (body: string, description = "How Dan likes replies") => ({ description, type: "preference", body });

  before(async () => {
    const reset = connect(TEST_DATABASE_URL!);
    await reset`DROP SCHEMA public CASCADE`;
    await reset`CREATE SCHEMA public`;
    await reset.end();
    sql = connect(TEST_DATABASE_URL!);
    await migrate(sql);
    rowSecurity = await prepareRowSecurity(sql);
    [{ id: workspaceId }] = await sql<{ id: string }[]>`SELECT id FROM workspaces WHERE slug = 'default'`;
    memory = new MemoryService(sql, workspaceId, rowSecurity);
    const access = new AccessService(sql, workspaceId);
    me = await access.localUserId();
    other = await access.userForSubject("test|other", { name: "Other" });
  });

  after(() => sql?.end());

  test("Claude's changes are versions and events, and undo walks them back", async () => {
    const created = await memory.save(me, "reply-style", note("Short replies."), "agent", { run });
    assert.equal(created.note.version, 1);
    assert.equal(created.note.createdBy, "agent");
    assert.equal(created.event?.kind, "create");

    const same = await memory.save(me, "reply-style", note("Short replies."), "agent", { run });
    assert.equal(same.event, null, "saving the same content records nothing");

    const updated = await memory.save(me, "reply-style", note("Short replies, no em-dashes."), "agent", { run });
    assert.equal(updated.note.version, 2);
    assert.equal(updated.event?.kind, "update");

    const undone = await memory.undo(me, updated.event!.id);
    assert.equal(undone.note?.body, "Short replies.");
    assert.equal(undone.note?.version, 3);
    await assert.rejects(memory.undo(me, updated.event!.id), MemoryConflictError);
    // The create isn't the latest change any more.
    await assert.rejects(memory.undo(me, created.event!.id), MemoryConflictError);

    const versions = await memory.versions(me, "reply-style");
    assert.deepEqual(versions.map((v) => [v.version, v.changedBy]), [[3, "user"], [2, "agent"], [1, "agent"]]);
    assert.equal(versions[1].threadId, "chat-1");
  });

  test("undoing a new note removes it; deletes archive and come back", async () => {
    const { event } = await memory.save(me, "temp-note", note("Delete me", "Scratch"), "agent", { run });
    await memory.undo(me, event!.id);
    assert.equal(await memory.get(me, "temp-note"), null);

    await memory.save(me, "lab", { description: "Dan's lab", type: "profile", body: "Etch team" }, "user");
    const archived = await memory.archive(me, "lab", true, run);
    assert.equal(archived.note.archived, true);
    assert.equal(archived.event?.kind, "archive");
    assert.ok(!(await memory.index(me)).text.includes("lab"), "archived notes leave the index");
    await memory.undo(me, archived.event!.id);
    assert.equal((await memory.get(me, "lab"))?.archived, false);

    // Saving over an archived note brings it back; undo puts it back in the archive as it was.
    await memory.archive(me, "lab", true);
    const revived = await memory.save(me, "lab", { description: "Dan's lab", type: "profile", body: "CVD team" }, "agent", { run });
    assert.equal(revived.event?.kind, "create");
    assert.equal(revived.note.archived, false);
    const back = await memory.undo(me, revived.event!.id);
    assert.equal(back.note?.archived, true);
    assert.equal(back.note?.body, "Etch team");

    // Undo refuses a change that isn't the latest, archiving included.
    await memory.archive(me, "lab", false);
    const gone = await memory.archive(me, "lab", true, run);
    await memory.archive(me, "lab", false);
    await memory.archive(me, "lab", true);
    await assert.rejects(memory.undo(me, gone.event!.id), MemoryConflictError);
    assert.equal((await memory.get(me, "lab"))?.archived, true);
  });

  test("edits replace exactly one occurrence", async () => {
    await memory.save(me, "tools", { description: "Tools Dan uses", type: "reference", body: "Uses vim. Uses vim daily." }, "user");
    await assert.rejects(memory.replaceText(me, "tools", "vim", "emacs", "agent", run), /2 times/);
    await assert.rejects(memory.replaceText(me, "tools", "nano", "emacs", "agent", run), /isn't in/);
    const { note: edited } = await memory.replaceText(me, "tools", "vim daily", "emacs daily", "agent", run);
    assert.equal(edited.body, "Uses vim. Uses emacs daily.");
    await assert.rejects(memory.replaceText(me, "missing", "a", "b", "agent", run), MemoryNotFoundError);
    // Edits apply only to the version they read.
    await assert.rejects(
      memory.save(me, "tools", { ...edited, body: "stale" }, "agent", { run, ifVersion: edited.version - 1 }),
      MemoryConflictError,
    );
  });

  test("input is checked", async () => {
    await assert.rejects(memory.save(me, "Bad Name", note("x"), "user"), MemoryError);
    await assert.rejects(memory.save(me, "ok", { description: "", type: "preference", body: "x" }, "user"), /description/);
    await assert.rejects(memory.save(me, "ok", { description: "d", type: "secret", body: "x" }, "user"), /type/);
    await assert.rejects(memory.save(me, "reply-style", note("x"), "user", { create: true }), MemoryConflictError);
    const { note: saved } = await memory.save(me, "multi", { description: "one\n  line", type: "project", body: " body \r\n" }, "user");
    assert.equal(saved.description, "one line");
    assert.equal(saved.body, "body");
  });

  test("reads are recorded, search finds notes, the index fits its budget", async () => {
    const read = await memory.markRead(me, "reply-style", run);
    assert.equal(read?.event.kind, "read");
    assert.ok(read?.note.lastUsedAt);
    assert.equal(await memory.markRead(me, "nope", run), null);

    const hits = await memory.search(me, "emacs");
    assert.deepEqual(hits.map((h) => h.name), ["tools"]);
    assert.match(hits[0].snippet, /emacs/);
    assert.deepEqual(await memory.search(me, "  "), []);
    // LIKE wildcards are searched for as text.
    assert.deepEqual(await memory.search(me, "%%"), []);

    const index = await memory.index(me);
    assert.equal(index.shown, index.total);
    assert.match(index.text.split("\n")[0], /^- reply-style \(preference\): /, "most recently used first");
    const small = await memory.index(me, 60);
    assert.ok(small.shown < small.total && small.text.length <= 60);
  });

  test("notes are private to their user, in the database too", async () => {
    assert.deepEqual(await memory.list(other), []);
    assert.equal(await memory.get(other, "reply-style"), null);
    assert.equal(await memory.markRead(other, "reply-style", run), null);
    assert.deepEqual(await memory.search(other, "replies"), []);
    const mine = await memory.save(me, "private", note("Only mine", "Mine"), "agent", { run });
    await assert.rejects(memory.undo(other, mine.event!.id), MemoryNotFoundError);
    assert.equal(await memory.remove(other, "private"), false);
    if (rowSecurity) {
      const seen = await asUser(sql, other, (db) => db`
        SELECT (SELECT count(*)::int FROM memories) AS notes,
               (SELECT count(*)::int FROM memory_versions) AS versions,
               (SELECT count(*)::int FROM memory_events) AS events`);
      assert.deepEqual(seen[0], { notes: 0, versions: 0, events: 0 });
    }
  });

  test("restore, delete for good, export", async () => {
    const restored = await memory.restore(me, "tools", 1);
    assert.equal(restored.body, "Uses vim. Uses vim daily.");

    const zip = unzipSync(await memory.exportZip(me));
    assert.match(strFromU8(zip["memory/tools.md"]), /^---\nname: tools\ndescription: Tools Dan uses\ntype: reference\n---\n\nUses vim/);

    assert.equal(await memory.remove(me, "tools"), true);
    assert.equal(await memory.get(me, "tools"), null);
    const [{ count }] = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM memory_versions v
      WHERE NOT EXISTS (SELECT 1 FROM memories m WHERE m.id = v.memory_id)`;
    assert.equal(count, 0, "versions go with the note");
  });

  test("settings: memory off, incognito chats, and what a run gets", async () => {
    const storage = { memory } as unknown as Storage;
    const events: string[] = [];
    process.env.MEMORY = "on";
    try {
      const runMemory = await prepareMemory(storage, me, run, (e) => events.push(`${e.kind}:${e.name}`));
      assert.ok(runMemory);
      assert.match(memoryPrompt(runMemory), /<memory-index>\n- private \(preference\): Mine/);

      // The tools act for the run's user and report each change.
      const tools = memoryTools(runMemory);
      const call = (name: string, args: Record<string, unknown>) =>
        (tools.find((t) => t.name === name)!.handler as (a: unknown, extra: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }>)(args, {});
      const saved = await call("memory_save", { name: "tool-note", description: "From a tool", type: "project", body: "Etch recipe v2" });
      assert.match(saved.content[0].text, /Saved tool-note/);
      const viewed = await call("memory_view", { name: "tool-note" });
      assert.match(viewed.content[0].text, /Etch recipe v2/);
      assert.equal((await call("memory_view", { name: "gone" })).isError, true);
      await call("memory_delete", { name: "tool-note" });
      assert.deepEqual(events, ["create:tool-note", "read:tool-note", "archive:tool-note"]);

      // Made incognito mid-run: the run's tools stop reading and saving.
      await memory.setIncognito(me, run.threadId, true);
      const refused = await call("memory_view", { name: "private" });
      assert.equal(refused.isError, true);
      assert.match(refused.content[0].text, /incognito/);
      await memory.setIncognito(me, run.threadId, false);

      await memory.setIncognito(me, "chat-2", true);
      assert.deepEqual(await memory.settings(me, "chat-2"), { mode: "on", incognito: true });
      assert.equal(await prepareMemory(storage, me, { threadId: "chat-2" }, () => {}), null);
      assert.equal(await prepareMemory(storage, other, { threadId: "chat-2" }, () => {}) !== null, true, "incognito is per user");
      await memory.setIncognito(me, "chat-2", false);

      await memory.setMode(me, "off");
      assert.equal(await prepareMemory(storage, me, run, () => {}), null);
      await memory.setMode(me, "on");
      await assert.rejects(memory.setMode(me, "maybe"), MemoryError);

      delete process.env.MEMORY;
      assert.equal(await prepareMemory(storage, me, run, () => {}), null, "MEMORY=on turns it on");
    } finally {
      delete process.env.MEMORY;
    }
  });

  test("the /memory API", async () => {
    const storage = {
      memory,
      config: { authSecret: undefined },
      access: { localUserId: async () => me },
    } as unknown as Storage;
    const handle = createMemoryHandler(() => storage, () => "ready");
    const server = http.createServer((req, res) => void handle(req, res, new URL(req.url!, "http://x")));
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const base = `http://localhost:${(server.address() as AddressInfo).port}`;
    const call = (path: string, init?: RequestInit) => fetch(`${base}${path}`, init);
    const put = (path: string, body: unknown) =>
      call(path, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    try {
      assert.equal((await call("/memory")).status, 404, "off without MEMORY=on");
      process.env.MEMORY = "on";

      const list = (await (await call("/memory?thread=chat-9")).json()) as { mode: string; incognito: boolean; notes: { name: string; body?: string }[] };
      assert.equal(list.mode, "on");
      assert.equal(list.incognito, false);
      assert.ok(list.notes.some((n) => n.name === "reply-style"));
      assert.equal(list.notes[0].body, undefined, "the list has no bodies");

      const saved = await put("/memory/notes/api-note", { description: "From the panel", type: "profile", body: "Hi" });
      assert.equal(saved.status, 200);
      assert.equal(((await saved.json()) as { note: { updatedBy: string } }).note.updatedBy, "user");
      assert.equal((await put("/memory/notes/api-note?create=1", { description: "x", type: "profile", body: "" })).status, 409);
      assert.equal((await put("/memory/notes/api-note", { description: "", type: "profile", body: "" })).status, 400);

      const detail = (await (await call("/memory/notes/api-note")).json()) as { note: { body: string }; versions: unknown[] };
      assert.equal(detail.note.body, "Hi");
      assert.equal(detail.versions.length, 1);

      const settings = await (await put("/memory/settings", { thread: "chat-9", incognito: true })).json();
      assert.deepEqual(settings, { mode: "on", incognito: true });

      const zip = await call("/memory/export");
      assert.equal(zip.headers.get("content-type"), "application/zip");

      assert.equal((await call("/memory/notes/api-note", { method: "DELETE" })).status, 200);
      assert.equal((await call("/memory/notes/api-note")).status, 404);
      assert.equal((await call("/memory/events/not-an-id/undo", { method: "POST" })).status, 404);
    } finally {
      delete process.env.MEMORY;
      server.close();
    }
  });
});
