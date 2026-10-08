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

import { storageConfigFromEnv } from "./config";
import { connect } from "./db";
import type { WorkspaceEvent } from "./events";
import { createStorageHandler } from "./http";
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
      assert.ok(tree.includes(`- CMP [tech] id=${created.id} (0 files)`));
      assert.ok(tree.includes(`  - Pad wear [module] id=${child.id} (0 files)`));

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
