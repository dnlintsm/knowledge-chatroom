import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import { test } from "node:test";

import { agentRefusal, MAX_UPLOAD_META_BYTES, readUpload, UploadError } from "./http";

/** What Claude may do through a storage token (issue #88): what its own file tools do. */

const may = (method: string, path: string) => agentRefusal(method, new URL(path, "http://agent")) === null;

test("reading is allowed everywhere but the access admin routes", () => {
  for (const path of ["/files", "/files/a.md?node=n1", "/files?watch", "/nodes", "/experiments?node=n1", "/search?q=x", "/proposals", "/access"]) {
    assert.ok(may("GET", path), path);
  }
  for (const path of ["/access/people", "/access/grants", "/access/audit", "/access/groups"]) {
    assert.ok(!may("GET", path), path);
  }
});

test("writes in a node or to skills are proposals; experiments and root files are written", () => {
  assert.ok(!may("PUT", "/files/notes/a.md?node=n1"));
  assert.ok(may("PUT", "/files/notes/a.md?node=n1&propose"));
  assert.ok(may("PUT", "/files/notes/a.md?experiment=e1"));
  assert.ok(may("PUT", "/files/notes/a.md"));
  assert.ok(!may("PUT", "/files/skills/tldr/SKILL.md"));
  assert.ok(may("PUT", "/files/skills/tldr/SKILL.md?propose"));
});

test("nothing is renamed, deleted, reviewed or shared", () => {
  assert.ok(!may("PATCH", "/files/a.md"));
  assert.ok(!may("DELETE", "/files/a.md?experiment=e1"));
  assert.ok(may("POST", "/nodes"));
  assert.ok(!may("PATCH", "/nodes/n1"));
  assert.ok(!may("DELETE", "/nodes/n1"));
  assert.ok(may("POST", "/experiments"));
  // Uploading an experiment is for people: it may add nodes all the way down.
  assert.ok(!may("POST", "/experiments/upload"));
  assert.ok(may("PATCH", "/experiments/e1"));
  assert.ok(!may("DELETE", "/experiments/e1"));
  assert.ok(may("POST", "/proposals"));
  for (const action of ["accept", "reject", "withdraw"]) assert.ok(!may("POST", `/proposals/p1/${action}`), action);
  assert.ok(!may("POST", "/access/grants"));
  assert.ok(!may("DELETE", "/access/groups/g1"));
});

/** POST /experiments/upload bodies, read as they stream in. */

const BOUNDARY = "----upload-test";
const part = (name: string, opts: { filename?: string; type?: string } = {}) =>
  `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${name}"` +
  (opts.filename ? `; filename="${opts.filename}"` : "") +
  "\r\n" + (opts.type ? `Content-Type: ${opts.type}\r\n` : "") + "\r\n";
const META = JSON.stringify({ id: "0b8f6c2e-3d1a-4f5b-9c7e-2a4d6e8f0a1b", path: "A/B//", title: "T" });

/** A request whose body is `chunks`; `pulled` counts the bytes the parser asked for. */
function request(chunks: Iterable<string | Buffer>) {
  const counter = { pulled: 0 };
  const body = Readable.from(
    (function* () {
      for (const chunk of chunks) {
        const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
        counter.pulled += bytes.length;
        yield bytes;
      }
    })(),
  );
  const req = Object.assign(body, {
    headers: { "content-type": `multipart/form-data; boundary=${BOUNDARY}` },
  }) as unknown as IncomingMessage;
  return { req, counter };
}

const status = (err: unknown) => (err instanceof UploadError ? err.status : err);

test("reads the meta part and each file, named by its path", async () => {
  const longPath = `${"deep/".repeat(40)}trace.bin`; // longer than busboy's 100-byte name default
  const { req } = request([
    part("meta"), META, "\r\n",
    part("data/metrics.csv", { filename: "metrics.csv", type: "text/csv" }), "a,b\n1,2", "\r\n",
    part(longPath, { filename: "trace.bin", type: "application/octet-stream" }), Buffer.from([0, 255]), "\r\n",
    `--${BOUNDARY}--\r\n`,
  ]);
  const upload = await readUpload(req, 1024);
  assert.equal(upload.id, "0b8f6c2e-3d1a-4f5b-9c7e-2a4d6e8f0a1b");
  assert.deepEqual(upload.path, ["A", "B", "", ""]);
  assert.deepEqual(
    upload.files.map((f) => [f.path, f.mime, Buffer.from(f.bytes).toString("hex")]),
    [["data/metrics.csv", "text/csv", Buffer.from("a,b\n1,2").toString("hex")], [longPath, undefined, "00ff"]],
  );
});

test("a file of exactly the limit is fine; one byte more is refused", async () => {
  const body = (size: number) => [
    part("meta"), META, "\r\n",
    part("f.bin", { filename: "f.bin" }), Buffer.alloc(size), "\r\n", `--${BOUNDARY}--\r\n`,
  ];
  assert.equal((await readUpload(request(body(1024)).req, 1024)).files[0].bytes.length, 1024);
  await assert.rejects(readUpload(request(body(1025)).req, 1024), (err) => status(err) === 413);
});

test("an oversized file is refused while it streams, not after it is buffered", async () => {
  const { req, counter } = request(
    (function* () {
      yield part("meta") + META + "\r\n" + part("huge.bin", { filename: "huge.bin" });
      for (;;) yield Buffer.alloc(64 * 1024); // never ends
    })(),
  );
  await assert.rejects(readUpload(req, 1024 * 1024), (err) => status(err) === 413);
  assert.ok(counter.pulled < 4 * 1024 * 1024, `read ${counter.pulled} bytes`);
});

test("an oversized meta part is refused: as a file while it streams, as a field once it ends", async () => {
  const { req, counter } = request(
    (function* () {
      yield part("meta", { filename: "meta.json", type: "application/json" }) + '{"title":"';
      for (;;) yield "x".repeat(64 * 1024); // never ends
    })(),
  );
  await assert.rejects(readUpload(req, 1024 * 1024 * 1024), (err) => status(err) === 413);
  assert.ok(counter.pulled < MAX_UPLOAD_META_BYTES * 4, `read ${counter.pulled} bytes`);

  // A field keeps at most MAX_UPLOAD_META_BYTES in memory (busboy drops the rest)
  // and says it was cut only at its end.
  const field = request([part("meta"), '{"title":"', "x".repeat(MAX_UPLOAD_META_BYTES + 1), '"}', "\r\n", `--${BOUNDARY}--\r\n`]);
  await assert.rejects(readUpload(field.req, 1024), (err) => status(err) === 413);
});

test("refuses other fields, two metas, bad JSON, broken bodies and other content types", async () => {
  const end = `--${BOUNDARY}--\r\n`;
  const cases: [Iterable<string>, number][] = [
    [[part("meta"), META, "\r\n", part("notes.txt"), "not a file", "\r\n", end], 400],
    [[part("meta"), META, "\r\n", part("meta"), META, "\r\n", end], 400],
    [[part("meta"), "{not json", "\r\n", end], 400],
    [[end], 400],
    [[part("meta"), META], 400], // cut off before the closing boundary
  ];
  for (const [chunks, expected] of cases) {
    await assert.rejects(readUpload(request(chunks).req, 1024), (err) => status(err) === expected);
  }
  const json = request([META]).req;
  json.headers["content-type"] = "application/json";
  await assert.rejects(readUpload(json, 1024), (err) => status(err) === 415);
});
