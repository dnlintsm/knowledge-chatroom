import assert from "node:assert/strict";
import { test } from "node:test";

import type { FileInfo } from "./files";
import { listLevel } from "./files";
import { agentRefusal } from "./http";

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
  assert.ok(may("PATCH", "/experiments/e1"));
  assert.ok(!may("DELETE", "/experiments/e1"));
  assert.ok(!may("POST", "/experiments/from-folder"));
  assert.ok(may("POST", "/proposals"));
  for (const action of ["accept", "reject", "withdraw"]) assert.ok(!may("POST", `/proposals/p1/${action}`), action);
  assert.ok(!may("POST", "/access/grants"));
  assert.ok(!may("DELETE", "/access/groups/g1"));
});

test("listLevel lists a folder one level at a time", () => {
  const files = ["notes/a.md", "notes/x/b.md", "notes/x/y/c.md", "skills/s/SKILL.md", "top.md"].map(
    (path) => ({ path }) as FileInfo,
  );
  const paths = (dir: string, depth?: number) => {
    const level = listLevel(files, dir, depth);
    return [level.files.map((f) => f.path), level.folders];
  };
  assert.deepEqual(paths("", 1), [["top.md"], ["notes", "skills"]]);
  assert.deepEqual(paths("notes", 1), [["notes/a.md"], ["notes/x"]]);
  assert.deepEqual(paths("notes", 2), [["notes/a.md", "notes/x/b.md"], ["notes/x/y"]]);
  assert.deepEqual(paths("notes"), [["notes/a.md", "notes/x/b.md", "notes/x/y/c.md"], []]);
  // A folder name is a whole segment, not a prefix of a longer one.
  assert.deepEqual(paths("note", 1), [[], []]);
});
