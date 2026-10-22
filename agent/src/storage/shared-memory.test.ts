/**
 * Shared memory (issue #93, step 3) against real Postgres; no object store
 * needed. Skipped unless TEST_DATABASE_URL is set, and like the other storage
 * suites it wipes that database first.
 *
 *   TEST_DATABASE_URL=postgres://knowledge:knowledge@localhost:5432/knowledge_test \
 *   npx tsx --test src/storage/shared-memory.test.ts
 */

import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";

import { AccessService } from "./access";
import { connect, migrate, prepareRowSecurity, type Sql } from "./db";
import { MemoryConflictError, MemoryError, MemoryNotFoundError, MemoryService } from "./memory";
import { SharedMemoryService, sharedRef } from "./shared-memory";
import type { Storage } from "./index";
import { createMemoryHandler } from "../memory/http";
import { memoryPrompt, memoryTools, prepareMemory, type RunMemory } from "../memory/run";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

describe("shared memory", { skip: !TEST_DATABASE_URL && "TEST_DATABASE_URL not set" }, () => {
  let sql: Sql;
  let shared: SharedMemoryService;
  let memory: MemoryService;
  let rowSecurity: boolean;
  let workspaceId: string;
  /** Owns the workspace. */
  let owner: string;
  /** Views the workspace; edits node `lab`; in group `etch`. */
  let member: string;
  /** No grants at all. */
  let outsider: string;
  let lab: string;
  let sub: string;
  let other: string;
  let etch: string;
  const note = (body: string, description = "Lab conventions") => ({ description, type: "reference", body });

  before(async () => {
    const reset = connect(TEST_DATABASE_URL!);
    await reset`DROP SCHEMA public CASCADE`;
    await reset`CREATE SCHEMA public`;
    await reset.end();
    sql = connect(TEST_DATABASE_URL!);
    await migrate(sql);
    rowSecurity = await prepareRowSecurity(sql);
    [{ id: workspaceId }] = await sql<{ id: string }[]>`SELECT id FROM workspaces WHERE slug = 'default'`;
    shared = new SharedMemoryService(sql, workspaceId, rowSecurity);
    memory = new MemoryService(sql, workspaceId, rowSecurity);
    const access = new AccessService(sql, workspaceId);
    owner = await access.localUserId();
    // The first person to sign in becomes an owner.
    await access.userForSubject("test|first", { name: "First" });
    member = await access.userForSubject("test|member", { name: "Mia" });
    outsider = await access.userForSubject("test|outsider", { name: "Out" });
    const node = async (name: string, parent: string | null = null) =>
      (await sql<{ id: string }[]>`
        INSERT INTO nodes (workspace_id, parent_id, type_id, name, path)
        VALUES (${workspaceId}, ${parent},
          (SELECT id FROM node_types WHERE workspace_id = ${workspaceId} ORDER BY depth OFFSET ${parent ? 1 : 0} LIMIT 1),
          ${name}, 'x')
        RETURNING id`)[0].id;
    lab = await node("Etch lab");
    sub = await node("Chamber 3", lab);
    other = await node("Litho");
    await access.setGrant(null, "user", member, "viewer", owner);
    await access.setGrant(lab, "user", member, "editor", owner);
    etch = await access.createGroup(null, "Etch team");
    await access.setMember(etch, member, true);
  });

  after(() => sql?.end());

  test("who reads and edits each place", async () => {
    // The owner edits the workspace; a viewer only proposes there.
    const { note: ws } = await shared.share(owner, { scope: "workspace" }, "lab-conventions", note("Units are nm."));
    assert.ok(ws?.canEdit);
    const seen = await shared.list(member);
    assert.deepEqual(seen.map((n) => [n.name, n.canEdit, n.mode]), [["lab-conventions", false, "auto"]]);
    await assert.rejects(shared.update(member, ws!.id, note("Units are mm.")), MemoryError);
    assert.deepEqual(await shared.list(outsider), [], "no grant, no workspace memory");
    await assert.rejects(shared.get(outsider, ws!.id), MemoryNotFoundError);

    // The member edits their node and their group, directly.
    const { note: atLab } = await shared.share(member, { scope: "node", nodeId: lab }, "etch-recipes", note("Use recipe B."));
    const { note: team } = await shared.share(member, { scope: "group", groupId: etch }, "team-standup", note("Stand-up at 9."));
    assert.equal(atLab?.place.label, "Etch lab");
    assert.equal(team?.place.label, "Etch team");
    assert.equal((await shared.get(owner, team!.id)).canEdit, true, "owners manage groups' memory");
    await assert.rejects(shared.share(outsider, { scope: "group", groupId: etch }, "x", note("x")), MemoryError);

    // Sharing where you can't edit is a proposal.
    const { note: made, proposal } = await shared.share(member, { scope: "workspace" }, "my-tip", note("Tip."));
    assert.equal(made, null);
    assert.equal(proposal?.mine, true);
    assert.equal(proposal?.canDecide, false);
    assert.deepEqual((await shared.proposals(owner)).map((p) => [p.name, p.canDecide, p.author]), [["my-tip", true, "Mia"]]);
    assert.deepEqual(await shared.proposals(outsider), []);
    await shared.decide(owner, proposal!.id, "accept");
    const tip = (await shared.list(owner)).find((n) => n.name === "my-tip")!;
    assert.equal((await shared.versions(owner, tip.id))[0].changedBy, "Mia");
  });

  test("a run gets the workspace's, its groups' and its node's notes, minus Off", async () => {
    const names = async (user: string, node: string | null) => (await shared.forRun(user, node)).map((n) => n.name).sort();
    assert.deepEqual(await names(member, null), ["lab-conventions", "my-tip", "team-standup"]);
    assert.deepEqual(await names(member, sub), ["etch-recipes", "lab-conventions", "my-tip", "team-standup"], "nodes above count");
    assert.deepEqual(await names(member, other), ["lab-conventions", "my-tip", "team-standup"]);
    assert.deepEqual(await names(owner, null), ["lab-conventions", "my-tip", "team-standup"], "owners see groups' notes");

    const conventions = (await shared.list(member)).find((n) => n.name === "lab-conventions")!;
    await assert.rejects(shared.setMode(member, conventions.id, "off", true), MemoryError, "only editors set everyone's");
    await shared.setMode(owner, conventions.id, "manual", true);
    assert.equal((await shared.forRun(member, null)).find((n) => n.name === "lab-conventions")?.mode, "manual");
    await shared.setMode(member, conventions.id, "off", false);
    assert.deepEqual(await names(member, null), ["my-tip", "team-standup"]);
    assert.ok((await names(owner, null)).includes("lab-conventions"), "one person's Off is theirs");
    await shared.setMode(member, conventions.id, null, false);
    assert.equal((await shared.forRun(member, null)).find((n) => n.name === "lab-conventions")?.mode, "manual");
    await shared.setMode(owner, conventions.id, "auto", true);

    const hits = await shared.search(member, null, "units");
    assert.deepEqual(hits.map((h) => [h.name, h.snippet]), [["lab-conventions", "Units are nm."]]);
  });

  test("proposals: replaced, conflicts, withdrawn, deletes", async () => {
    const conventions = (await shared.list(owner)).find((n) => n.name === "lab-conventions")!;
    const first = await shared.propose(member, { op: "update", id: conventions.id, input: note("Units are pm.") }, { authorType: "agent", threadId: "t1" });
    const again = await shared.propose(member, { op: "update", id: conventions.id, input: note("Units are µm.") }, { authorType: "agent", threadId: "t1" });
    assert.equal(again.id, first.id, "proposing again replaces it");
    assert.equal(again.authorType, "agent");
    await shared.update(owner, conventions.id, note("Units are nm, always."));
    await assert.rejects(shared.decide(owner, again.id, "accept"), MemoryConflictError);
    assert.equal((await shared.proposals(owner)).some((p) => p.id === again.id), true, "still open after a conflict");
    await assert.rejects(shared.decide(owner, again.id, "withdraw"), MemoryError, "only the author withdraws");
    await shared.decide(member, again.id, "withdraw");

    const del = await shared.propose(member, { op: "delete", id: conventions.id, reason: "Outdated" }, { authorType: "agent" });
    await assert.rejects(shared.decide(member, del.id, "accept"), MemoryError, "a viewer can't decide");
    await shared.decide(owner, del.id, "accept");
    await assert.rejects(shared.get(owner, conventions.id), MemoryNotFoundError);
  });

  test("Claude's tools read shared notes and only propose changes to them", async () => {
    process.env.MEMORY = "on";
    try {
      const storage = { sql, workspaceId, memory, sharedMemory: shared } as unknown as Storage;
      const events: unknown[] = [];
      const runMemory = (await prepareMemory(storage, member, { threadId: "chat-s", runId: "r1" }, (e) => events.push(e), lab)) as RunMemory;
      const recipes = runMemory.shared.find((n) => n.name === "etch-recipes")!;
      const prompt = memoryPrompt(runMemory);
      assert.match(prompt, new RegExp(`${sharedRef(recipes.id)} \\[Etch lab\\] etch-recipes`));
      const tools = Object.fromEntries(memoryTools(runMemory).map((t) => [t.name, t]));
      const call = async (name: string, args: Record<string, unknown>) =>
        (await tools[name].handler(args as never, {})) as { content: { text: string }[]; isError?: boolean };

      const read = await call("memory_view", { name: sharedRef(recipes.id) });
      assert.match(read.content[0].text, /Use recipe B\./);
      assert.equal(runMemory.tainted, true, "a shared note is someone else's text");

      const edit = await call("memory_edit", { name: sharedRef(recipes.id), old_text: "recipe B", new_text: "recipe C" });
      assert.match(edit.content[0].text, /Proposed/);
      assert.equal((await shared.get(member, recipes.id)).body, "Use recipe B.", "not changed");
      const [proposal] = (await shared.proposals(member)).filter((p) => p.name === "etch-recipes");
      assert.equal(proposal.body, "Use recipe C.");
      assert.equal(proposal.authorType, "agent");

      const added = await call("memory_save", { name: "chamber-notes", description: "Chamber 3", type: "reference", body: "Runs hot.", scope: "node" });
      assert.match(added.content[0].text, /Proposed/);
      assert.ok((await shared.proposals(owner)).some((p) => p.name === "chamber-notes" && p.place.nodeId === lab));

      const found = await call("memory_search", { query: "recipe" });
      assert.match(found.content[0].text, /etch-recipes/);
      assert.ok(events.some((e) => (e as { name: string }).name === "etch-recipes"));
    } finally {
      delete process.env.MEMORY;
    }
  });

  test("the /memory/shared API", async () => {
    process.env.MEMORY = "on";
    const storage = {
      memory,
      sharedMemory: shared,
      config: { authSecret: undefined },
      access: { localUserId: async () => owner },
    } as unknown as Storage;
    const handler = createMemoryHandler(() => storage, () => "ready");
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://x");
      void handler(req, res, url);
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const get = async (path: string) => {
        const res = await fetch(`${base}${path}`);
        return { status: res.status, body: (await res.json()) as Record<string, unknown> };
      };
      const send = async (method: string, path: string, body: unknown) => {
        const res = await fetch(`${base}${path}`, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        return { status: res.status, body: (await res.json()) as Record<string, unknown> };
      };
      const all = await get(`/memory?node=${lab}`);
      assert.equal(all.status, 200);
      const list = all.body.shared as { id: string; name: string }[];
      assert.ok(list.some((n) => n.name === "etch-recipes"));
      assert.ok((all.body.sharedProposals as { name: string }[]).some((p) => p.name === "chamber-notes"));
      assert.deepEqual((all.body.targets as { scope: string }[]).map((t) => t.scope).sort(), ["group", "node", "workspace"]);

      const made = await send("POST", "/memory/shared", { scope: "workspace", name: "api-note", description: "From the API", type: "reference", body: "Hi" });
      assert.equal(made.status, 200);
      const id = (made.body.note as { id: string }).id;
      assert.equal((await get(`/memory/shared/${id}`)).body.note && true, true);
      assert.equal((await send("PUT", `/memory/shared/${id}`, { description: "From the API", type: "reference", body: "Hello", version: 1 })).status, 200);
      assert.equal((await send("PUT", `/memory/shared/${id}`, { description: "x", type: "reference", body: "x", version: 1 })).status, 409);
      assert.equal((await send("PUT", `/memory/shared/${id}/mode`, { mode: "manual", everyone: true })).status, 200);
      const proposal = (all.body.sharedProposals as { id: string; name: string }[]).find((p) => p.name === "chamber-notes")!;
      assert.equal((await send("POST", `/memory/shared/proposals/${proposal.id}/reject`, {})).status, 200);
      const gone = await fetch(`${base}/memory/shared/${id}`, { method: "DELETE" });
      assert.equal(gone.status, 200);
      assert.equal((await get(`/memory/shared/${id}`)).status, 404);
    } finally {
      server.close();
      delete process.env.MEMORY;
    }
  });
});
