/**
 * Integration tests against real Postgres + S3. Skipped unless
 * TEST_DATABASE_URL is set; the S3 settings come from the usual S3_* vars
 * (docker compose up gives you both). The test database is wiped first.
 *
 *   TEST_DATABASE_URL=postgres://knowledge:knowledge@localhost:5432/knowledge_test \
 *   S3_ENDPOINT=http://localhost:8333 S3_ACCESS_KEY_ID=knowledge \
 *   S3_SECRET_ACCESS_KEY=knowledge-secret npm test
 */

import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";

import { S3BlobStore } from "./blobs";
import { storageConfigFromEnv } from "./config";
import { asUser as asDbUser, connect } from "./db";
import type { WorkspaceEvent } from "./events";
import { AccessError, ForbiddenError, type Principal } from "./access";
import { createStorageHandler } from "./http";
import { IDENTITY_HEADER, signIdentity, verifyIdentity } from "./identity";
import { NodeNotFoundError } from "./nodes";
import { FileExistsError, ReadOnlyFileError } from "./files";
import { initStorage, type Storage } from "./index";
import { createFileTools, formatTree, numberLines } from "./tools";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const text = (s: string) => new TextEncoder().encode(s);

async function waitFor(check: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("Timed out waiting");
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("storage", { skip: !TEST_DATABASE_URL && "TEST_DATABASE_URL not set" }, () => {
  let storage: Storage;

  before(async () => {
    const reset = connect(TEST_DATABASE_URL!);
    await reset`DROP SCHEMA public CASCADE`;
    await reset`CREATE SCHEMA public`;
    await reset.end();

    const config = storageConfigFromEnv({
      ...process.env,
      DATABASE_URL: TEST_DATABASE_URL,
      S3_BUCKET: process.env.S3_BUCKET || "knowledge-test",
    })!;
    storage = (await initStorage(config))!;
  });

  after(() => storage?.close());

  test("migrations are idempotent", async () => {
    const again = await initStorage(storage.config);
    assert.ok(again);
    await again.close();
  });

  test("writes and reads a text file", async () => {
    const info = await storage.files.write("/notes//hello.md", text("# Hi"));
    assert.equal(info.path, "notes/hello.md");
    assert.equal(info.kind, "note");
    assert.equal(info.mime, "text/markdown");
    assert.equal(info.size, 4);
    assert.equal(info.author, "user");

    const file = await storage.files.read("notes/hello.md");
    assert.equal(new TextDecoder().decode(file!.bytes), "# Hi");
  });

  test("keeps binary bytes intact", async () => {
    const bytes = new Uint8Array(256).map((_, i) => i);
    await storage.files.write("uploads/all-bytes.bin", bytes);
    const file = await storage.files.read("uploads/all-bytes.bin");
    assert.deepEqual(file!.bytes, bytes);
    assert.equal(file!.info.kind, "upload");
  });

  test("versions every change, skips identical writes", async () => {
    await storage.files.write("artifacts/report.md", text("v1"), { author: "agent" });
    await storage.files.write("artifacts/report.md", text("v1"), { author: "agent" });
    await storage.files.write("artifacts/report.md", text("v2"), { author: "user", authorId: "dan" });

    const versions = await storage.files.history("artifacts/report.md");
    assert.equal(versions!.length, 2);
    assert.equal(versions![0].author, "user");
    assert.equal(versions![0].authorId, "dan");
    assert.equal(versions![1].author, "agent");
  });

  test("stores identical content once", async () => {
    await storage.files.write("notes/a.txt", text("same"));
    await storage.files.write("notes/b.txt", text("same"));
    const [{ count }] = await storage.sql<{ count: string }[]>`
      SELECT count(*) FROM blobs
      WHERE sha256 = (SELECT blob_sha256 FROM file_versions v
                      JOIN files f ON f.current_version_id = v.id
                      WHERE f.path = 'notes/a.txt')`;
    assert.equal(Number(count), 1);
  });

  test("delete hides the file and frees the path", async () => {
    await storage.files.write("notes/tmp.md", text("old"));
    assert.equal(await storage.files.remove("notes/tmp.md"), true);
    assert.equal(await storage.files.read("notes/tmp.md"), null);
    assert.equal(await storage.files.remove("notes/tmp.md"), false);

    await storage.files.write("notes/tmp.md", text("new"));
    assert.equal((await storage.files.history("notes/tmp.md"))!.length, 1);
  });

  test("rejects paths that escape the tree", async () => {
    for (const bad of ["", "../etc/passwd", "notes/../../x", "notes/", "a/./b"]) {
      await assert.rejects(storage.files.write(bad, text("x")), /Invalid path/);
    }
  });

  test("create-only writes never replace a file", async () => {
    await storage.files.write("runs/r1/a.md", text("first"), { createOnly: true });
    await assert.rejects(
      storage.files.write("runs/r1/a.md", text("second"), { createOnly: true }),
      FileExistsError,
    );
    const file = await storage.files.read("runs/r1/a.md");
    assert.equal(new TextDecoder().decode(file!.bytes), "first");
    // Only one of several racing creators wins.
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, (_, i) =>
        storage.files.write("runs/r1/race.md", text(`creator ${i}`), { createOnly: true }),
      ),
    );
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  });

  test("read-only files can't be changed or deleted", async () => {
    const info = await storage.files.write("runs/r1/models/general_rules.md", text("# Rules"), {
      createOnly: true,
      readOnly: true,
    });
    assert.equal(info.readOnly, true);
    await assert.rejects(
      storage.files.write("runs/r1/models/general_rules.md", text("changed")),
      ReadOnlyFileError,
    );
    await assert.rejects(storage.files.remove("runs/r1/models/general_rules.md"), ReadOnlyFileError);
    const listed = (await storage.files.list()).find((f) => f.path === "runs/r1/models/general_rules.md");
    assert.equal(listed?.readOnly, true);
    assert.equal((await storage.files.history("runs/r1/models/general_rules.md"))!.length, 1);
    // The flag only applies when creating.
    await storage.files.write("notes/plain.md", text("a"));
    assert.equal((await storage.files.write("notes/plain.md", text("b"), { readOnly: true })).readOnly, false);
  });

  test("concurrent writes to a new path do not collide", async () => {
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        storage.files.write("notes/race.md", text(`writer ${i}`)),
      ),
    );
    const list = (await storage.files.list()).filter((f) => f.path === "notes/race.md");
    assert.equal(list.length, 1);
    assert.equal((await storage.files.history("notes/race.md"))!.length, 8);
  });

  test("subscribers hear committed writes and deletes", async () => {
    const events: WorkspaceEvent[] = [];
    const unsubscribe = await storage.events.subscribe((e) => events.push(e));
    await storage.files.write("notes/watched.md", text("hi"), { author: "agent" });
    await storage.files.remove("notes/watched.md");
    await storage.files.remove("notes/never-existed.md");
    await waitFor(() => events.length >= 2);
    unsubscribe();

    assert.equal(events.length, 2);
    assert.deepEqual(
      { ...events[0], sha256: undefined },
      { op: "write", node: null, path: "notes/watched.md", author: "agent", sha256: undefined },
    );
    assert.match((events[0] as { sha256: string }).sha256, /^[0-9a-f]{64}$/);
    assert.deepEqual(events[1], { op: "delete", node: null, path: "notes/watched.md" });
  });

  describe("knowledge tree", () => {
    test("levels go tech › module › loop › process, one at a time", async () => {
      assert.deepEqual(
        (await storage.nodes.types()).map((t) => t.name),
        ["tech", "module", "loop", "process"],
      );
      const tech = await storage.nodes.create(null, "  Etch  ");
      assert.equal(tech.name, "Etch");
      assert.equal(tech.type, "tech");
      const mod = await storage.nodes.create(tech.id, "Module 3");
      const loop = await storage.nodes.create(mod.id, "Endpoint");
      const proc = await storage.nodes.create(loop.id, "Recipe tuning");
      assert.equal(proc.type, "process");
      assert.equal(proc.parentId, loop.id);

      await assert.rejects(storage.nodes.create(proc.id, "Too deep"), /below a process/);
      await assert.rejects(storage.nodes.create(tech.id, "module 3"), /already exists/);
      await assert.rejects(storage.nodes.create(null, " "), /needs a name/);
      await assert.rejects(
        storage.nodes.create("00000000-0000-0000-0000-000000000000", "x"),
        /Parent node not found/,
      );
      // The same name is fine under another parent.
      const other = await storage.nodes.create(null, "Litho");
      await storage.nodes.create(other.id, "Module 3");

      const lineage = await storage.nodes.lineage(proc.id);
      assert.deepEqual(lineage!.map((n) => n.name), ["Etch", "Module 3", "Endpoint", "Recipe tuning"]);
    });

    test("the database refuses a node at the wrong level", async () => {
      const tech = await storage.nodes.create(null, "Deposition");
      await assert.rejects(
        storage.sql`
          INSERT INTO nodes (workspace_id, parent_id, type_id, name)
          SELECT n.workspace_id, n.id, t.id, 'skips a level'
          FROM nodes n JOIN node_types t ON t.workspace_id = n.workspace_id AND t.depth = 3
          WHERE n.id = ${tech.id}`,
        /exactly one level below/,
      );
    });

    test("each node has its own files; deleting a node removes its subtree", async () => {
      const tech = await storage.nodes.create(null, "Implant");
      const mod = await storage.nodes.create(tech.id, "Beamline");
      const techFiles = (await storage.files.inNode(tech.id))!;
      const modFiles = (await storage.files.inNode(mod.id))!;

      await storage.files.write("notes/overview.md", text("root"));
      await techFiles.write("notes/overview.md", text("tech"));
      await modFiles.write("notes/overview.md", text("module"));
      const read = async (files: typeof techFiles) =>
        new TextDecoder().decode((await files.read("notes/overview.md"))!.bytes);
      assert.equal(await read(storage.files), "root");
      assert.equal(await read(techFiles), "tech");
      assert.equal(await read(modFiles), "module");
      assert.deepEqual((await modFiles.list()).map((f) => f.path), ["notes/overview.md"]);
      assert.equal((await storage.nodes.get(tech.id))!.fileCount, 1);

      // Renaming changes nothing else.
      await storage.nodes.rename(tech.id, "Ion implant");
      assert.equal(await read(techFiles), "tech");

      assert.equal(await storage.nodes.remove(tech.id), true);
      assert.equal(await storage.nodes.get(mod.id), null);
      assert.equal(await modFiles.read("notes/overview.md"), null);
      assert.equal(await storage.files.inNode(mod.id), null);
      await assert.rejects(modFiles.write("notes/late.md", text("x")), /Node not found/);
      assert.equal(await read(storage.files), "root");
      assert.equal(await storage.nodes.remove(tech.id), false);
    });

    test("events name the node", async () => {
      const events: WorkspaceEvent[] = [];
      const unsubscribe = await storage.events.subscribe((e) => events.push(e));
      const tech = await storage.nodes.create(null, "Metrology");
      await (await storage.files.inNode(tech.id))!.write("notes/a.md", text("x"));
      await waitFor(() => events.length >= 2);
      unsubscribe();
      assert.deepEqual(events[0], { op: "node", change: "create", id: tech.id });
      assert.equal(events[1].op, "write");
      assert.equal((events[1] as { node: string }).node, tech.id);
    });
  });

  describe("access control", () => {
    const as = (userId: string, actor: Principal["actor"] = "user") =>
      storage.session({ userId, actor });
    let alice: string, bob: string, carol: string;
    let techX: string, moduleX: string, techY: string;
    let dept: string;

    before(async () => {
      // The first person to sign in owns the workspace; later ones get nothing.
      alice = await storage.access.userForSubject("test|alice", { name: "Alice" });
      bob = await storage.access.userForSubject("test|bob", { name: "Bob", email: "bob@example.com" });
      carol = await storage.access.userForSubject("test|carol");

      const owner = as(alice);
      techX = (await owner.createNode(null, "Tech X")).id;
      moduleX = (await owner.createNode(techX, "Module X")).id;
      techY = (await owner.createNode(null, "Tech Y")).id;
      await (await owner.files(moduleX)).write("notes/x.md", text("x"));

      // company › etch dept › team; bob is in the team.
      const company = await owner.createGroup(null, "Company");
      dept = await owner.createGroup(company, "Etch dept");
      const team = await owner.createGroup(dept, "Endpoint team");
      await owner.setMember(team, bob, true);
      await owner.setGrant(techX, "group", dept, "editor");
    });

    test("the first signed-in user owns the workspace", async () => {
      assert.equal(await as(alice).role(null), "owner");
      assert.equal(await as(bob).role(null), null);
      assert.equal(await as(await storage.access.localUserId()).role(null), "owner");
      // Signing in again finds the same user.
      assert.equal(await storage.access.userForSubject("test|bob"), bob);
    });

    test("grants inherit down both trees", async () => {
      // Granted to the dept on Tech X; bob is in a team under the dept.
      assert.equal(await as(bob).role(techX), "editor");
      assert.equal(await as(bob).role(moduleX), "editor");
      assert.equal(await as(bob).role(techY), null);
      assert.equal(await as(carol).role(moduleX), null);
    });

    test("roles are additive: the best grant wins", async () => {
      const grant = await as(alice).setGrant(moduleX, "user", bob, "viewer");
      assert.equal(await as(bob).role(moduleX), "editor");
      await as(alice).setGrant(moduleX, "user", bob, "owner"); // replaces the viewer grant
      assert.equal(await as(bob).role(moduleX), "owner");
      assert.equal(await as(bob).role(techX), "editor");
      assert.equal(await as(alice).revoke(grant), true);
      assert.equal(await as(bob).role(moduleX), "editor");
    });

    test("the tree shows only what you can see, and the path to it", async () => {
      const bobTree = await as(bob).tree();
      assert.equal(bobTree.rootRole, null);
      assert.deepEqual(bobTree.nodes.map((n) => [n.name, n.role]), [
        ["Tech X", "editor"],
        ["Module X", "editor"],
      ]);

      await as(alice).setGrant(moduleX, "user", carol, "viewer");
      const carolTree = await as(carol).tree();
      assert.deepEqual(carolTree.nodes.map((n) => [n.name, n.role, n.fileCount]), [
        ["Tech X", null, 0],
        ["Module X", "viewer", 1],
      ]);
      await assert.rejects(as(carol).files(techX), NodeNotFoundError);
      await assert.rejects(as(carol).lineage(techY), NodeNotFoundError);
    });

    test("viewers read, editors write, owners delete", async () => {
      const carolFiles = await as(carol).files(moduleX);
      assert.ok(await carolFiles.read("notes/x.md"));
      await assert.rejects(carolFiles.write("notes/x.md", text("no")), ForbiddenError);
      await assert.rejects(carolFiles.remove("notes/x.md"), ForbiddenError);
      await assert.rejects(as(carol).createNode(moduleX, "Loop"), ForbiddenError);

      const bobFiles = await as(bob).files(moduleX);
      const info = await bobFiles.write("notes/bob.md", text("from bob"));
      assert.equal(info.author, "user");
      const [version] = (await bobFiles.history("notes/bob.md"))!;
      assert.equal(version.authorId, bob);
      await as(bob).createNode(moduleX, "Loop B");
      await assert.rejects(as(bob).deleteNode(moduleX), ForbiddenError);
      await assert.rejects(as(bob).files(null), ForbiddenError);
      await assert.rejects(as(bob).createNode(null, "Tech Z"), ForbiddenError);
      await assert.rejects(as(bob).createGroup(null, "Mine"), ForbiddenError);
      await assert.rejects(as(bob).setGrant(techX, "user", bob, "owner"), ForbiddenError);
    });

    test("Claude acts with the user's access and is recorded as the agent", async () => {
      const claude = as(bob, "agent");
      const info = await (await claude.files(moduleX)).write("artifacts/claude.md", text("hi"));
      assert.equal(info.author, "agent");
      await assert.rejects(claude.files(techY), NodeNotFoundError);
    });

    test("the workspace always keeps an owner who can sign in", async () => {
      const ownGrant = (await as(alice).grants(null)).find(
        (g) => g.principalType === "user" && g.principalId === alice,
      )!;
      await assert.rejects(as(alice).revoke(ownGrant.id), AccessError);
      await assert.rejects(as(alice).setGrant(null, "user", alice, "editor"), AccessError);
      await as(alice).setGrant(null, "user", carol, "owner");
      assert.equal(await as(alice).revoke(ownGrant.id), true);
      assert.equal(await as(alice).role(null), null);
      // Put things back for the other tests.
      await as(carol).setGrant(null, "user", alice, "owner");
      await as(alice).revoke((await as(alice).grants(null)).find((g) => g.principalId === carol)!.id);
    });

    test("deleting a group removes its grants", async () => {
      const temp = await as(alice).createGroup(null, "Temp");
      await as(alice).setMember(temp, carol, true);
      await as(alice).setGrant(techY, "group", temp, "viewer");
      assert.equal(await as(carol).role(techY), "viewer");
      assert.equal(await as(alice).deleteGroup(temp), true);
      assert.equal(await as(carol).role(techY), null);
      assert.equal((await as(alice).grants(techY)).length, 0);
    });

    test("changes are audited with who made them", async () => {
      const log = await as(alice).auditLog(500);
      const bobWrite = log.find((e) => e.action === "file.write" && e.target.path === "notes/bob.md")!;
      assert.equal(bobWrite.actorId, bob);
      assert.equal(bobWrite.actorType, "user");
      assert.equal(bobWrite.target.node, moduleX);
      const claudeWrite = log.find((e) => e.target.path === "artifacts/claude.md")!;
      assert.equal(claudeWrite.actorType, "agent");
      assert.equal(claudeWrite.actorId, bob);
      assert.ok(log.some((e) => e.action === "grant.set" && e.target.principalId === dept));
      await assert.rejects(as(bob).auditLog(), ForbiddenError);
    });

    test("watchers only hear about places they can see", async () => {
      const bobSession = as(bob);
      assert.equal(await bobSession.canSee({ op: "write", node: moduleX, path: "a" }), true);
      assert.equal(await bobSession.canSee({ op: "write", node: techY, path: "a" }), false);
      assert.equal(await bobSession.canSee({ op: "delete", node: null, path: "a" }), false);
      assert.equal(await bobSession.canSee({ op: "node", change: "rename", id: techX }), true);
      assert.equal(await bobSession.canSee({ op: "node", change: "rename", id: techY }), false);
      // Carol only sees Module X, so Tech X is the path to it.
      assert.equal(await as(carol).canSee({ op: "node", change: "rename", id: techX }), true);
    });

    test("signed identities", () => {
      const secret = "s".repeat(32);
      const exp = Math.floor(Date.now() / 1000) + 60;
      const token = signIdentity({ sub: "test|bob", exp }, secret);
      assert.equal(verifyIdentity(token, secret)?.sub, "test|bob");
      assert.equal(verifyIdentity(token, "t".repeat(32)), null);
      assert.equal(verifyIdentity(token.replace(/\.[^.]+\./, ".e30."), secret), null);
      assert.equal(verifyIdentity(signIdentity({ sub: "test|bob", exp: 1 }, secret), secret), null);
      assert.equal(verifyIdentity(signIdentity({ sub: "local", exp }, secret), secret), null);
    });

    test("with login on, the API answers as the signed-in user", async () => {
      const secret = "k".repeat(32);
      const signed = { ...storage, config: { ...storage.config, authSecret: secret } };
      const handle = createStorageHandler(() => signed, 1024);
      const srv = http.createServer((req, res) => handle(req, res, new URL(req.url!, "http://localhost")));
      await new Promise<void>((resolve) => srv.listen(0, resolve));
      const url = `http://localhost:${(srv.address() as AddressInfo).port}`;
      const exp = Math.floor(Date.now() / 1000) + 60;
      const asUser = (sub: string) => ({ [IDENTITY_HEADER]: signIdentity({ sub, exp }, secret) });
      try {
        assert.equal((await fetch(`${url}/nodes`)).status, 401);
        assert.equal((await fetch(`${url}/files`, { headers: { [IDENTITY_HEADER]: "v1.bad.sig" } })).status, 401);

        const tree = (await (await fetch(`${url}/nodes`, { headers: asUser("test|bob") })).json()) as {
          nodes: { name: string }[];
        };
        assert.deepEqual(tree.nodes.map((n) => n.name).slice(0, 2), ["Tech X", "Module X"]);
        assert.equal((await fetch(`${url}/files`, { headers: asUser("test|bob") })).status, 403);
        assert.equal((await fetch(`${url}/files?node=${techY}`, { headers: asUser("test|bob") })).status, 404);
        const put = await fetch(`${url}/files/notes/api.md?node=${moduleX}`, {
          method: "PUT",
          headers: asUser("test|carol"),
          body: "x",
        });
        assert.equal(put.status, 403);

        const me = (await (await fetch(`${url}/access`, { headers: asUser("test|alice") })).json()) as {
          me: { id: string };
          rootRole: string;
        };
        assert.deepEqual([me.me.id, me.rootRole], [alice, "owner"]);
        const grant = await fetch(`${url}/access/grants`, {
          method: "POST",
          headers: { ...asUser("test|alice"), "Content-Type": "application/json" },
          body: JSON.stringify({ node: techY, principalType: "user", principalId: carol, role: "viewer" }),
        });
        assert.equal(grant.status, 200);
        assert.equal(await as(carol).role(techY), "viewer");
        assert.equal((await fetch(`${url}/access/audit`, { headers: asUser("test|bob") })).status, 403);
        const groups = (await (await fetch(`${url}/access/groups`, { headers: asUser("test|bob") })).json()) as {
          groups: { name: string }[];
        };
        assert.ok(groups.groups.some((g) => g.name === "Etch dept"));
      } finally {
        await new Promise<void>((resolve) => srv.close(() => resolve()));
      }
    });

    test("Postgres enforces access too, even with the app's checks skipped", async () => {
      assert.equal(storage.rowSecurity, true, "the test database user should be able to use knowledge_user");
      await (await as(alice).files(techY)).write("notes/y.md", text("secret"));
      const filesIn = async (node: string | null) => (await storage.files.inNode(node))!;

      // Straight to the services as bob, without Session's checks.
      await asDbUser(storage.sql, bob, async (db) => {
        const nodes = await storage.nodes.withSql(db).list();
        assert.ok(nodes.some((n) => n.id === techX));
        assert.ok(!nodes.some((n) => n.id === techY));
        const inY = (await filesIn(techY)).withSql(db);
        assert.deepEqual(await inY.list(), []);
        assert.equal(await inY.remove("notes/y.md"), false);
        assert.equal(await storage.nodes.withSql(db).rename(techY, "Mine now"), null);
      });
      // Bob edits Tech X, so he may rename it, but deleting it needs owner.
      await assert.rejects(
        asDbUser(storage.sql, bob, (db) => storage.nodes.withSql(db).remove(techX)),
        /row-level security/,
      );
      assert.ok(await storage.nodes.get(techX));
      await assert.rejects(
        asDbUser(storage.sql, bob, async (db) =>
          (await filesIn(techY)).withSql(db).write("notes/z.md", text("z")),
        ),
      );
      // No role at the root: nothing can be added there.
      await assert.rejects(
        asDbUser(storage.sql, carol, async (db) => (await filesIn(null)).withSql(db).write("x.md", text("x"))),
        /row-level security/,
      );
      await assert.rejects(
        asDbUser(storage.sql, carol, (db) => storage.nodes.withSql(db).create(null, "Carol's")),
        /row-level security/,
      );

      const y = await filesIn(techY);
      assert.equal((await y.read("notes/y.md"))?.bytes.length, 6);
      assert.equal(await y.stat("notes/z.md"), null);
      assert.equal((await storage.nodes.get(techY))?.name, "Tech Y");
    });
  });

  describe("Claude's file tools", () => {
    type Tool = ReturnType<typeof createFileTools>[number];
    let tools: Record<string, Tool>;
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const result = (await tools[name].handler(args as never, {})) as {
        content: { text: string }[];
        isError?: boolean;
      };
      return { text: result.content[0].text, isError: Boolean(result.isError) };
    };

    before(() => {
      tools = Object.fromEntries(createFileTools(() => storage).map((t) => [t.name, t]));
    });

    test("write_file records an agent version, read_file numbers lines", async () => {
      const written = await call("write_file", {
        path: "artifacts/tool.md",
        content: "line one\nline two",
      });
      assert.deepEqual(JSON.parse(written.text), {
        ok: true,
        path: "artifacts/tool.md",
        node: null,
        created: true,
      });
      assert.equal((await storage.files.stat("artifacts/tool.md"))!.author, "agent");

      const read = await call("read_file", { path: "artifacts/tool.md" });
      assert.equal(read.text, `artifacts/tool.md\n${numberLines("line one\nline two")}`);

      const listed = JSON.parse((await call("list_files")).text) as { path: string }[];
      assert.ok(listed.some((f) => f.path === "artifacts/tool.md"));
    });

    test("errors are reported, not thrown", async () => {
      assert.equal((await call("read_file", { path: "notes/missing.md" })).isError, true);
      assert.equal((await call("write_file", { path: "../x", content: "" })).isError, true);
      const offline = createFileTools(() => null)[0];
      const result = (await offline.handler({} as never, {})) as { isError?: boolean };
      assert.equal(result.isError, true);
    });

    test("write_file refuses read-only files", async () => {
      await storage.files.write("runs/r2/models/general_rules.md", text("# Rules"), { readOnly: true });
      const result = await call("write_file", { path: "runs/r2/models/general_rules.md", content: "x" });
      assert.equal(result.isError, true);
      assert.match(result.text, /read-only/);
      const listed = JSON.parse((await call("list_files")).text) as { path: string; readOnly?: boolean }[];
      assert.equal(listed.find((f) => f.path === "runs/r2/models/general_rules.md")?.readOnly, true);
    });

    test("tools made for a user can do only what that user can", async () => {
      const local = await storage.access.localUserId();
      const viewer = await storage.access.userForSubject("test|tool-viewer");
      await storage.access.setGrant(null, "user", viewer, "viewer", local);
      assert.equal(await storage.access.role(viewer, null), "viewer");
      const toolsFor = (user: string | null) =>
        Object.fromEntries(createFileTools(() => storage, async () => user).map((t) => [t.name, t]));
      const run = async (user: string | null, name: string, args: Record<string, unknown>) =>
        (await toolsFor(user)[name].handler(args as never, {})) as {
          content: { text: string }[];
          isError?: boolean;
        };

      assert.equal((await run(viewer, "list_files", {})).isError, undefined);
      const denied = await run(viewer, "write_file", { path: "notes/viewer.md", content: "no" });
      assert.equal(denied.isError, true);
      assert.match(denied.content[0].text, /editor access/);
      assert.equal(await storage.files.stat("notes/viewer.md"), null);
      // No user (login on, but the run carried none): nothing at all.
      assert.equal((await run(null, "list_files", {})).isError, true);
    });

    test("list_nodes shows the tree; file tools work inside a node", async () => {
      const created = JSON.parse(
        (await call("create_node", { name: "CMP" })).text,
      ) as { id: string; type: string };
      assert.equal(created.type, "tech");
      const child = JSON.parse(
        (await call("create_node", { parentId: created.id, name: "Pad wear" })).text,
      ) as { id: string };

      const tree = (await call("list_nodes")).text;
      assert.match(tree, /^Levels: tech › module › loop › process/);
      assert.ok(tree.includes(`- CMP [tech] id=${created.id} (0 files, owner)`));
      assert.ok(tree.includes(`  - Pad wear [module] id=${child.id} (0 files, owner)`));

      await call("write_file", { node: child.id, path: "notes/wear.md", content: "worn" });
      assert.equal((await call("read_file", { path: "notes/wear.md" })).isError, true);
      const read = await call("read_file", { node: child.id, path: "notes/wear.md" });
      assert.equal(read.text, `notes/wear.md\n${numberLines("worn")}`);
      const missing = await call("list_files", { node: "not-a-node" });
      assert.equal(missing.isError, true);
      assert.match(missing.text, /list_nodes/);
    });

    test("binary files are described, not dumped", async () => {
      await storage.files.write("uploads/pic.png", new Uint8Array([137, 80, 78, 71]));
      const read = JSON.parse((await call("read_file", { path: "uploads/pic.png" })).text);
      assert.equal(read.mime, "image/png");
      assert.match(read.note, /Binary/);
    });
  });

  describe("HTTP API", () => {
    let server: http.Server;
    let base: string;

    before(async () => {
      const handle = createStorageHandler(() => storage, 1024);
      server = http.createServer((req, res) =>
        handle(req, res, new URL(req.url!, "http://localhost")),
      );
      await new Promise<void>((resolve) => server.listen(0, resolve));
      base = `http://localhost:${(server.address() as AddressInfo).port}`;
    });

    after(() => new Promise<void>((resolve) => server.close(() => resolve())));

    test("PUT, GET, list, versions, DELETE", async () => {
      const put = await fetch(`${base}/files/skills/my%20skill/SKILL.md`, {
        method: "PUT",
        headers: { "Content-Type": "text/markdown; charset=utf-8" },
        body: "---\nname: demo\n---",
      });
      assert.equal(put.status, 200);
      assert.equal(((await put.json()) as { kind: string }).kind, "skill");

      const get = await fetch(`${base}/files/skills/my%20skill/SKILL.md`);
      assert.equal(get.status, 200);
      assert.equal(get.headers.get("content-type"), "text/markdown");
      assert.equal(await get.text(), "---\nname: demo\n---");

      const etag = get.headers.get("etag")!;
      const cached = await fetch(`${base}/files/skills/my%20skill/SKILL.md`, {
        headers: { "If-None-Match": etag },
      });
      assert.equal(cached.status, 304);

      const { files } = (await (await fetch(`${base}/files`)).json()) as {
        files: { path: string }[];
      };
      assert.ok(files.some((f) => f.path === "skills/my skill/SKILL.md"));

      const { versions } = (await (
        await fetch(`${base}/files/skills/my%20skill/SKILL.md?versions`)
      ).json()) as { versions: unknown[] };
      assert.equal(versions.length, 1);

      const del = await fetch(`${base}/files/skills/my%20skill/SKILL.md`, { method: "DELETE" });
      assert.equal(del.status, 200);
      assert.equal((await fetch(`${base}/files/skills/my%20skill/SKILL.md`)).status, 404);
    });

    test("?watch streams changes as server-sent events", async () => {
      const controller = new AbortController();
      const res = await fetch(`${base}/files?watch`, { signal: controller.signal });
      assert.equal(res.headers.get("content-type"), "text/event-stream");
      const reader = res.body!.getReader();
      let received = "";
      await reader.read(); // ": watching" comment, sent once subscribed

      await storage.files.write("notes/streamed.md", text("x"));
      while (!received.includes("notes/streamed.md")) {
        received += new TextDecoder().decode((await reader.read()).value);
      }
      controller.abort();
      const event = JSON.parse(received.split("data: ")[1]);
      assert.equal(event.op, "write");
      assert.equal(event.author, "user");
    });

    test("nodes API and ?node= file routes", async () => {
      const send = (path: string, method: string, body?: unknown) =>
        fetch(`${base}${path}`, {
          method,
          headers: { "Content-Type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      const created = await send("/nodes", "POST", { parentId: null, name: "Wet clean" });
      assert.equal(created.status, 201);
      const tech = (await created.json()) as { id: string };
      const mod = (await (await send("/nodes", "POST", { parentId: tech.id, name: "SC1" })).json()) as {
        id: string;
      };

      const { types, nodes } = (await (await fetch(`${base}/nodes`)).json()) as {
        types: { name: string }[];
        nodes: { id: string }[];
      };
      assert.equal(types[0].name, "tech");
      assert.ok(nodes.some((n) => n.id === mod.id));

      const { lineage } = (await (await fetch(`${base}/nodes/${mod.id}`)).json()) as {
        lineage: { name: string }[];
      };
      assert.deepEqual(lineage.map((n) => n.name), ["Wet clean", "SC1"]);

      assert.equal((await send(`/nodes/${tech.id}`, "PATCH", { name: "Wet" })).status, 200);
      assert.equal((await send("/nodes", "POST", { parentId: tech.id, name: "sc1" })).status, 400);
      assert.equal((await send("/nodes", "POST", { name: 3 })).status, 400);

      const put = await fetch(`${base}/files/notes/bath.md?node=${mod.id}`, { method: "PUT", body: "hot" });
      assert.equal(put.status, 200);
      assert.equal(await (await fetch(`${base}/files/notes/bath.md?node=${mod.id}`)).text(), "hot");
      assert.equal((await fetch(`${base}/files/notes/bath.md`)).status, 404);
      const listed = (await (await fetch(`${base}/files?node=${mod.id}`)).json()) as {
        files: { path: string }[];
      };
      assert.deepEqual(listed.files.map((f) => f.path), ["notes/bath.md"]);

      assert.equal((await send(`/nodes/${tech.id}`, "DELETE")).status, 200);
      assert.equal((await fetch(`${base}/files?node=${mod.id}`)).status, 404);
      assert.equal((await fetch(`${base}/files?node=nope`)).status, 404);
      assert.equal((await fetch(`${base}/nodes/${mod.id}`)).status, 404);
    });

    test("binary downloads redirect to a signed store link when S3_PUBLIC_URL is set", async () => {
      const publicUrl = storage.config.s3.endpoint;
      if (!publicUrl) return; // AWS: nothing local to point browsers at.
      const linked = { ...storage, blobs: new S3BlobStore({ ...storage.config.s3, publicUrl }) };
      const handle = createStorageHandler(() => linked, 1024);
      const srv = http.createServer((req, res) => handle(req, res, new URL(req.url!, "http://localhost")));
      await new Promise<void>((resolve) => srv.listen(0, resolve));
      const url = `http://localhost:${(srv.address() as AddressInfo).port}`;
      try {
        const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
        await fetch(`${url}/files/uploads/pic.png`, {
          method: "PUT",
          headers: { "Content-Type": "image/png" },
          body: png,
        });
        const res = await fetch(`${url}/files/uploads/pic.png`, { redirect: "manual" });
        assert.equal(res.status, 302);
        const link = res.headers.get("location")!;
        assert.ok(link.startsWith(publicUrl), link);
        assert.match(link, /X-Amz-Expires=300/);
        const fromStore = await fetch(link);
        assert.equal(fromStore.status, 200);
        assert.equal(fromStore.headers.get("content-type"), "image/png");
        assert.deepEqual(new Uint8Array(await fromStore.arrayBuffer()), png);

        // Text is still served here (the UI fetches it from this origin).
        await fetch(`${url}/files/notes/plain.md`, { method: "PUT", body: "plain" });
        const text = await fetch(`${url}/files/notes/plain.md`, { redirect: "manual" });
        assert.equal(text.status, 200);
        assert.equal(await text.text(), "plain");
        assert.equal((await fetch(`${url}/files/uploads/missing.png`, { redirect: "manual" })).status, 404);
      } finally {
        await new Promise<void>((resolve) => srv.close(() => resolve()));
      }
    });

    test("without storage, says whether it is off, starting or failed", async () => {
      const statusFor = async (state: "off" | "starting" | "failed") => {
        const handle = createStorageHandler(() => null, 1024, () => state);
        const srv = http.createServer((req, res) =>
          handle(req, res, new URL(req.url!, "http://localhost")),
        );
        await new Promise<void>((resolve) => srv.listen(0, resolve));
        const port = (srv.address() as AddressInfo).port;
        const { status } = await fetch(`http://localhost:${port}/files`);
        await new Promise<void>((resolve) => srv.close(() => resolve()));
        return status;
      };
      assert.equal(await statusFor("off"), 404);
      assert.equal(await statusFor("starting"), 503);
      assert.equal(await statusFor("failed"), 500);
    });

    test("If-None-Match: * only creates; read-only files refuse PUT and DELETE", async () => {
      const url = `${base}/files/runs/r3/models/general_rules.md`;
      const create = () =>
        fetch(url, {
          method: "PUT",
          headers: { "Content-Type": "text/markdown", "If-None-Match": "*", "X-Read-Only": "true" },
          body: "# Rules",
        });
      const first = await create();
      assert.equal(first.status, 200);
      assert.equal(((await first.json()) as { readOnly: boolean }).readOnly, true);
      assert.equal((await create()).status, 412);

      const get = await fetch(url);
      assert.equal(get.headers.get("x-file-read-only"), "true");
      assert.equal(await get.text(), "# Rules");

      const put = await fetch(url, { method: "PUT", body: "changed" });
      assert.equal(put.status, 403);
      assert.equal((await fetch(url, { method: "DELETE" })).status, 403);
      assert.equal(await (await fetch(url)).text(), "# Rules");
    });

    test("rejects oversize uploads and bad paths", async () => {
      const big = await fetch(`${base}/files/uploads/big.bin`, {
        method: "PUT",
        body: new Uint8Array(2048),
      });
      assert.equal(big.status, 413);

      const bad = await fetch(`${base}/files/notes/..%2F..%2Fsecret`, { method: "PUT", body: "x" });
      assert.equal(bad.status, 400);
    });
  });
});
