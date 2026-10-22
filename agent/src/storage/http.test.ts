import assert from "node:assert/strict";
import { test } from "node:test";

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
