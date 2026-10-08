import { test, expect } from "@playwright/test";
import { reduceWorkspace, type PersistedWorkspace } from "../../src/components/workspace/workspace-state";
import { NODE_KEY, PLACE_UI_KEY, STORAGE_KEY, persistWorkspace, readPlaceUi, restoreWorkspace } from "../../src/components/workspace/local-persistence";
import type { WorkspaceFile } from "../../src/components/workspace/types";

const file: WorkspaceFile = { path: "notes/a.md", kind: "note", content: "first", mime: "text/markdown", updatedAt: 1, author: "user" };
const state: PersistedWorkspace = { files: [file], tabs: [file.path, "notes/b.md", "::tasks"], active: file.path };

function browserStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}

test("editing an existing file preserves its tabs and never mutates the previous snapshot", () => {
  const next = reduceWorkspace(state, { type: "upsert", file: { ...file, content: "latest" } });
  expect(next.files).toHaveLength(1);
  expect(next.files[0].content).toBe("latest");
  expect(next.tabs).toEqual(state.tabs);
  expect(state.files[0].content).toBe("first");
});

test("closing selects the adjacent tab, removing selects the last, and neither deletes other tabs", () => {
  expect(reduceWorkspace(state, { type: "close", tab: file.path }).active).toBe("notes/b.md");
  const removed = reduceWorkspace(state, { type: "remove", path: file.path });
  expect(removed.active).toBe("::tasks");
  expect(removed.files).toEqual([]);
  expect(removed.tabs).toEqual(["notes/b.md", "::tasks"]);
  expect(reduceWorkspace({ files: [file], tabs: [file.path], active: file.path }, { type: "close", tab: file.path }).active).toBeNull();
});

test("opening an existing tab does not duplicate it and closing an inactive tab keeps focus", () => {
  expect(reduceWorkspace(state, { type: "open", tab: file.path }).tabs).toEqual(state.tabs);
  expect(reduceWorkspace(state, { type: "close", tab: "notes/b.md" }).active).toBe(file.path);
});

test("local files round-trip and invalid JSON retains the seed fallback", () => {
  const storage = browserStorage();
  persistWorkspace(storage, state, "local", null);
  expect(restoreWorkspace(storage)).toEqual(state);
  storage.setItem(STORAGE_KEY, "broken JSON");
  expect(restoreWorkspace(storage)).toBeNull();
});

test("server UI keeps root, node and experiment tabs separate without persisting server bytes", () => {
  const storage = browserStorage();
  persistWorkspace(storage, state, "server", null);
  persistWorkspace(storage, { ...state, tabs: ["node-file"], active: "node-file" }, "server", "node-id");
  persistWorkspace(storage, { ...state, tabs: ["::experiment"], active: "::experiment" }, "server", "x:experiment-id");
  expect(storage.getItem(STORAGE_KEY)).toBeNull();
  expect(readPlaceUi(storage)).toEqual({
    "": { tabs: state.tabs, active: state.active },
    "node-id": { tabs: ["node-file"], active: "node-file" },
    "x:experiment-id": { tabs: ["::experiment"], active: "::experiment" },
  });
  expect(storage.getItem(NODE_KEY)).toBe("x:experiment-id");
  persistWorkspace(storage, state, "server", null);
  expect(storage.getItem(NODE_KEY)).toBeNull();
});

test("legacy root UI is restored and malformed place UI is ignored", () => {
  const root = { tabs: ["legacy.md"], active: "legacy.md" };
  const storage = browserStorage({ "knowledge-chatroom.workspace.server-ui.v1": JSON.stringify(root) });
  expect(readPlaceUi(storage)).toEqual({ "": root });
  storage.setItem(PLACE_UI_KEY, "broken JSON");
  expect(readPlaceUi(storage)).toEqual({});
});
