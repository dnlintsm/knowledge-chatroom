import { test, expect } from "@playwright/test";
import { parsePersistedWorkspace, reduceWorkspace, type PersistedWorkspace } from "../../src/components/workspace/workspace-state";
import { COLLAPSED_FOLDERS_KEY, NODE_KEY, PLACE_UI_KEY, STORAGE_KEY, persistCollapsedFolders, persistWorkspace, readCollapsedFolders, readPlaceUi, restoreWorkspace } from "../../src/components/workspace/local-persistence";
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

test("renaming a file moves its tab in place and keeps it active", () => {
  const renamed = { ...file, path: "notes/plan.md" };
  const next = reduceWorkspace(state, { type: "rename", from: file.path, file: renamed });
  expect(next.files).toEqual([renamed]);
  expect(next.tabs).toEqual(["notes/plan.md", "notes/b.md", "::tasks"]);
  expect(next.active).toBe("notes/plan.md");
});

test("collapsed folders are remembered per place and tolerate bad data", () => {
  const storage = browserStorage({ [COLLAPSED_FOLDERS_KEY]: JSON.stringify({ "": ["runs", 3], n1: "x" }) });
  expect(readCollapsedFolders(storage, null)).toEqual(["runs"]);
  expect(readCollapsedFolders(storage, "n1")).toEqual([]);
  persistCollapsedFolders(storage, "n1", ["skills/summarize", "notes"]);
  expect(readCollapsedFolders(storage, "n1")).toEqual(["notes", "skills/summarize"]);
  expect(readCollapsedFolders(storage, null)).toEqual(["runs"]);
  persistCollapsedFolders(storage, null, []);
  expect(JSON.parse(storage.getItem(COLLAPSED_FOLDERS_KEY)!)).toEqual({ n1: ["notes", "skills/summarize"] });
  expect(readCollapsedFolders(browserStorage({ [COLLAPSED_FOLDERS_KEY]: "{" }), null)).toEqual([]);
});

test("parsePersistedWorkspace validates structure and rejects non-objects, bad tabs, and bad file lists", () => {
  // Non-objects and falsy values
  expect(parsePersistedWorkspace(null)).toBeNull();
  expect(parsePersistedWorkspace(undefined)).toBeNull();
  expect(parsePersistedWorkspace("")).toBeNull();
  expect(parsePersistedWorkspace(123)).toBeNull();
  expect(parsePersistedWorkspace(true)).toBeNull();
  expect(parsePersistedWorkspace([])).toBeNull();

  // Missing or malformed tab states
  expect(parsePersistedWorkspace({ files: [] })).toBeNull();
  expect(parsePersistedWorkspace({ files: [], tabs: "not-an-array", active: null })).toBeNull();
  expect(parsePersistedWorkspace({ files: [], tabs: [123], active: null })).toBeNull();
  expect(parsePersistedWorkspace({ files: [], tabs: [""], active: null })).toBeNull();
  expect(parsePersistedWorkspace({ files: [], tabs: [], active: 123 })).toBeNull();
  expect(parsePersistedWorkspace({ files: [], tabs: [], active: "" })).toBeNull();

  // Missing or malformed files property
  expect(parsePersistedWorkspace({ tabs: [], active: null })).toBeNull();
  expect(parsePersistedWorkspace({ tabs: [], active: null, files: null })).toBeNull();
  expect(parsePersistedWorkspace({ tabs: [], active: null, files: "not-an-array" })).toBeNull();
  expect(parsePersistedWorkspace({ tabs: [], active: null, files: {} })).toBeNull();

  // Valid minimal workspace
  expect(parsePersistedWorkspace({ tabs: [], active: null, files: [] })).toEqual({
    tabs: [],
    active: null,
    files: [],
  });

  // Valid workspace with active tab and files
  const validWorkspace = {
    tabs: ["notes/a.md"],
    active: "notes/a.md",
    files: [{ ...file, readOnly: false }],
  };
  expect(parsePersistedWorkspace(validWorkspace)).toEqual(validWorkspace);

  // Malformed individual file entries that fail parseLocalFile
  const invalidFiles: unknown[] = [
    null,
    "not-a-file-object",
    { ...file, path: "" },
    { ...file, path: "../secret.md" },
    { ...file, path: "notes/./a.md" },
    { ...file, kind: "unknown-kind" },
    { ...file, kind: "" },
    { ...file, content: 123 },
    { ...file, mime: "" },
    { ...file, author: "unknown-author" },
    { ...file, updatedAt: "2026-01-01" },
    { ...file, updatedAt: NaN },
    { ...file, updatedAt: Infinity },
    { ...file, readOnly: "false" },
  ];

  for (const badFile of invalidFiles) {
    expect(
      parsePersistedWorkspace({
        tabs: [file.path],
        active: file.path,
        files: [badFile],
      }),
    ).toBeNull();
  }
});
