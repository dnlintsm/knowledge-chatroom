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
import { FileExistsError, ReadOnlyFileError, type FileEvent } from "./files";
import { initStorage, type Storage } from "./index";
import { createFileTools, numberLines } from "./tools";

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
    const events: FileEvent[] = [];
    const unsubscribe = await storage.files.subscribe((e) => events.push(e));
    await storage.files.write("notes/watched.md", text("hi"), { author: "agent" });
    await storage.files.remove("notes/watched.md");
    await storage.files.remove("notes/never-existed.md");
    await waitFor(() => events.length >= 2);
    unsubscribe();

    assert.equal(events.length, 2);
    assert.deepEqual(
      { ...events[0], sha256: undefined },
      { op: "write", path: "notes/watched.md", author: "agent", sha256: undefined },
    );
    assert.match(events[0].sha256!, /^[0-9a-f]{64}$/);
    assert.deepEqual(events[1], { op: "delete", path: "notes/watched.md" });
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
      tools = Object.fromEntries(createFileTools(() => storage.files).map((t) => [t.name, t]));
    });

    test("write_file records an agent version, read_file numbers lines", async () => {
      const written = await call("write_file", {
        path: "artifacts/tool.md",
        content: "line one\nline two",
      });
      assert.deepEqual(JSON.parse(written.text), {
        ok: true,
        path: "artifacts/tool.md",
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

    test("without storage, says whether it is off, starting or failed", async () => {
      const statusFor = async (state: "off" | "starting" | "failed") => {
        const handle = createFilesHandler(() => null, 1024, () => state);
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
