/**
 * Workspace isolation tests (issue #226, steps 3 and 4), for the design in
 * docs/workspaces.md. Like storage.test.ts, this file only speaks HTTP, so it
 * checks any backend that serves the storage API.
 *
 * Two kinds of tests:
 *
 * - "today's rules" pin behaviour of the default workspace that the membership
 *   layer must keep: Viewer workflows, draft visibility, revalidation of grants
 *   for tokens, and per-event filtering of ?watch streams.
 * - "multi-workspace" tests check what step 4 of #226 adds: creating
 *   workspaces, the workspace selectors, ids that belong to another workspace,
 *   adding members, and isolation of every surface, including the memory
 *   tokens of the TypeScript agent's runs (step 4b).
 *
 * The workspace routes and selectors are in openapi/storage.yaml; this file
 * checks statuses and bodies.
 *
 * Runs after storage.test.ts against the same backend (see
 * apps/agent/scripts/test-conformance.mjs): the workspace owner is that suite's
 * first user, CONFORMANCE_OWNER (default "conformance|alice"). On a fresh
 * database it becomes the owner here instead.
 *
 * Not covered here, because they need direct database access: the backfill of
 * memberships from existing grants and the one-time authenticated bootstrap
 * (docs/workspaces.md, "Backfill"). Those tests go with the migration in
 * step 4, in services/api-py/tests.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { type IdentityClaims, signIdentityToken } from "../src/identity-token";

type Json = Record<string, unknown>;
type Headers = Record<string, string>;

const BASE = process.env.STORAGE_URL?.replace(/\/$/, "");
const SECRET = process.env.AUTH_SECRET;
const OWNER = process.env.CONFORMANCE_OWNER || "conformance|alice";
const WS_HEADER = "X-Knowledge-Workspace";
const NO_SUCH_WORKSPACE = "00000000-0000-4000-8000-000000000000";
const enabled = !!(BASE && SECRET);

const now = () => Math.floor(Date.now() / 1000);
const sign = (claims: IdentityClaims) => signIdentityToken(claims, SECRET!);
/** Signed only when the suite runs: without AUTH_SECRET the suites report skipped, as storage.test.ts's do. */
const user = (sub: string, name: string): Headers =>
  enabled ? { "X-Knowledge-User": sign({ sub, name, email: `${name}@example.com`, exp: now() + 600 }) } : {};
/** A storage token, with a `ws` claim when `ws` is given; without one it is a legacy token. */
const storageToken = (sub: string, ws?: string): Headers => ({
  "X-Knowledge-Storage": sign({ sub, exp: now() + 600, aud: "storage", via: "mcp:workspaces", ...(ws && { ws }) }),
});
const memoryToken = (sub: string, thread: string, ws?: string): Headers => ({
  "X-Knowledge-Memory": sign({ sub, exp: now() + 600, aud: "memory", via: "mcp:workspaces", thread, ...(ws && { ws }) }),
});
const inWs = (id: string): Headers => ({ [WS_HEADER]: id });

type Answer<T> = { status: number; data: T; text: string };

async function req<T = Json>(method: string, path: string, opts: { headers?: Headers; json?: unknown; body?: BodyInit } = {}): Promise<Answer<T>> {
  const headers: Headers = { Accept: "application/json", ...opts.headers };
  let body = opts.body;
  if (opts.json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(opts.json);
  }
  const res = await fetch(BASE + path, { method, headers, body, redirect: "manual" });
  const text = await res.text();
  let data = null as T;
  if ((res.headers.get("content-type") ?? "").startsWith("application/json") && text) data = JSON.parse(text) as T;
  return { status: res.status, data, text };
}

/** `req`, asserting the status; returns the JSON body. */
async function ok<T = Json>(status: number, method: string, path: string, opts: Parameters<typeof req>[2] = {}): Promise<T> {
  const answer = await req<T>(method, path, opts);
  assert.equal(answer.status, status, `${method} ${path}: expected ${status}, got ${answer.status}: ${answer.text.slice(0, 200)}`);
  return answer.data;
}

/** A ?watch stream: the events that arrive while it is open. */
async function watch(path: string, headers: Headers) {
  const ctrl = new AbortController();
  const res = await fetch(BASE + path, { headers, signal: ctrl.signal });
  const events: Json[] = [];
  let closed = false;
  if (res.status === 200) {
    const reader = res.body!.getReader();
    void (async () => {
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += new TextDecoder().decode(value);
        const lines = buffer.split("\n");
        buffer = lines.pop()!;
        for (const line of lines) if (line.startsWith("data: ")) events.push(JSON.parse(line.slice(6)) as Json);
      }
      closed = true;
    })().catch(() => {});
  }
  // Give the server a moment to subscribe before anything is written.
  await new Promise((r) => setTimeout(r, 300));
  return {
    status: res.status,
    events,
    closed: () => closed,
    /** Waits until an event matches, or `ms` pass; then whether one did. */
    async saw(match: (e: Json) => boolean, ms = 3000) {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        if (events.some(match)) return true;
        await new Promise((r) => setTimeout(r, 50));
      }
      return events.some(match);
    },
    stop: () => ctrl.abort(),
  };
}

const onFile = (node: string, path: string) => (e: Json) => e.node === node && e.path === path;
const onExperiment = (id: string) => (e: Json) => e.op === "experiment" && e.id === id;

const stamp = Date.now();
const owner = user(OWNER, "owner");
const carol = user("workspaces|carol", "carol");
const dave = user("workspaces|dave", "dave");
const erin = user("workspaces|erin", "erin");
const ids: Record<"carol" | "dave" | "erin", string> = { carol: "", dave: "", erin: "" };

async function grant(node: string, principalId: string, role: string, headers = owner) {
  return ok<{ id: string }>(200, "POST", "/access/grants", { headers, json: { node, principalType: "user", principalId, role } });
}

describe("workspaces: setup", { skip: !enabled && "STORAGE_URL and AUTH_SECRET not set" }, () => {
  test("the owner and three signed-in users", async () => {
    const me = await ok<{ rootRole: string | null }>(200, "GET", "/access", { headers: owner });
    assert.equal(me.rootRole, "owner", `${OWNER} must own the default workspace: run after storage.test.ts, or on a fresh database`);
    for (const who of [carol, dave, erin]) await ok(200, "GET", "/access", { headers: who });
    const { users } = await ok<{ users: { id: string; subject: string }[] }>(200, "GET", "/access/users", { headers: owner });
    for (const name of ["carol", "dave", "erin"] as const) ids[name] = users.find((u) => u.subject === `workspaces|${name}`)!.id;
  });
});

describe("workspaces: today's rules the membership layer must keep", { skip: !enabled && "STORAGE_URL and AUTH_SECRET not set" }, () => {
  let node = "";
  let carolsDraft = "";

  test("a Viewer can create their own Experiment, start a run and propose, but not edit", async () => {
    node = (await ok<{ id: string }>(201, "POST", "/nodes", { headers: owner, json: { parentId: null, name: `Viewers ${stamp}` } })).id;
    await ok(200, "PUT", `/files/notes/shared.md?node=${node}`, { headers: owner, body: "shared" });
    await grant(node, ids.carol, "viewer");
    await grant(node, ids.dave, "viewer");

    carolsDraft = (await ok<{ id: string; status: string }>(201, "POST", "/experiments", { headers: carol, json: { nodeId: node, title: "Carol's draft" } })).id;
    await ok(201, "POST", "/experiments/runs", { headers: carol, json: { nodeId: node, title: "Carol's run" } });
    await ok(201, "PUT", `/files/notes/shared.md?node=${node}&propose&note=fix`, { headers: carol, body: "fixed" });
    await ok(403, "PUT", `/files/notes/shared.md?node=${node}`, { headers: carol, body: "direct edit" });
  });

  test("someone else's draft stays invisible, also to a rerun", async () => {
    await ok(404, "GET", `/experiments/${carolsDraft}`, { headers: dave });
    const { experiments } = await ok<{ experiments: { id: string }[] }>(200, "GET", `/experiments?node=${node}`, { headers: dave });
    assert.ok(!experiments.some((e) => e.id === carolsDraft), "dave must not see carol's draft in the list");
    const rerun = await req("POST", "/experiments/runs", { headers: dave, json: { rerunOf: carolsDraft } });
    assert.ok([403, 404].includes(rerun.status), `a rerun of someone else's draft must be refused, got ${rerun.status}`);
  });

  test("a token is not a snapshot: removing the grant stops the next request", async () => {
    const other = (await ok<{ id: string }>(201, "POST", "/nodes", { headers: owner, json: { parentId: null, name: `Revoked ${stamp}` } })).id;
    const g = await grant(other, ids.erin, "viewer");
    const token = storageToken("workspaces|erin");
    await ok(200, "GET", `/files?node=${other}`, { headers: token });
    await ok(200, "DELETE", `/access/grants/${g.id}`, { headers: owner });
    const after = await req("GET", `/files?node=${other}`, { headers: token });
    assert.ok([403, 404].includes(after.status), `the same token must be refused after the grant is gone, got ${after.status}`);
  });

  test("an open ?watch stream follows grant changes per event, and keeps drafts private", async () => {
    const kept = (await ok<{ id: string }>(201, "POST", "/nodes", { headers: owner, json: { parentId: null, name: `Kept ${stamp}` } })).id;
    const lost = (await ok<{ id: string }>(201, "POST", "/nodes", { headers: owner, json: { parentId: null, name: `Lost ${stamp}` } })).id;
    await grant(kept, ids.erin, "viewer");
    const lostGrant = await grant(lost, ids.erin, "viewer");
    await grant(kept, ids.carol, "viewer");

    const stream = await watch("/files?watch", erin);
    assert.equal(stream.status, 200);
    try {
      await ok(200, "PUT", `/files/notes/before.md?node=${lost}`, { headers: owner, body: "1" });
      assert.ok(await stream.saw(onFile(lost, "notes/before.md")), "erin can view the node, so its event must arrive");

      await ok(200, "DELETE", `/access/grants/${lostGrant.id}`, { headers: owner });
      await ok(200, "PUT", `/files/notes/after.md?node=${lost}`, { headers: owner, body: "2" });
      await ok(200, "PUT", `/files/notes/after.md?node=${kept}`, { headers: owner, body: "3" });
      assert.ok(await stream.saw(onFile(kept, "notes/after.md")), "events erin can still see must keep arriving");
      assert.ok(!stream.events.some(onFile(lost, "notes/after.md")), "no event for a node erin lost access to");

      const draft = (await ok<{ id: string }>(201, "POST", "/experiments", { headers: carol, json: { nodeId: kept, title: "Private" } })).id;
      await ok(200, "PUT", `/files/notes/marker.md?node=${kept}`, { headers: owner, body: "4" });
      assert.ok(await stream.saw(onFile(kept, "notes/marker.md")));
      assert.ok(!stream.events.some(onExperiment(draft)), "no event for someone else's draft");
    } finally {
      stream.stop();
    }
  });
});

describe("workspaces: multi-workspace", { skip: !enabled && "STORAGE_URL and AUTH_SECRET not set" }, () => {
  /** The default workspace's id, and carol's second workspace. */
  let defaultWs = "";
  let ws2 = "";
  let ws2Node = "";
  let ws2Experiment = "";
  const need = () => assert.ok(ws2 && defaultWs, "needs workspace creation (the first test) to pass");

  test("a signed-in user creates a workspace and becomes its Owner", async () => {
    const { workspaces } = await ok<{ workspaces: { id: string; slug: string; role: string }[] }>(200, "GET", "/workspaces", { headers: owner });
    defaultWs = workspaces.find((w) => w.slug === "default")!.id;
    const created = await ok<{ id: string; slug: string; role: string }>(201, "POST", "/workspaces", { headers: carol, json: { name: `Carol's lab ${stamp}` } });
    assert.equal(created.role, "owner");
    ws2 = created.id;
    const mine = await ok<{ workspaces: { id: string }[] }>(200, "GET", "/workspaces", { headers: carol });
    assert.ok(mine.workspaces.some((w) => w.id === ws2));
    const theirs = await ok<{ workspaces: { id: string }[] }>(200, "GET", "/workspaces", { headers: dave });
    assert.ok(!theirs.workspaces.some((w) => w.id === ws2), "a non-member must not see the workspace");
    // The creator has Full access on the new workspace's root.
    const access = await ok<{ rootRole: string | null }>(200, "GET", "/access", { headers: { ...carol, ...inWs(ws2) } });
    assert.equal(access.rootRole, "owner");
  });

  test("the header, the query parameter and no selector each pick a workspace", async () => {
    need();
    ws2Node = (await ok<{ id: string }>(201, "POST", "/nodes", { headers: { ...carol, ...inWs(ws2) }, json: { parentId: null, name: `Only in ws2 ${stamp}` } })).id;
    await ok(200, "PUT", `/files/notes/secret.md?node=${ws2Node}`, { headers: { ...carol, ...inWs(ws2) }, body: `zebra-${stamp}` });
    const named = (nodes: { id: string }[]) => nodes.some((n) => n.id === ws2Node);
    assert.ok(named((await ok<{ nodes: { id: string }[] }>(200, "GET", "/nodes", { headers: { ...carol, ...inWs(ws2) } })).nodes));
    assert.ok(named((await ok<{ nodes: { id: string }[] }>(200, "GET", `/nodes?workspace=${ws2}`, { headers: carol })).nodes));
    assert.ok(!named((await ok<{ nodes: { id: string }[] }>(200, "GET", "/nodes", { headers: owner })).nodes), "no selector means the default workspace");
    assert.ok(!named((await ok<{ nodes: { id: string }[] }>(200, "GET", "/nodes", { headers: { ...owner, ...inWs(defaultWs) } })).nodes));
  });

  test("selectors that disagree are refused, and unknown, malformed or foreign workspaces look alike", async () => {
    need();
    await ok(400, "GET", `/nodes?workspace=${defaultWs}`, { headers: { ...carol, ...inWs(ws2) } });
    const unknown = await req("GET", "/nodes", { headers: { ...carol, ...inWs(NO_SUCH_WORKSPACE) } });
    const malformed = await req("GET", "/nodes", { headers: { ...carol, ...inWs("not-a-uuid") } });
    const foreign = await req("GET", "/nodes", { headers: { ...dave, ...inWs(ws2) } });
    assert.deepEqual([unknown.status, malformed.status, foreign.status], [404, 404, 404]);
    assert.equal(foreign.text, unknown.text, "a non-member's answer must not reveal that the workspace exists");
    assert.ok(!foreign.text.includes("Carol"), "no workspace name in the answer");
  });

  test("ids from another workspace are not found", async () => {
    need();
    ws2Experiment = (await ok<{ id: string }>(201, "POST", "/experiments", { headers: { ...carol, ...inWs(ws2) }, json: { nodeId: ws2Node, title: "ws2 run" } })).id;
    // carol is in both workspaces from here on, so only the workspace decides.
    const viewerNode = (await ok<{ id: string }>(201, "POST", "/nodes", { headers: owner, json: { parentId: null, name: `Carol in default ${stamp}` } })).id;
    await grant(viewerNode, ids.carol, "editor");
    const inDefault = { ...carol, ...inWs(defaultWs) };
    await ok(404, "GET", `/nodes/${ws2Node}`, { headers: inDefault });
    await ok(404, "GET", `/files/notes/secret.md?node=${ws2Node}`, { headers: inDefault });
    await ok(404, "GET", `/experiments/${ws2Experiment}`, { headers: inDefault });
    await ok(404, "POST", "/nodes", { headers: inDefault, json: { parentId: ws2Node, name: "Under a foreign node" } });
    await ok(404, "POST", "/access/grants", { headers: { ...owner, ...inWs(defaultWs) }, json: { node: ws2Node, principalType: "user", principalId: ids.dave, role: "viewer" } });
  });

  test("adding a member: exact-email lookup, starting access, and no overwrite on retry", async () => {
    need();
    const lookup = await ok<{ user: Json }>(200, "GET", `/workspaces/${ws2}/lookup?email=DAVE@example.com`, { headers: carol });
    assert.deepEqual(Object.keys(lookup.user).sort(), ["id", "name"], "only the id and name, never the login subject");
    assert.equal(lookup.user.id, ids.dave);
    await ok(404, "GET", `/workspaces/${ws2}/lookup?email=dave`, { headers: carol });
    await ok(404, "GET", `/workspaces/${ws2}/lookup?email=dave@example.com`, { headers: dave });

    await ok(201, "POST", `/workspaces/${ws2}/members`, { headers: carol, json: { userId: ids.dave, role: "member", access: "viewer" } });
    const again = await ok<{ role: string }>(409, "POST", `/workspaces/${ws2}/members`, { headers: carol, json: { userId: ids.dave, role: "admin", access: "editor" } });
    assert.equal(again.role, "member", "adding again must not change the role");
    const owners = await ok<{ role: string }>(409, "POST", `/workspaces/${ws2}/members`, { headers: carol, json: { userId: ids.carol, role: "member", access: "none" } });
    assert.equal(owners.role, "owner", "adding the Owner as a Member must not downgrade them");

    // A later Share change survives a retried add.
    await grant(ws2Node, ids.dave, "editor", { ...carol, ...inWs(ws2) });
    await ok(409, "POST", `/workspaces/${ws2}/members`, { headers: carol, json: { userId: ids.dave, role: "member", access: "viewer" } });
    await ok(200, "PUT", `/files/notes/dave.md?node=${ws2Node}`, { headers: { ...dave, ...inWs(ws2) }, body: "dave can still edit" });
  });

  test("the member list is the workspace's own, and Members don't see emails", async () => {
    need();
    const asOwner = await ok<{ members: Json[] }>(200, "GET", `/workspaces/${ws2}/members`, { headers: carol });
    assert.deepEqual(asOwner.members.map((m) => m.id).sort(), [ids.carol, ids.dave].sort());
    assert.ok(asOwner.members.every((m) => !("subject" in m)));
    const asMember = await ok<{ members: Json[] }>(200, "GET", `/workspaces/${ws2}/members`, { headers: dave });
    assert.ok(asMember.members.every((m) => !("email" in m)), "a Member sees names only");
    await ok(404, "GET", `/workspaces/${ws2}/members`, { headers: erin });
    const users = await ok<{ users: { id: string }[] }>(200, "GET", "/access/users", { headers: { ...dave, ...inWs(ws2) } });
    assert.ok(!users.users.some((u) => u.id === ids.erin), "no directory of every signed-in user");
  });

  test("search, chats, memory and change streams stay in their workspace", async () => {
    need();
    const inWs2 = { ...carol, ...inWs(ws2) };
    const inDefault = { ...carol, ...inWs(defaultWs) };

    const found = await ok<{ results: { path: string }[] }>(200, "GET", `/search?q=zebra-${stamp}`, { headers: inWs2 });
    assert.ok(found.results.length > 0);
    const leaked = await ok<{ results: unknown[] }>(200, "GET", `/search?q=zebra-${stamp}`, { headers: inDefault });
    assert.equal(leaked.results.length, 0, "search must not cross workspaces");

    const chatId = `ws2-chat-${stamp}`;
    await ok(201, "POST", `/chats/${chatId}/runs`, { headers: inWs2, json: { agentId: "default", runId: "r1", events: [], messages: [{ id: "m1", role: "user", content: "hi" }], name: "In ws2" } });
    const chats = await ok<{ threads: { id: string }[] }>(200, "GET", "/chats", { headers: inDefault });
    assert.ok(!chats.threads.some((c) => c.id === chatId), "a chat lives in one workspace");
    await ok(404, "GET", `/chats/${chatId}`, { headers: inDefault });

    const note = { description: "Only in ws2", type: "preference", body: "ws2" };
    await ok(200, "PUT", "/memory/notes/ws2-only?create=1", { headers: inWs2, json: note });
    await ok(404, "GET", "/memory/notes/ws2-only", { headers: inDefault });

    const defaultStream = await watch(`/files?watch&workspace=${defaultWs}`, carol);
    const ws2Stream = await watch(`/files?watch&workspace=${ws2}`, carol);
    try {
      await ok(200, "PUT", `/files/notes/streamed.md?node=${ws2Node}`, { headers: inWs2, body: "s" });
      assert.ok(await ws2Stream.saw(onFile(ws2Node, "notes/streamed.md")));
      assert.ok(!(await defaultStream.saw(onFile(ws2Node, "notes/streamed.md"), 500)), "events stay in their workspace");
    } finally {
      defaultStream.stop();
      ws2Stream.stop();
    }
  });

  test("storage tokens carry their workspace, and a legacy token stays in the default workspace", async () => {
    need();
    // carol can read in both workspaces (the editor grant in default from an earlier test).
    const scoped = storageToken("workspaces|carol", ws2);
    await ok(200, "GET", `/files?node=${ws2Node}`, { headers: scoped });
    await ok(400, "GET", "/nodes", { headers: { ...scoped, ...inWs(defaultWs) } });

    const legacy = storageToken("workspaces|carol");
    await ok(200, "GET", "/nodes", { headers: legacy });
    await ok(200, "GET", "/nodes", { headers: { ...legacy, ...inWs(defaultWs) } });
    await ok(400, "GET", "/nodes", { headers: { ...legacy, ...inWs(ws2) } });
    await ok(400, "GET", `/nodes?workspace=${ws2}`, { headers: legacy });
    // After the compatibility cut-off, tokens without `ws` are refused (401). That is
    // a release switch, tested when the cut-off is set.
  });

  test("memory tokens carry their workspace too", async () => {
    need();
    const thread = `ws-thread-${stamp}`;
    await ok(200, "GET", "/memory/agent", { headers: memoryToken("workspaces|carol", thread, ws2) });
    await ok(400, "GET", "/memory/agent", { headers: { ...memoryToken("workspaces|carol", thread), ...inWs(ws2) } });
  });

  test("an agent run keeps the workspace it started in", async () => {
    need();
    // A run started in ws2 records ws2, whatever the caller selects afterwards.
    const run = await ok<{ id: string }>(201, "POST", "/experiments/runs", { headers: storageToken("workspaces|carol", ws2), json: { nodeId: ws2Node, title: "Pinned" } });
    await ok(400, "POST", `/experiments/${run.id}/finish`, { headers: { ...storageToken("workspaces|carol", ws2), ...inWs(defaultWs) }, json: { results: { ok: true }, state: "done" } });
    await ok(200, "POST", `/experiments/${run.id}/finish`, { headers: storageToken("workspaces|carol", ws2), json: { results: { ok: true }, state: "done" } });
    await ok(404, "GET", `/experiments/${run.id}`, { headers: storageToken("workspaces|carol", defaultWs) });
  });
});
