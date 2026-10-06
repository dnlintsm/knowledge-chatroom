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
import { createFilesHandler } from "./http";
import { initStorage, type Storage } from "./index";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const text = (s: string) => new TextEncoder().encode(s);

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

  describe("HTTP API", () => {
    let server: http.Server;
    let base: string;

    before(async () => {
      const handle = createFilesHandler(() => storage.files, 1024);
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
