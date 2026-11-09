import { test, expect } from "@playwright/test";
import { diffRows } from "../../apps/web/src/components/workspace/diff-rows";

/** The review panel's diffs (apps/web/src/components/workspace/diff-rows.ts). */

test("marks added and removed lines with both line numbers", () => {
  expect(diffRows("a\nb\nc\n", "a\nB\nc\n")).toEqual([
    { type: "same", text: "a", old: 1, new: 1 },
    { type: "removed", text: "b", old: 2, new: null },
    { type: "added", text: "B", old: null, new: 2 },
    { type: "same", text: "c", old: 3, new: 3 },
  ]);
});

test("a new file is all additions", () => {
  expect(diffRows("", "one\ntwo")).toEqual([
    { type: "added", text: "one", old: null, new: 1 },
    { type: "added", text: "two", old: null, new: 2 },
  ]);
});

test("folds long unchanged runs, keeping three lines of context", () => {
  const before = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n");
  const after = before.replace("line 10", "line ten");
  const rows = diffRows(before, after);
  expect(rows[0]).toEqual({ type: "fold", count: 6 });
  expect(rows.filter((r) => r.type === "same").map((r) => "text" in r && r.text)).toEqual([
    "line 7", "line 8", "line 9", "line 11", "line 12", "line 13",
  ]);
  expect(rows.at(-1)).toEqual({ type: "fold", count: 7 });
});

test("returns empty array when both before and after are empty", () => {
  expect(diffRows("", "")).toEqual([]);
});

test("a deleted file is all removals", () => {
  expect(diffRows("one\ntwo\n", "")).toEqual([
    { type: "removed", text: "one", old: 1, new: null },
    { type: "removed", text: "two", old: 2, new: null },
  ]);
});

test("identical content folds all unchanged lines", () => {
  expect(diffRows("hello\nworld\n", "hello\nworld\n")).toEqual([
    { type: "fold", count: 2 },
  ]);
});

test("handles changes at the very beginning of the file", () => {
  const before = ["old first", "line 2", "line 3", "line 4", "line 5", "line 6", "line 7"].join("\n");
  const after = ["new first", "line 2", "line 3", "line 4", "line 5", "line 6", "line 7"].join("\n");
  const rows = diffRows(before, after);
  expect(rows).toEqual([
    { type: "removed", text: "old first", old: 1, new: null },
    { type: "added", text: "new first", old: null, new: 1 },
    { type: "same", text: "line 2", old: 2, new: 2 },
    { type: "same", text: "line 3", old: 3, new: 3 },
    { type: "same", text: "line 4", old: 4, new: 4 },
    { type: "fold", count: 3 },
  ]);
});

test("handles changes at the very end of the file", () => {
  const before = ["line 1", "line 2", "line 3", "line 4", "line 5", "line 6", "old last"].join("\n");
  const after = ["line 1", "line 2", "line 3", "line 4", "line 5", "line 6", "new last"].join("\n");
  const rows = diffRows(before, after);
  expect(rows).toEqual([
    { type: "fold", count: 3 },
    { type: "same", text: "line 4", old: 4, new: 4 },
    { type: "same", text: "line 5", old: 5, new: 5 },
    { type: "same", text: "line 6", old: 6, new: 6 },
    { type: "removed", text: "old last", old: 7, new: null },
    { type: "added", text: "new last", old: null, new: 7 },
  ]);
});

test("handles multiple hunks with folding between them when far apart", () => {
  const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
  const before = lines.join("\n");
  const linesAfter = [...lines];
  linesAfter[3] = "modified line 4";
  linesAfter[26] = "modified line 27";
  const after = linesAfter.join("\n");

  const rows = diffRows(before, after);
  // Lines 1..3 are context before line 4
  expect(rows[0]).toEqual({ type: "same", text: "line 1", old: 1, new: 1 });
  expect(rows[1]).toEqual({ type: "same", text: "line 2", old: 2, new: 2 });
  expect(rows[2]).toEqual({ type: "same", text: "line 3", old: 3, new: 3 });
  expect(rows[3]).toEqual({ type: "removed", text: "line 4", old: 4, new: null });
  expect(rows[4]).toEqual({ type: "added", text: "modified line 4", old: null, new: 4 });
  // Context lines 5, 6, 7 after line 4
  expect(rows[5]).toEqual({ type: "same", text: "line 5", old: 5, new: 5 });
  expect(rows[6]).toEqual({ type: "same", text: "line 6", old: 6, new: 6 });
  expect(rows[7]).toEqual({ type: "same", text: "line 7", old: 7, new: 7 });
  // A fold for unchanged lines 8..23 (count = 16)
  expect(rows[8]).toEqual({ type: "fold", count: 16 });
  // Context lines 24, 25, 26 before line 27
  expect(rows[9]).toEqual({ type: "same", text: "line 24", old: 24, new: 24 });
  expect(rows[10]).toEqual({ type: "same", text: "line 25", old: 25, new: 25 });
  expect(rows[11]).toEqual({ type: "same", text: "line 26", old: 26, new: 26 });
  expect(rows[12]).toEqual({ type: "removed", text: "line 27", old: 27, new: null });
  expect(rows[13]).toEqual({ type: "added", text: "modified line 27", old: null, new: 27 });
  // Context lines 28, 29, 30 after line 27
  expect(rows[14]).toEqual({ type: "same", text: "line 28", old: 28, new: 28 });
  expect(rows[15]).toEqual({ type: "same", text: "line 29", old: 29, new: 29 });
  expect(rows[16]).toEqual({ type: "same", text: "line 30", old: 30, new: 30 });
});

test("does not fold unchanged lines when gap between hunks is within 2 * CONTEXT_LINES", () => {
  // If hunk 1 is at line 2 and hunk 2 is at line 7, the distance is 4 lines (lines 3, 4, 5, 6),
  // which are within 3 lines of either change hunk, so no fold should occur between them.
  const before = ["line 1", "line 2", "line 3", "line 4", "line 5", "line 6", "line 7", "line 8"].join("\n");
  const after = ["line 1", "changed 2", "line 3", "line 4", "line 5", "line 6", "changed 7", "line 8"].join("\n");
  const rows = diffRows(before, after);
  const folds = rows.filter((r) => r.type === "fold");
  expect(folds).toHaveLength(0);
  expect(rows).toEqual([
    { type: "same", text: "line 1", old: 1, new: 1 },
    { type: "removed", text: "line 2", old: 2, new: null },
    { type: "added", text: "changed 2", old: null, new: 2 },
    { type: "same", text: "line 3", old: 3, new: 3 },
    { type: "same", text: "line 4", old: 4, new: 4 },
    { type: "same", text: "line 5", old: 5, new: 5 },
    { type: "same", text: "line 6", old: 6, new: 6 },
    { type: "removed", text: "line 7", old: 7, new: null },
    { type: "added", text: "changed 7", old: null, new: 7 },
    { type: "same", text: "line 8", old: 8, new: 8 },
  ]);
});

test("handles strings without trailing newlines correctly", () => {
  expect(diffRows("foo", "bar")).toEqual([
    { type: "removed", text: "foo", old: 1, new: null },
    { type: "added", text: "bar", old: null, new: 1 },
  ]);
});
