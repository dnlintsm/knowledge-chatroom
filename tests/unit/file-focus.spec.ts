import { test, expect } from "@playwright/test";
import { INITIAL_FILE_FOCUS, reduceFileFocus } from "../../apps/web/src/components/workspace/file-focus";

test("initial file focus defaults have empty selection, zero openCount, and null reveal", () => {
  expect(INITIAL_FILE_FOCUS).toEqual({ selection: "", openCount: 0, reveal: null });
});

test("selection action updates selection text and preserves reveal and openCount", () => {
  const cited = reduceFileFocus(INITIAL_FILE_FOCUS, { type: "open", tab: "notes/a.md", lines: { start: 1, end: 5 } });
  const selected = reduceFileFocus(cited, { type: "selection", text: "hello world\nmultiline" });
  expect(selected).toEqual({
    selection: "hello world\nmultiline",
    openCount: 1,
    reveal: { path: "notes/a.md", lines: { start: 1, end: 5 } },
  });

  const emptySelected = reduceFileFocus(selected, { type: "selection", text: "" });
  expect(emptySelected.selection).toBe("");
  expect(emptySelected.openCount).toBe(1);
  expect(emptySelected.reveal).toEqual(cited.reveal);
});

test("activate action clears selection while preserving reveal and openCount", () => {
  const cited = reduceFileFocus(INITIAL_FILE_FOCUS, { type: "open", tab: "notes/a.md", lines: { start: 10, end: 20 } });
  const selected = reduceFileFocus(cited, { type: "selection", text: "snippet" });
  const activated = reduceFileFocus(selected, { type: "activate" });
  expect(activated).toEqual({
    selection: "",
    openCount: 1,
    reveal: { path: "notes/a.md", lines: { start: 10, end: 20 } },
  });

  // Calling activate when selection is already empty keeps state consistent
  const doubleActivated = reduceFileFocus(activated, { type: "activate" });
  expect(doubleActivated).toEqual(activated);
});

test("open action without lines clears selection, increments openCount, and clears reveal to null", () => {
  const cited = reduceFileFocus(INITIAL_FILE_FOCUS, { type: "open", tab: "notes/a.md", lines: { start: 2, end: 4 } });
  const selected = reduceFileFocus(cited, { type: "selection", text: "selected code" });

  const openedWithoutLines = reduceFileFocus(selected, { type: "open", tab: "notes/other.md" });
  expect(openedWithoutLines).toEqual({
    selection: "",
    openCount: 2,
    reveal: null,
  });

  const openedAgain = reduceFileFocus(openedWithoutLines, { type: "open", tab: "notes/third.md" });
  expect(openedAgain.openCount).toBe(3);
  expect(openedAgain.reveal).toBeNull();
});

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

test("edit action returns same state reference when reveal is null", () => {
  const noRevealState = { selection: "code", openCount: 3, reveal: null };
  const nextState = reduceFileFocus(noRevealState, { type: "edit", path: "notes/a.md" });
  expect(nextState).toBe(noRevealState);
});

test("edit action only invalidates reveal on exact path match, preserving selection and openCount", () => {
  const cited = {
    selection: "existing selection",
    openCount: 5,
    reveal: { path: "notes/a.md", lines: { start: 1, end: 10 } },
  };

  // Subpath, superpath, or extension variations should not invalidate
  expect(reduceFileFocus(cited, { type: "edit", path: "notes/a" })).toBe(cited);
  expect(reduceFileFocus(cited, { type: "edit", path: "notes/a.md.bak" })).toBe(cited);
  expect(reduceFileFocus(cited, { type: "edit", path: "a.md" })).toBe(cited);

  // Exact match invalidates reveal but preserves selection and openCount
  const edited = reduceFileFocus(cited, { type: "edit", path: "notes/a.md" });
  expect(edited).toEqual({
    selection: "existing selection",
    openCount: 5,
    reveal: null,
  });
});

test("reset action clears selection and reveal from any state while preserving openCount", () => {
  // Resetting from initial state
  expect(reduceFileFocus(INITIAL_FILE_FOCUS, { type: "reset" })).toEqual({
    selection: "",
    openCount: 0,
    reveal: null,
  });

  // Resetting state with active selection, reveal, and non-zero openCount
  const state = {
    selection: "active snippet",
    openCount: 42,
    reveal: { path: "notes/doc.md", lines: { start: 5, end: 15 } },
  };
  expect(reduceFileFocus(state, { type: "reset" })).toEqual({
    selection: "",
    openCount: 42,
    reveal: null,
  });
});

test("handles full lifecycle state transitions immutably", () => {
  // 1. Initial state
  let state = INITIAL_FILE_FOCUS;

  // 2. Open file with line citation
  state = reduceFileFocus(state, { type: "open", tab: "src/index.ts", lines: { start: 10, end: 20 } });
  expect(state).toEqual({
    selection: "",
    openCount: 1,
    reveal: { path: "src/index.ts", lines: { start: 10, end: 20 } },
  });

  // 3. User selects text in that file
  state = reduceFileFocus(state, { type: "selection", text: "function main()" });
  expect(state.selection).toBe("function main()");
  expect(state.openCount).toBe(1);

  // 4. User edits another file -> no change
  const unchanged = reduceFileFocus(state, { type: "edit", path: "src/other.ts" });
  expect(unchanged).toBe(state);

  // 5. User edits the cited file -> reveal cleared, selection and openCount kept
  state = reduceFileFocus(state, { type: "edit", path: "src/index.ts" });
  expect(state.reveal).toBeNull();
  expect(state.selection).toBe("function main()");
  expect(state.openCount).toBe(1);

  // 6. User switches tab / activates -> selection cleared
  state = reduceFileFocus(state, { type: "activate" });
  expect(state.selection).toBe("");
  expect(state.reveal).toBeNull();
  expect(state.openCount).toBe(1);

  // 7. Open another file without citation -> openCount bumped
  state = reduceFileFocus(state, { type: "open", tab: "README.md" });
  expect(state.openCount).toBe(2);
  expect(state.reveal).toBeNull();

  // 8. Reset preserves openCount
  state = reduceFileFocus(state, { type: "reset" });
  expect(state).toEqual({ selection: "", openCount: 2, reveal: null });
});

test("moving places clears selection and reveal while preserving the open signal", () => {
  const cited = reduceFileFocus(INITIAL_FILE_FOCUS, { type: "open", tab: "notes/a.md", lines: { start: 1, end: 2 } });
  const selected = reduceFileFocus(cited, { type: "selection", text: "A" });
  expect(reduceFileFocus(selected, { type: "reset" })).toEqual({ selection: "", reveal: null, openCount: 1 });
});
