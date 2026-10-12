import { test, expect } from "@playwright/test";
import { diffRows } from "../../src/components/workspace/diff-rows";

/** The review panel's diffs (src/components/workspace/diff-rows.ts). */

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
