/**
 * Workspace model: a flat list of files keyed by path. The top-level folder of
 * a path decides what kind of item it is, which the left rail groups by.
 *
 * Files use optional agent-backed storage, with a browser-local fallback
 * (see store.tsx and docs/architecture.md).
 */

import { extension, isTextFile as isTextContent, mimeForPath } from "../../../shared/files";
import type { LocalFile as WorkspaceFile } from "../../../shared/storage-contract";
export type { LocalFile as WorkspaceFile } from "../../../shared/storage-contract";
export { extension, KIND_FOLDERS, kindForPath, mimeForPath, type FileKind } from "../../../shared/files";

/** An edit or delete of a read-only file. */
export class ReadOnlyFileError extends Error {
  constructor(readonly path: string) {
    super(`${path} is read-only`);
    this.name = "ReadOnlyFileError";
  }
}

/** A create-only write to a path that already has a file. */
export class FileExistsError extends Error {
  constructor(readonly path: string) {
    super(`${path} already exists`);
    this.name = "FileExistsError";
  }
}

/** A tab in the middle pane: a file path, or the built-in task board. */
export type TabId = string;
export const TASKS_TAB: TabId = "::tasks";
/** The current experiment's hypothesis, params and results. */
export const EXPERIMENT_TAB: TabId = "::experiment";
/** Proposed changes to this place's files, waiting for review. */
export const REVIEW_TAB: TabId = "::review";
/** The runs here and below, side by side. */
export const RUNS_TAB: TabId = "::runs";
/** One of your memory notes, to read and edit (memory.tsx). */
export const MEMORY_TAB: TabId = "::memory";
/** Tabs that aren't files. */
export const isBuiltInTab = (tab: TabId) =>
  tab === TASKS_TAB || tab === EXPERIMENT_TAB || tab === REVIEW_TAB || tab === RUNS_TAB || tab === MEMORY_TAB;

export function fileName(path: string) {
  return path.split("/").pop() ?? path;
}

export function isTextFile(file: Pick<WorkspaceFile, "mime" | "path">) {
  // UI image previews retain data/HTTP URLs; SVG text remains readable by the agent.
  return isTextContent(file.path, file.mime, false);
}

export function isMarkdown(file: Pick<WorkspaceFile, "mime" | "path">) {
  return file.mime === "text/markdown" || ["md", "markdown"].includes(extension(file.path));
}

/** How the editor pane shows a file. */
export type PreviewKind =
  | "markdown" | "table" | "html" | "code" | "text"
  | "image" | "pdf" | "audio" | "video" | "none";

// Extensions whose preview is highlighted source; others that are text stay plain.
const CODE_LANGUAGES: Record<string, string> = {
  ts: "ts", tsx: "tsx", mts: "ts", cts: "ts", js: "js", jsx: "jsx", mjs: "js", cjs: "js",
  py: "py", json: "json", jsonl: "jsonl", ipynb: "json", yaml: "yaml", yml: "yaml",
  toml: "toml", xml: "xml", css: "css", scss: "scss", less: "less", sql: "sql",
  sh: "sh", bash: "sh", zsh: "sh", ps1: "powershell", bat: "bat", vue: "vue",
  svelte: "svelte", graphql: "graphql", go: "go", rs: "rust", java: "java", kt: "kotlin",
  c: "c", h: "c", cpp: "cpp", hpp: "cpp", cc: "cpp", cs: "csharp", rb: "ruby", php: "php",
  swift: "swift", scala: "scala", r: "r", lua: "lua", pl: "perl", tex: "latex", rst: "rst",
  ini: "ini", cfg: "ini", conf: "ini", env: "dotenv", log: "log",
};

/** The highlighting language for a code file, or null when it isn't code. */
export function codeLanguage(path: string): string | null {
  return CODE_LANGUAGES[extension(path)] ?? null;
}

/**
 * Picks the preview from the file's type. Files stored before their extension
 * had a known type are `application/octet-stream`, so the extension decides then.
 */
export function previewKind(file: Pick<WorkspaceFile, "mime" | "path">): PreviewKind {
  const ext = extension(file.path);
  if (isTextFile(file)) {
    if (isMarkdown(file)) return "markdown";
    if (ext === "csv" || ext === "tsv") return "table";
    if (ext === "html" || ext === "htm" || file.mime === "text/html") return "html";
    return codeLanguage(file.path) ? "code" : "text";
  }
  const mime = !file.mime || file.mime === "application/octet-stream" ? mimeForPath(file.path) : file.mime;
  if (mime === "application/pdf") return "pdf";
  const top = mime.split("/")[0];
  return top === "image" || top === "audio" || top === "video" ? top : "none";
}
