import assert from "node:assert/strict";
import { test } from "node:test";

import { numberLines, readLines } from "./tools";

const file = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join("\n");

test("a file that fits is read whole, as before", () => {
  assert.equal(readLines("a.md", file), `a.md\n${numberLines(file)}`);
});

test("offset and limit read part of a file and say how to go on", () => {
  assert.equal(
    readLines("a.md", file, { offset: 3, limit: 2 }),
    "a.md (lines 3-4 of 12; continue with offset 5)\n 3\tline 3\n 4\tline 4",
  );
  assert.equal(
    readLines("a.md", file, { offset: 11 }),
    "a.md (lines 11-12 of 12)\n11\tline 11\n12\tline 12",
  );
  assert.match(readLines("a.md", file, { offset: 13 }), /12 lines; offset 13 is past the end/);
});

test("a long file stops at a whole line and pages on from there", () => {
  // Each line is 6-7 characters plus a newline; 30 fit lines 1-4.
  const first = readLines("a.md", file, { maxChars: 30 });
  assert.equal(first.split("\n")[0], "a.md (lines 1-4 of 12; continue with offset 5)");
  let offset = 1;
  const seen: string[] = [];
  for (let reads = 0; reads < 10; reads++) {
    const out = readLines("a.md", file, { offset, maxChars: 30 });
    seen.push(...out.split("\n").slice(1).map((l) => l.split("\t")[1]));
    const next = /continue with offset (\d+)/.exec(out);
    if (!next) break;
    offset = Number(next[1]);
  }
  assert.deepEqual(seen, file.split("\n"));
});

test("one line longer than a read shows its start", () => {
  const out = readLines("min.json", `${"x".repeat(50)}\nend`, { maxChars: 20 });
  assert.equal(
    out,
    `min.json (lines 1-1 of 2; line 1 cut at 20 characters; continue with offset 2)\n1\t${"x".repeat(20)}`,
  );
});
