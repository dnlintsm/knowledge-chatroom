import { test, expect } from "@playwright/test";
import { INITIAL_FILE_FOCUS, reduceFileFocus } from "../../src/components/workspace/file-focus";

test("switching or closing the active file drops its agent context selection", () => {
  const selected = reduceFileFocus(INITIAL_FILE_FOCUS, { type: "selection", text: "selected in A" });
  expect(reduceFileFocus(selected, { type: "activate" }).selection).toBe("");
  expect(reduceFileFocus(selected, { type: "open", tab: "notes/b.md" })).toEqual({ selection: "", openCount: 1, reveal: null });
  expect(selected.selection).toBe("selected in A");
});

test("reopening the same cited lines creates a fresh reveal and bumps the open signal", () => {
  const action = { type: "open" as const, tab: "notes/a.md", lines: { start: 3, end: 4 } };
  const first = reduceFileFocus(INITIAL_FILE_FOCUS, action);
  const second = reduceFileFocus(first, action);
  expect(second.reveal).toEqual(first.reveal);
  expect(second.reveal).not.toBe(first.reveal);
  expect(second.openCount).toBe(2);
});

test("editing the cited file invalidates line numbers; editing a different file preserves them", () => {
  const cited = reduceFileFocus(INITIAL_FILE_FOCUS, { type: "open", tab: "notes/a.md", lines: { start: 7, end: 7 } });
  expect(reduceFileFocus(cited, { type: "edit", path: "notes/b.md" })).toBe(cited);
  expect(reduceFileFocus(cited, { type: "edit", path: "notes/a.md" }).reveal).toBeNull();
  expect(cited.reveal).not.toBeNull();
});

test("moving places clears selection and reveal while preserving the open signal", () => {
  const cited = reduceFileFocus(INITIAL_FILE_FOCUS, { type: "open", tab: "notes/a.md", lines: { start: 1, end: 2 } });
  const selected = reduceFileFocus(cited, { type: "selection", text: "A" });
  expect(reduceFileFocus(selected, { type: "reset" })).toEqual({ selection: "", reveal: null, openCount: 1 });
});
