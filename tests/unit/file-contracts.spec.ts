import { test, expect } from "@playwright/test";
import { normalizePath, InvalidPathError } from "@knowledge-chatroom/contracts/files";
import { parseFileInfo, parseFileList, parseLocalFile, parseWorkspaceEvent, StorageContractError, type FileInfo } from "@knowledge-chatroom/contracts/storage-contract";
import * as backend from "../../apps/agent/src/storage/paths";
import * as browser from "../../apps/web/src/components/workspace/types";
import { listServerFiles, loadServerFile, putServerFile } from "../../apps/web/src/components/workspace/server-files";
import { INVALID_STORAGE_KEY, STORAGE_KEY, persistWorkspace, readPlaceUi, restoreWorkspace } from "../../apps/web/src/components/workspace/local-persistence";
import { parsePersistedWorkspace } from "../../apps/web/src/components/workspace/workspace-state";

const info: FileInfo = { path: "notes/a.md", kind: "note", mime: "text/markdown", size: 1, sha256: "a".repeat(64), updatedAt: "2026-10-12T00:00:00.000Z", author: "user", readOnly: false };
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

test("the editor pane picks a preview from the type, or the extension for untyped files", () => {
  const kinds: [string, string, browser.PreviewKind][] = [
    ["notes/a.md", "text/markdown", "markdown"],
    ["uploads/a.tsv", "text/tab-separated-values", "table"],
    ["uploads/a.htm", "text/html", "html"],
    // Browsers type .ts uploads as MPEG transport streams.
    ["uploads/a.ts", "video/mp2t", "code"],
    ["uploads/a.go", "application/octet-stream", "code"],
    ["uploads/a.txt", "text/plain", "text"],
    ["uploads/a.svg", "image/svg+xml", "image"],
    ["uploads/a.bmp", "application/octet-stream", "image"],
    ["uploads/a.heic", "image/heic", "image"],
    ["uploads/a.pdf", "application/pdf", "pdf"],
    ["uploads/a.mp3", "audio/mpeg", "audio"],
    ["uploads/a.mov", "application/octet-stream", "video"],
    ["uploads/a.zip", "application/zip", "none"],
  ];
  for (const [path, mime, kind] of kinds) expect(browser.previewKind({ path, mime }), path).toBe(kind);
});

test("metadata allows additive fields and legacy missing readOnly but rejects bad payloads", () => {
  expect(parseFileList({ files: [{ ...info, futureField: true }] })).toMatchObject([info]);
  const legacy = { ...info, readOnly: undefined };
  expect(parseFileInfo(legacy).readOnly).toBe(false);
  for (const change of [{ path: "../secret" }, { kind: ["note"] }, { author: "wrong" }, { size: -1 }, { size: 0.5 }, { sha256: "wrong" }, { updatedAt: "wrong" }, { readOnly: "false" }]) expect(() => parseFileInfo({ ...info, ...change })).toThrow();
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

test("StorageContractError extends TypeError and validates storage contract errors", () => {
  const error = new StorageContractError("invalid payload");
  expect(error).toBeInstanceOf(StorageContractError);
  expect(error).toBeInstanceOf(TypeError);
  expect(error).toBeInstanceOf(Error);
  expect(error.name).toBe("TypeError");
  expect(error.message).toBe("invalid payload");

  // Contract parsing functions throw StorageContractError
  expect(() => parseFileInfo(null)).toThrow(StorageContractError);
  expect(() => parseFileInfo("not an object")).toThrow(StorageContractError);
  expect(() => parseFileInfo({ ...info, size: -1 })).toThrow(StorageContractError);
  expect(() => parseFileList(null)).toThrow(StorageContractError);
  expect(() => parseFileList({})).toThrow(StorageContractError);
  expect(() => parseWorkspaceEvent(null)).toThrow(StorageContractError);
  expect(() => parseWorkspaceEvent({ op: "unknown" })).toThrow(StorageContractError);
  expect(() => parseLocalFile(null)).toThrow(StorageContractError);
  expect(() => parseLocalFile({ path: "../secret" })).toThrow(StorageContractError);
});
