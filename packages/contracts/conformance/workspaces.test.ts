/**
 * Workspace isolation tests, for the design in
 * docs/workspaces.md. Like storage.test.ts, this file only speaks HTTP, so it
 * checks any backend that serves the storage API.
 *
 * Two kinds of tests:
 *
 * - "today's rules" pin behaviour of the default workspace that the membership
 *   layer must keep: Viewer workflows, draft visibility, revalidation of grants
 *   for tokens, and per-event filtering of ?watch streams.
 * - "multi-workspace" tests check what more than one workspace adds: creating
 *   workspaces, the workspace selectors, ids that belong to another workspace,
 *   adding members, and isolation of every surface, including the memory
 *   tokens of the TypeScript agent's runs (step 4b).
 *
 * The workspace routes and selectors are in openapi/storage.yaml; this file
 * checks statuses and bodies.
 *
 * Runs after storage.test.ts against the same backend (see
 * scripts/test-conformance.mjs): the workspace owner is that suite's
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
    // The Owner gets emails with the names; nobody gets login subjects.
    const { users } = await ok<{ users: { id: string; email?: string | null }[] }>(200, "GET", "/access/users", { headers: owner });
    assert.ok(users.every((u) => !("subject" in u)), "no login subjects in the member list");
    for (const name of ["carol", "dave", "erin"] as const) ids[name] = users.find((u) => u.email === `${name}@example.com`)!.id;
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
    const users = await ok<{ users: Json[] }>(200, "GET", "/access/users", { headers: { ...dave, ...inWs(ws2) } });
    assert.ok(!users.users.some((u) => u.id === ids.erin), "no directory of every signed-in user");
    // The same rule as the member list: names for a Member, emails for an Owner, subjects for nobody.
    assert.ok(users.users.every((u) => !("email" in u) && !("subject" in u)), "a Member sees names only");
    const forOwner = await ok<{ users: Json[] }>(200, "GET", "/access/users", { headers: { ...carol, ...inWs(ws2) } });
    assert.ok(forOwner.users.every((u) => "email" in u && !("subject" in u)), "an Owner also sees emails");
    const self = await ok<{ me: Json }>(200, "GET", "/access", { headers: { ...dave, ...inWs(ws2) } });
    assert.equal(self.me.subject, "workspaces|dave", "a user still gets their own subject");
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

describe("workspaces: administration (#255)", { skip: !enabled && "STORAGE_URL and AUTH_SECRET not set" }, () => {
  // erin's workspace: erin is its Owner, carol an Admin and dave a Member.
  let ws = "";
  let node = "";
  const as = (who: Headers) => ({ ...who, ...inWs(ws) });
  const role = (headers: Headers, userId: string, to: string, status: number) =>
    ok(status, "PATCH", `/workspaces/${ws}/members/${userId}`, { headers, json: { role: to } });
  const roles = async () => {
    const { members } = await ok<{ members: { id: string; role: string }[] }>(200, "GET", `/workspaces/${ws}/members`, { headers: erin });
    return Object.fromEntries(members.map((m) => [m.id, m.role]));
  };
  const need = () => assert.ok(ws && node, "needs the first test to pass");

  test("setup: a workspace with an Owner, an Admin and a Member", async () => {
    ws = (await ok<{ id: string }>(201, "POST", "/workspaces", { headers: erin, json: { name: `Erin's admin lab ${stamp}` } })).id;
    await ok(201, "POST", `/workspaces/${ws}/members`, { headers: erin, json: { userId: ids.carol, role: "admin", access: "none" } });
    await ok(201, "POST", `/workspaces/${ws}/members`, { headers: erin, json: { userId: ids.dave, role: "member", access: "viewer" } });
    node = (await ok<{ id: string }>(201, "POST", "/nodes", { headers: as(erin), json: { parentId: null, name: `Admin lab node ${stamp}` } })).id;
  });

  test("Owners change any role; Admins make Members Admins and step down; never the last Owner", async () => {
    need();
    // An Admin promotes a Member, but can't demote another Admin or touch an Owner.
    await role(carol, ids.dave, "admin", 200);
    await role(carol, ids.dave, "member", 403);
    await role(carol, ids.dave, "owner", 403);
    await role(carol, ids.erin, "member", 403);
    await role(erin, ids.dave, "member", 200);
    // A Member changes nothing, not even their own role.
    await role(dave, ids.dave, "admin", 403);
    await role(dave, ids.carol, "member", 403);
    // An Admin may step down; an Owner brings them back.
    await role(carol, ids.carol, "member", 200);
    await role(erin, ids.carol, "admin", 200);
    // The last Owner can't be demoted, by anyone.
    await role(erin, ids.erin, "admin", 409);
    // Transferring ownership: make them Owner, then step down.
    await role(erin, ids.carol, "owner", 200);
    await role(erin, ids.erin, "admin", 200);
    assert.deepEqual(await roles(), { [ids.erin]: "admin", [ids.carol]: "owner", [ids.dave]: "member" });
    // Owners are peers: carol makes erin Owner again, and erin steps carol back to Admin.
    await role(carol, ids.erin, "owner", 200);
    await role(erin, ids.carol, "admin", 200);
    // Not a member: 404, the same as any unknown id.
    await role(erin, NO_SUCH_WORKSPACE, "member", 404);
    // A role change never changes a grant: dave still reads with the viewer grant he was added with.
    await ok(200, "GET", `/files?node=${node}`, { headers: as(dave) });
  });

  test("removing a member takes their grants and groups, closes their streams and refuses their tokens", async () => {
    need();
    const g = (await ok<{ id: string }>(201, "POST", "/access/groups", { headers: as(erin), json: { parentId: null, name: `Admin lab team ${stamp}` } })).id;
    await ok(200, "PUT", `/access/groups/${g}/members/${ids.dave}`, { headers: as(erin) });
    await grant(node, ids.dave, "editor", as(erin));
    const draft = (await ok<{ id: string }>(201, "POST", "/experiments", { headers: as(dave), json: { nodeId: node, title: "Dave's private draft" } })).id;
    const shared = (await ok<{ id: string }>(201, "POST", "/experiments", { headers: as(dave), json: { nodeId: node, title: "Dave's shared one" } })).id;
    await ok(200, "PATCH", `/experiments/${shared}`, { headers: as(dave), json: { status: "shared" } });

    // The preview: grants, groups, and only the Experiments the caller can see.
    const preview = await ok<{ grants: number; groups: { id: string }[]; experiments: { id: string }[] }>(200, "GET", `/workspaces/${ws}/members/${ids.dave}/removal`, { headers: carol });
    assert.equal(preview.grants, 2, "the root grant he was added with, and the node grant");
    assert.deepEqual(preview.groups.map((x) => x.id), [g]);
    assert.ok(!preview.experiments.some((e) => e.id === draft), "a draft is never listed");
    await ok(403, "GET", `/workspaces/${ws}/members/${ids.erin}/removal`, { headers: dave });

    const stream = await watch(`/files?watch&workspace=${ws}`, dave);
    assert.equal(stream.status, 200);
    const token = storageToken("workspaces|dave", ws);
    await ok(200, "GET", `/files?node=${node}`, { headers: token });
    try {
      // An Admin removes Members only.
      await ok(403, "DELETE", `/workspaces/${ws}/members/${ids.erin}`, { headers: carol });
      const removed = await ok<{ removed: { grants: number; groups: number } }>(200, "DELETE", `/workspaces/${ws}/members/${ids.dave}`, { headers: carol });
      assert.deepEqual(removed.removed, { grants: 2, groups: 1, collaborations: 0 });
      await ok(404, "GET", "/nodes", { headers: as(dave) });
      await ok(404, "GET", `/files?node=${node}`, { headers: token });
      await ok(200, "PUT", `/files/notes/after-removal.md?node=${node}`, { headers: as(erin), body: "x" });
      const end = Date.now() + 3000;
      while (!stream.closed() && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
      assert.ok(stream.closed(), "the removed member's stream closes");
      assert.ok(!stream.events.some(onFile(node, "notes/after-removal.md")));
    } finally {
      stream.stop();
    }
    // Their draft stays private; their shared Experiment stays.
    await ok(404, "GET", `/experiments/${draft}`, { headers: as(erin) });
    await ok(200, "GET", `/experiments/${shared}`, { headers: as(erin) });
    const group = await ok<{ groups: { id: string; members?: string[] }[] }>(200, "GET", "/access/groups", { headers: as(erin) });
    assert.ok(!JSON.stringify(group.groups.find((x) => x.id === g)).includes(ids.dave), "no longer in the group");

    // Added again, they start from the starting grant: the old editor grant is gone.
    await ok(201, "POST", `/workspaces/${ws}/members`, { headers: erin, json: { userId: ids.dave, role: "member", access: "none" } });
    const back = await req("GET", `/files?node=${node}`, { headers: as(dave) });
    assert.ok([403, 404].includes(back.status), `no access until shared again, got ${back.status}`);
  });

  test("anyone may leave, except the last Owner", async () => {
    need();
    await ok(200, "DELETE", `/workspaces/${ws}/members/${ids.dave}`, { headers: dave });
    await ok(404, "GET", `/workspaces/${ws}`, { headers: dave });
    await ok(409, "DELETE", `/workspaces/${ws}/members/${ids.erin}`, { headers: erin });
    const log = await ok<{ entries: { action: string }[] }>(200, "GET", "/access/audit", { headers: as(erin) });
    const actions = new Set(log.entries.map((e) => e.action));
    for (const action of ["member.role", "member.remove", "member.leave"]) assert.ok(actions.has(action), action);
  });

  test("an Owner renames, archives and restores; archived workspaces vanish for everyone else", async () => {
    need();
    await ok(200, "PATCH", `/workspaces/${ws}`, { headers: carol, json: { name: `Renamed ${stamp}` } });
    await ok(403, "PATCH", `/workspaces/${ws}`, { headers: carol, json: { status: "archived" } });
    const stream = await watch(`/files?watch&workspace=${ws}`, carol);
    assert.equal(stream.status, 200);
    try {
      const archived = await ok<{ status: string }>(200, "PATCH", `/workspaces/${ws}`, { headers: erin, json: { status: "archived" } });
      assert.equal(archived.status, "archived");
      const end = Date.now() + 3000;
      while (!stream.closed() && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
      assert.ok(stream.closed(), "an open stream closes when its workspace is archived");
    } finally {
      stream.stop();
    }
    await ok(404, "GET", "/nodes", { headers: as(carol) });
    await ok(404, "GET", "/nodes", { headers: as(erin) });
    for (const who of [carol, erin]) {
      const { workspaces } = await ok<{ workspaces: { id: string }[] }>(200, "GET", "/workspaces", { headers: who });
      assert.ok(!workspaces.some((w) => w.id === ws), "gone from the switcher");
    }
    const carols = await ok<{ workspaces: { id: string }[] }>(200, "GET", "/workspaces?archived=true", { headers: carol });
    assert.ok(!carols.workspaces.some((w) => w.id === ws), "an Admin doesn't see it archived");
    const erins = await ok<{ workspaces: { id: string; status: string }[] }>(200, "GET", "/workspaces?archived=true", { headers: erin });
    assert.equal(erins.workspaces.find((w) => w.id === ws)?.status, "archived");
    await ok(404, "PATCH", `/workspaces/${ws}`, { headers: carol, json: { status: "active" } });
    await ok(200, "PATCH", `/workspaces/${ws}`, { headers: erin, json: { status: "active" } });
    await ok(200, "GET", "/nodes", { headers: as(carol) });
    const log = await ok<{ entries: { action: string }[] }>(200, "GET", "/access/audit", { headers: as(erin) });
    const actions = new Set(log.entries.map((e) => e.action));
    for (const action of ["workspace.rename", "workspace.archive", "workspace.restore"]) assert.ok(actions.has(action), action);
  });
});

interface Experiment {
  id: string;
  status: string;
  authorId: string;
  maintainerId: string;
  maintainerIsMember: boolean;
  collaborators: { id: string; name: string | null }[];
  access: string;
  mine: boolean;
}
const collaboratorIds = (e: Experiment | null) => (e?.collaborators ?? []).map((c) => c.id).sort();

describe("workspaces: Experiment handover (#255)", { skip: !enabled && "STORAGE_URL and AUTH_SECRET not set" }, () => {
  // In the default workspace: carol and dave view the node, erin doesn't.
  let node = "";
  let daveGrant = "";
  let draft = "";
  const need = () => assert.ok(node && draft, "needs the first test to pass");
  const create = async (who: Headers, title: string, shared = false, headers: Headers = {}) => {
    const e = await ok<Experiment>(201, "POST", "/experiments", { headers: { ...who, ...headers }, json: { nodeId: node, title } });
    if (shared) await ok(200, "PATCH", `/experiments/${e.id}`, { headers: { ...who, ...headers }, json: { status: "shared" } });
    return e.id;
  };
  const collaborator = (who: Headers, exp: string, userId: string, method: "PUT" | "DELETE", status = 200) =>
    ok<{ experiment: Experiment | null }>(status, method, `/experiments/${exp}/collaborators/${userId}`, { headers: who });
  const handOver = (who: Headers, exp: string, userId: string, status = 200, keepAsCollaborator?: boolean) =>
    ok<{ experiment: Experiment | null }>(status, "PUT", `/experiments/${exp}/maintainer`, {
      headers: who,
      json: { userId, ...(keepAsCollaborator !== undefined && { keepAsCollaborator }) },
    });

  test("a collaborator edits it, but doesn't change its status, delete it or choose who works on it", async () => {
    node = (await ok<{ id: string }>(201, "POST", "/nodes", { headers: owner, json: { parentId: null, name: `Handover ${stamp}` } })).id;
    await grant(node, ids.carol, "viewer");
    daveGrant = (await grant(node, ids.dave, "viewer")).id;
    draft = await create(carol, "Carol's draft");
    await ok(404, "GET", `/experiments/${draft}`, { headers: dave });

    const added = await collaborator(carol, draft, ids.dave, "PUT");
    assert.deepEqual(collaboratorIds(added.experiment), [ids.dave]);
    const seen = await ok<Experiment>(200, "GET", `/experiments/${draft}`, { headers: dave });
    assert.equal(seen.access, "writer");
    assert.equal(seen.mine, false);
    assert.equal(seen.maintainerId, ids.carol);
    await ok(200, "PATCH", `/experiments/${draft}`, { headers: dave, json: { title: "Edited by dave" } });
    await ok(200, "PUT", `/files/notes/dave.md?experiment=${draft}`, { headers: dave, body: "dave's work" });
    await ok(403, "PATCH", `/experiments/${draft}`, { headers: dave, json: { status: "shared" } });
    await ok(403, "DELETE", `/experiments/${draft}`, { headers: dave });
    await collaborator(dave, draft, ids.erin, "PUT", 403);
    await handOver(dave, draft, ids.dave, 403);
    // Only members who can view its node: erin can't.
    await collaborator(carol, draft, ids.erin, "PUT", 400);
    await handOver(carol, draft, ids.erin, 400);
    // Claude doesn't choose who works on an experiment.
    await ok(403, "PUT", `/experiments/${draft}/collaborators/${ids.dave}`, { headers: storageToken("workspaces|carol") });
    await ok(403, "PUT", `/experiments/${draft}/maintainer`, { headers: storageToken("workspaces|carol"), json: { userId: ids.dave } });

    // A collaborator may leave; the draft is then out of sight.
    const left = await collaborator(dave, draft, ids.dave, "DELETE");
    assert.equal(left.experiment, null);
    await ok(404, "GET", `/experiments/${draft}`, { headers: dave });
  });

  test("losing access to the node ends a collaborator's access", async () => {
    need();
    await collaborator(carol, draft, ids.dave, "PUT");
    await ok(200, "DELETE", `/access/grants/${daveGrant}`, { headers: owner });
    await ok(404, "GET", `/experiments/${draft}`, { headers: dave });
    const write = await req("PUT", `/files/notes/dave.md?experiment=${draft}`, { headers: dave, body: "still here?" });
    assert.ok([403, 404].includes(write.status), `no writes without the node, got ${write.status}`);
    daveGrant = (await grant(node, ids.dave, "viewer")).id;
    await ok(200, "GET", `/experiments/${draft}`, { headers: dave });
  });

  test("the maintainer hands over and stays on, unless they choose not to; the author never changes", async () => {
    need();
    const handed = (await handOver(carol, draft, ids.dave)).experiment!;
    assert.equal(handed.maintainerId, ids.dave);
    assert.equal(handed.authorId, ids.carol);
    assert.equal(handed.mine, false);
    assert.deepEqual(collaboratorIds(handed), [ids.carol], "carol stays on; dave is no longer a collaborator");
    await ok(403, "PATCH", `/experiments/${draft}`, { headers: carol, json: { status: "shared" } });
    await ok(200, "PATCH", `/experiments/${draft}`, { headers: carol, json: { title: "Still carol's work too" } });
    const mine = await ok<Experiment>(200, "GET", `/experiments/${draft}`, { headers: dave });
    assert.equal(mine.mine, true);

    // Handing a draft over without staying on: it is out of sight.
    const other = await create(carol, "Carol hands this away");
    const gone = await handOver(carol, other, ids.dave, 200, false);
    assert.equal(gone.experiment, null);
    await ok(404, "GET", `/experiments/${other}`, { headers: carol });
    await ok(200, "GET", `/experiments/${other}`, { headers: dave });
  });

  test("whoever stops working on a draft hears it, so it closes for them; nobody else does", async () => {
    need();
    const exp = await create(carol, "Carol's draft for a while");
    await collaborator(carol, exp, ids.dave, "PUT");
    const daves = await watch("/files?watch", dave);
    const carols = await watch("/files?watch", carol);
    const erins = await watch("/files?watch", erin);
    try {
      // Removed as a collaborator: the draft is out of dave's sight, and he hears that.
      await collaborator(carol, exp, ids.dave, "DELETE");
      assert.ok(await daves.saw(onExperiment(exp)), "the removed collaborator must hear about it");
      // Handed over without staying on: carol hears it too.
      await handOver(carol, exp, ids.dave, 200, false);
      assert.ok(await carols.saw((e) => onExperiment(exp)(e) && Array.isArray(e.left) && e.left.includes(ids.carol)));
      await ok(200, "PUT", `/files/notes/marker-${stamp}.md?node=${node}`, { headers: owner, body: "marker" });
      assert.ok(await carols.saw(onFile(node, `notes/marker-${stamp}.md`)));
      assert.ok(!erins.events.some(onExperiment(exp)), "someone who can't see it hears nothing");
    } finally {
      daves.stop();
      carols.stop();
      erins.stop();
    }
  });

  test("an Owner or Admin hands over a shared Experiment, never a draft", async () => {
    need();
    const shared = await create(carol, "Carol's shared one", true);
    const privateOne = await create(carol, "Carol's other draft");
    await handOver(owner, privateOne, ids.dave, 404);
    await handOver(dave, shared, ids.dave, 403);
    const handed = (await handOver(owner, shared, ids.dave, 200, false)).experiment!;
    assert.equal(handed.maintainerId, ids.dave);
    assert.deepEqual(collaboratorIds(handed), []);
    const carols = await ok<Experiment>(200, "GET", `/experiments/${shared}`, { headers: carol });
    assert.equal(carols.access, "reader");
    const log = await ok<{ entries: { action: string }[] }>(200, "GET", "/access/audit", { headers: owner });
    const actions = new Set(log.entries.map((e) => e.action));
    for (const action of ["experiment.maintainer", "experiment.collaborator.add", "experiment.collaborator.remove"]) {
      assert.ok(actions.has(action), action);
    }
  });

  test("removal ends collaborator places for good; a re-added member gets back what they still maintain", async () => {
    // erin's own workspace: erin Owner, carol and dave Members who view everything.
    const ws = (await ok<{ id: string }>(201, "POST", "/workspaces", { headers: erin, json: { name: `Erin's handover lab ${stamp}` } })).id;
    const as = (who: Headers) => ({ ...who, ...inWs(ws) });
    await ok(201, "POST", `/workspaces/${ws}/members`, { headers: erin, json: { userId: ids.carol, role: "member", access: "viewer" } });
    await ok(201, "POST", `/workspaces/${ws}/members`, { headers: erin, json: { userId: ids.dave, role: "member", access: "viewer" } });
    node = (await ok<{ id: string }>(201, "POST", "/nodes", { headers: as(erin), json: { parentId: null, name: `Handover lab ${stamp}` } })).id;
    const handedLater = await create(dave, "Dave's, handed over after he leaves", true, inWs(ws));
    const keptByDave = await create(dave, "Dave's, still his", true, inWs(ws));
    const erins = await create(erin, "Erin's, dave helps", true, inWs(ws));
    await collaborator(as(erin), erins, ids.dave, "PUT");

    const preview = await ok<{ collaborations: number; experiments: { id: string }[] }>(200, "GET", `/workspaces/${ws}/members/${ids.dave}/removal`, { headers: erin });
    assert.equal(preview.collaborations, 1);
    assert.deepEqual(preview.experiments.map((e) => e.id).sort(), [handedLater, keptByDave].sort());
    const removed = await ok<{ removed: { collaborations: number } }>(200, "DELETE", `/workspaces/${ws}/members/${ids.dave}`, { headers: erin });
    assert.equal(removed.removed.collaborations, 1);

    // His Experiments wait for a new maintainer; handing one over doesn't keep him on.
    const waiting = await ok<Experiment>(200, "GET", `/experiments/${handedLater}`, { headers: as(erin) });
    assert.equal(waiting.maintainerIsMember, false);
    const handed = (await handOver(as(erin), handedLater, ids.carol)).experiment!;
    assert.equal(handed.maintainerId, ids.carol);
    assert.deepEqual(collaboratorIds(handed), [], "a departed maintainer doesn't become a collaborator");

    // Back again: what he still maintains is his; collaborator places and handed-over ones aren't.
    await ok(201, "POST", `/workspaces/${ws}/members`, { headers: erin, json: { userId: ids.dave, role: "member", access: "viewer" } });
    const kept = await ok<Experiment>(200, "GET", `/experiments/${keptByDave}`, { headers: as(dave) });
    assert.equal(kept.mine, true);
    assert.equal(kept.access, "writer");
    for (const id of [handedLater, erins]) {
      const e = await ok<Experiment>(200, "GET", `/experiments/${id}`, { headers: as(dave) });
      assert.equal(e.access, "reader", `${id}: only reads it now`);
    }
  });
});

describe("workspaces: inventory and Owner recovery (#255)", { skip: !enabled && "STORAGE_URL and AUTH_SECRET not set" }, () => {
  // A deployment admin (PLATFORM_ADMINS names workspaces|platform), and gina, who creates a
  // workspace and can then no longer sign in: her direct root Full access grant is its only one.
  const admin = user("workspaces|platform", "platform");
  const gina = user("workspaces|gina", "gina");
  let ws = "";
  let ginaId = "";
  let adminId = "";
  const as = (who: Headers) => ({ ...who, ...inWs(ws) });
  const need = () => assert.ok(ws && ginaId && adminId, "needs the first test to pass");
  type Entry = { id: string; status: string; memberCount: number; createdBy: { id: string } | null; owners: { id: string }[]; fullAccessHeld: boolean };
  const entry = async () => {
    const answer = await req<{ workspaces: Entry[] }>("GET", "/platform/workspaces", { headers: admin });
    assert.equal(answer.status, 200, answer.text.slice(0, 200));
    return { found: answer.data.workspaces.find((w) => w.id === ws)!, text: answer.text };
  };
  const addOwner = (json: Json, status: number, headers = admin) =>
    ok<{ workspace: Entry }>(status, "POST", `/platform/workspaces/${ws}/owners`, { headers, json });
  const rootOwners = async (headers: Headers) => {
    const { grants } = await ok<{ grants: { nodeId: string | null; principalId: string; role: string }[] }>(200, "GET", "/access/grants", { headers });
    return grants.filter((g) => g.nodeId === null && g.role === "owner").map((g) => g.principalId).sort();
  };

  test("setup: gina's workspace, with carol and dave as Members without access, and some content", async () => {
    for (const who of [admin, gina]) await ok(200, "GET", "/access", { headers: who });
    // Each asks for their own id: the member list has no login subjects to find them by.
    ginaId = (await ok<{ me: { id: string } }>(200, "GET", "/access", { headers: gina })).me.id;
    adminId = (await ok<{ me: { id: string } }>(200, "GET", "/access", { headers: admin })).me.id;
    ws = (await ok<{ id: string }>(201, "POST", "/workspaces", { headers: gina, json: { name: `Gina's lab ${stamp}` } })).id;
    for (const id of [ids.carol, ids.dave]) await ok(201, "POST", `/workspaces/${ws}/members`, { headers: gina, json: { userId: id, role: "member", access: "none" } });
    const node = (await ok<{ id: string }>(201, "POST", "/nodes", { headers: as(gina), json: { parentId: null, name: `Gina's secret node ${stamp}` } })).id;
    await ok(200, "PUT", `/files/notes/gina-secret-${stamp}.md?node=${node}`, { headers: as(gina), body: "private" });
  });

  test("the inventory is refused to anyone not in PLATFORM_ADMINS, and has no content", async () => {
    need();
    await ok(401, "GET", "/platform/workspaces");
    await ok(403, "GET", "/platform/workspaces", { headers: gina });
    await ok(403, "GET", "/platform/workspaces", { headers: storageToken("workspaces|platform") });
    await ok(403, "POST", `/platform/workspaces/${ws}/owners`, { headers: gina, json: { userId: ids.carol } });
    const { found, text } = await entry();
    const own = JSON.stringify(found);
    assert.equal(found.status, "active");
    assert.equal(found.memberCount, 3);
    assert.equal(found.createdBy?.id, ginaId);
    assert.deepEqual(found.owners.map((o) => o.id), [ginaId]);
    for (const content of [`Gina's secret node ${stamp}`, `gina-secret-${stamp}`]) assert.ok(!text.includes(content), `the inventory shows ${content}`);
    // Its Members aren't listed, only its Owners.
    for (const member of [ids.carol, ids.dave, "carol@example.com"]) assert.ok(!own.includes(member), `the entry shows ${member}`);
    // Being a deployment admin gives no membership.
    await ok(404, "GET", "/nodes", { headers: as(admin) });
  });

  test("recovery: an Owner added without fullAccess can't Share; one added with it can, and the grant is theirs alone", async () => {
    need();
    const carol1 = await addOwner({ userId: ids.carol }, 200);
    assert.deepEqual(carol1.workspace.owners.map((o) => o.id).sort(), [ginaId, ids.carol].sort());
    await ok(403, "POST", "/access/grants", { headers: as(carol), json: { node: null, principalType: "user", principalId: ids.dave, role: "viewer" } });

    await addOwner({ userId: ids.dave, fullAccess: true }, 200);
    await ok(200, "POST", "/access/grants", { headers: as(dave), json: { node: null, principalType: "user", principalId: ids.carol, role: "viewer" } });
    assert.deepEqual(await rootOwners(as(dave)), [ginaId, ids.dave].sort(), "only gina's and dave's Full access on the root");
    // Again: nothing changes, and nothing more is logged.
    const before = (await ok<{ entries: unknown[] }>(200, "GET", "/access/audit", { headers: as(dave) })).entries.length;
    await addOwner({ userId: ids.dave, fullAccess: true }, 200);
    assert.equal((await ok<{ entries: unknown[] }>(200, "GET", "/access/audit", { headers: as(dave) })).entries.length, before);

    // Audited in the workspace, with the deployment admin as the actor; still no access for them.
    const log = await ok<{ entries: { action: string; actorId: string | null; target: Json }[] }>(200, "GET", "/access/audit", { headers: as(dave) });
    const owners = log.entries.filter((e) => e.action === "platform.owner");
    assert.deepEqual(owners.map((e) => e.target.user).sort(), [ids.carol, ids.dave].sort());
    assert.ok(owners.every((e) => e.actorId === adminId && e.target.previous === "member"));
    const recovery = log.entries.filter((e) => e.action === "grant.set" && e.target.recovery === true);
    assert.deepEqual(recovery.map((e) => [e.actorId, e.target.principalId, e.target.role]), [[adminId, ids.dave, "owner"]]);
    await ok(404, "GET", "/nodes", { headers: as(admin) });
    await ok(404, "GET", `/workspaces/${ws}`, { headers: admin });
  });

  test("admins find who to add by the email they signed in with", async () => {
    need();
    const found = await ok<{ user: { id: string; name: string | null; email: string | null } }>(
      200, "GET", "/platform/users?email=CAROL@example.com", { headers: admin },
    );
    assert.equal(found.user.id, ids.carol);
    await ok(404, "GET", "/platform/users?email=nobody-yet@example.com", { headers: admin });
    await ok(404, "GET", "/platform/users?email=", { headers: admin });
    await ok(404, "GET", "/platform/users", { headers: admin });
    await ok(403, "GET", "/platform/users?email=carol@example.com", { headers: gina });
    await ok(405, "POST", "/platform/users", { headers: admin });
  });

  test("admins can't make themselves Owners, and unknown people or workspaces are refused", async () => {
    need();
    await addOwner({ userId: adminId, fullAccess: true }, 400);
    await addOwner({ userId: NO_SUCH_WORKSPACE }, 400);
    await addOwner({ userId: ids.carol, fullAccess: "yes" }, 400);
    await ok(404, "POST", `/platform/workspaces/${NO_SUCH_WORKSPACE}/owners`, { headers: admin, json: { userId: ids.carol } });
    await ok(405, "DELETE", "/platform/workspaces", { headers: admin });
  });

  test("an archived workspace stays in the inventory, and can be given an Owner", async () => {
    need();
    await ok(200, "PATCH", `/workspaces/${ws}`, { headers: dave, json: { status: "archived" } });
    assert.equal((await entry()).found.status, "archived");
    await addOwner({ userId: ids.erin }, 200);
    const { workspaces } = await ok<{ workspaces: { id: string; status: string }[] }>(200, "GET", "/workspaces?archived=true", { headers: erin });
    assert.equal(workspaces.find((w) => w.id === ws)?.status, "archived", "erin may restore it");
    await ok(200, "PATCH", `/workspaces/${ws}`, { headers: erin, json: { status: "active" } });
  });
});
