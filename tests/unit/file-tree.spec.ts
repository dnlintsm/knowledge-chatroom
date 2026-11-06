import { test, expect } from "@playwright/test";
import {
  ancestorFolders,
  buildTree,
  filterFiles,
  folderOf,
  folderPaths,
  newFilePath,
} from "../../src/components/workspace/file-tree";
import type { WorkspaceFile } from "../../src/components/workspace/types";

const file = (path: string): WorkspaceFile => ({
  path,
  content: "",
  kind: "note",
  mime: "text/markdown",
  author: "user",
  updatedAt: 0,
});

const FILES = ["welcome.md", "notes/a.md", "runs/etch/report.md", "runs/etch/data/raw.csv", "skills/x/SKILL.md"].map(file);

test("folder paths list every folder, parents first", () => {
  expect(folderPaths(buildTree(FILES))).toEqual(["notes", "runs", "runs/etch", "runs/etch/data", "skills", "skills/x"]);
  expect(folderPaths(buildTree([file("top.md")]))).toEqual([]);
});

test("a file's ancestor folders and own folder", () => {
  expect(ancestorFolders("runs/etch/data/raw.csv")).toEqual(["runs", "runs/etch", "runs/etch/data"]);
  expect(ancestorFolders("welcome.md")).toEqual([]);
  expect(folderOf("runs/etch/report.md")).toBe("runs/etch/");
  expect(folderOf("welcome.md")).toBe("");
  expect(folderOf(null)).toBe("");
});

test("the name filter matches every word anywhere in the path, ignoring case", () => {
  expect(filterFiles(FILES, "").map((f) => f.path)).toEqual(FILES.map((f) => f.path));
  expect(filterFiles(FILES, "  ").length).toBe(FILES.length);
  expect(filterFiles(FILES, "REPORT").map((f) => f.path)).toEqual(["runs/etch/report.md"]);
  expect(filterFiles(FILES, "etch csv").map((f) => f.path)).toEqual(["runs/etch/data/raw.csv"]);
  expect(filterFiles(FILES, "etch nothing")).toEqual([]);
});

test("new file paths are cleaned up, get .md without an extension, and refuse clashes", () => {
  const taken = new Set(FILES.map((f) => f.path));
  expect(newFilePath("notes/b.md", taken)).toEqual({ path: "notes/b.md" });
  expect(newFilePath("  /notes//plan ", taken)).toEqual({ path: "notes/plan.md" });
  expect(newFilePath("new/folder/data.csv", taken)).toEqual({ path: "new/folder/data.csv" });
  expect(newFilePath("notes/a", taken)).toEqual({ error: "notes/a.md already exists" });
  expect(newFilePath("welcome.md/x.md", taken)).toEqual({ error: "welcome.md is a file, not a folder" });
  expect(newFilePath("", taken)).toEqual({ error: "Type a file name" });
  expect(newFilePath("notes/", taken)).toEqual({ error: "Add a file name after the folder" });
  expect(newFilePath("../x.md", taken)).toEqual({ error: "That isn't a valid file name" });
});
