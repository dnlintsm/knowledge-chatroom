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

test("a line longer than a read continues by column", () => {
  const long = "abcdefghij".repeat(5);
  const content = `${long}\nend`;
  const first = readLines("min.json", content, { maxChars: 20 });
  assert.equal(
    first,
    "min.json (lines 1-1 of 2; line 1 cut before column 21; continue with offset 1 column 21)\n" +
      `1\t${long.slice(0, 20)}`,
  );
  // Following the hints reads every character, then the next line.
  let at = { offset: 1, column: 1 };
  let text = "";
  for (let reads = 0; reads < 10; reads++) {
    const out = readLines("min.json", content, { ...at, maxChars: 20 });
    text += out.split("\n").slice(1).map((l) => l.split("\t")[1]).join("\n");
    const next = /continue with offset (\d+)(?: column (\d+))?/.exec(out);
    if (!next) break;
    if (!next[2]) text += "\n";
    at = { offset: Number(next[1]), column: Number(next[2] ?? 1) };
  }
  assert.equal(text, content);
  assert.match(readLines("min.json", content, { offset: 1, column: 51 }), /column 51 is past its end/);
});
