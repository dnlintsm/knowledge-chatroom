import { test, expect } from "@playwright/test";
import { normalizePath, InvalidPathError } from "../../shared/files";
import { parseFileInfo, parseFileList, parseWorkspaceEvent, type FileInfo } from "../../shared/storage-contract";
import * as backend from "../../agent/src/storage/paths";
import * as browser from "../../src/components/workspace/types";
import { listServerFiles, loadServerFile, putServerFile } from "../../src/components/workspace/server-files";
import { INVALID_STORAGE_KEY, STORAGE_KEY, persistWorkspace, readPlaceUi, restoreWorkspace } from "../../src/components/workspace/local-persistence";
import { parsePersistedWorkspace } from "../../src/components/workspace/workspace-state";

const info: FileInfo = { path: "notes/a.md", kind: "note", mime: "text/markdown", size: 1, sha256: "a".repeat(64), updatedAt: "2026-10-12T00:00:00.000Z", author: "user", readOnly: false, workspaceId: "w", nodeId: null, experimentId: null };
const state = { files: [{ path: info.path, kind: info.kind, mime: info.mime, content: "kept", updatedAt: 1, author: info.author }], tabs: [info.path], active: info.path };

test("relative paths reject traversal/control bytes and normalize Windows separators", () => {
  expect(normalizePath(" /notes//folder\\a.md ")).toBe("notes/folder/a.md");
  for (const path of ["", "notes/", "../secret", "notes/./a", "notes/../a", "notes/\u0000a", "a".repeat(1025)]) expect(() => backend.normalizePath(path)).toThrow(InvalidPathError);
});

test("MIME/kind compatibility is shared with an explicit SVG representation policy", () => {
  for (const [path, mime] of [["notes/a.MD", "text/markdown"], ["notes/a.html", "text/html"], ["uploads/a.svg", "image/svg+xml"], ["uploads/a.png", "image/png"], ["artifacts/a.json", "application/json"], ["uploads/a.unknown", "application/octet-stream"]]) {
    expect(browser.mimeForPath(path)).toBe(mime);
    expect(backend.mimeForPath(path)).toBe(mime);
    expect(browser.kindForPath(path)).toBe(backend.kindForPath(path));
  }
  expect(browser.isTextFile({ path: "uploads/a.svg", mime: "image/svg+xml" })).toBe(false);
  expect(backend.isTextFile("uploads/a.svg", "image/svg+xml")).toBe(true);
});

test("metadata allows additive fields and legacy missing readOnly but rejects bad payloads", () => {
  expect(parseFileList({ files: [{ ...info, futureField: true }] })).toMatchObject([info]);
  const legacy = { ...info, readOnly: undefined };
  expect(parseFileInfo(legacy).readOnly).toBe(false);
  expect(parseFileInfo({ ...info, nodeId: "n" }).nodeId).toBe("n");
  expect(parseFileInfo({ ...info, experimentId: "x" }).experimentId).toBe("x");
  for (const change of [{ path: "../secret" }, { kind: ["note"] }, { author: "wrong" }, { size: -1 }, { size: 0.5 }, { sha256: "wrong" }, { updatedAt: "wrong" }, { readOnly: "false" }, { workspaceId: undefined }, { nodeId: 1 }, { experimentId: undefined }, { nodeId: "n", experimentId: "x" }]) expect(() => parseFileInfo({ ...info, ...change })).toThrow();
});

test("event contracts cover scoped writes, node/experiment changes and proposals", () => {
  for (const event of [
    { op: "write", node: null, experiment: "x", path: info.path, sha256: info.sha256, author: "agent" },
    { op: "node", change: "rename", id: "n" },
    { op: "experiment", change: "status", id: "x", node: "n" },
    { op: "proposal", change: "accepted", id: "p", node: "n", path: info.path, author: "user", authorId: "u" },
  ]) expect(parseWorkspaceEvent(event)).toEqual(event);
  for (const event of [null, { op: "unknown" }, { op: "write", node: null, path: "../secret" }, { op: "proposal", change: "accepted", id: "p" }]) expect(() => parseWorkspaceEvent(event)).toThrow();
});

test("invalid successful API responses are rejected before reaching workspace state", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ files: [{ ...info, size: "wrong" }] });
  try {
    await expect(listServerFiles()).rejects.toThrow("invalid file metadata");
    await expect(putServerFile({ path: info.path, mime: info.mime, content: "new" })).rejects.toThrow();
  } finally { globalThis.fetch = original; }
});

test("SVG upload sends actual bytes and its browser preview remains a versioned URL", async () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"/>';
  const image = { ...info, path: "uploads/a.svg", kind: "upload" as const, mime: "image/svg+xml" };
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    if (typeof input === "string" && input.startsWith("data:")) return original(input, init);
    expect(init?.body).toBeInstanceOf(Blob);
    expect(await (init?.body as Blob).text()).toBe(svg);
    return Response.json(image);
  };
  try {
    await putServerFile({ path: image.path, mime: image.mime, content: `data:image/svg+xml,${encodeURIComponent(svg)}` });
    expect((await loadServerFile(image)).content).toBe(`/api/files/uploads/a.svg?v=${image.sha256}`);
  } finally { globalThis.fetch = original; }
});

test("corrupt persisted structures cannot replace valid data without retaining the original", () => {
  expect(parsePersistedWorkspace(state)).toEqual(state);
  expect(parsePersistedWorkspace({ ...state, files: "invalid" })).toBeNull();
  expect(parsePersistedWorkspace({ ...state, files: [{ ...state.files[0], updatedAt: "wrong" }] })).toBeNull();
  const raw = JSON.stringify({ ...state, files: "invalid" });
  const values = new Map([[STORAGE_KEY, raw]]);
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
  expect(restoreWorkspace(storage)).toBeNull();
  expect(storage.getItem(INVALID_STORAGE_KEY)).toBe(raw);
  persistWorkspace(storage, state, "local", null);
  expect(restoreWorkspace(storage)).toEqual(state);
  values.set(STORAGE_KEY, raw);
  const full = { ...storage, setItem: () => { throw new Error("quota exceeded"); } };
  expect(() => persistWorkspace(full, state, "local", null)).toThrow();
  expect(storage.getItem(STORAGE_KEY)).toBe(raw);
});

test("bad tab payloads are isolated while valid root and legacy tabs remain compatible", () => {
  const root = { tabs: ["::tasks"], active: "::tasks" };
  const value = JSON.stringify({ "": root, bad: { tabs: "wrong", active: null } });
  expect(readPlaceUi({ getItem: () => value, setItem: () => {}, removeItem: () => {} })).toEqual({ "": root });
});
