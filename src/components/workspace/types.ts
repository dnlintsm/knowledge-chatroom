/**
 * Workspace model: a flat list of files keyed by path. The top-level folder of
 * a path decides what kind of item it is, which the left rail groups by.
 *
 * Files use optional agent-backed storage, with a browser-local fallback
 * (see store.tsx and docs/architecture.md).
 */

export type FileKind = "note" | "skill" | "upload" | "artifact";

export interface WorkspaceFile {
  path: string;
  kind: FileKind;
  /** Text content, or a data: URL for binary uploads such as images. */
  content: string;
  mime: string;
  updatedAt: number;
  /** Who last wrote the file. */
  author: "user" | "agent";
}

/** A tab in the middle pane: a file path, or the built-in task board. */
export type TabId = string;
export const TASKS_TAB: TabId = "::tasks";
/** The current experiment's hypothesis, params and results. */
export const EXPERIMENT_TAB: TabId = "::experiment";
/** Tabs that aren't files. */
export const isBuiltInTab = (tab: TabId) => tab === TASKS_TAB || tab === EXPERIMENT_TAB;

export const KIND_FOLDERS: Record<FileKind, string> = {
  note: "notes",
  skill: "skills",
  upload: "uploads",
  artifact: "artifacts",
};

export function kindForPath(path: string): FileKind {
  const top = path.split("/")[0];
  const match = (Object.keys(KIND_FOLDERS) as FileKind[]).find(
    (kind) => KIND_FOLDERS[kind] === top,
  );
  return match ?? "note";
}

export function fileName(path: string) {
  return path.split("/").pop() ?? path;
}

export function extension(path: string) {
  const name = fileName(path);
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot + 1).toLowerCase();
}

const TEXT_EXTENSIONS = new Set([
  "md", "markdown", "txt", "json", "csv", "ts", "tsx", "js", "jsx", "py",
  "yaml", "yml", "html", "css", "sql", "sh", "toml", "xml",
]);

export function mimeForPath(path: string) {
  const ext = extension(path);
  if (ext === "md" || ext === "markdown") return "text/markdown";
  if (ext === "json") return "application/json";
  if (ext === "csv") return "text/csv";
  if (TEXT_EXTENSIONS.has(ext)) return "text/plain";
  return "application/octet-stream";
}

export function isTextFile(file: Pick<WorkspaceFile, "mime" | "path">) {
  return (
    file.mime.startsWith("text/") ||
    file.mime === "application/json" ||
    TEXT_EXTENSIONS.has(extension(file.path))
  );
}

export function isMarkdown(file: Pick<WorkspaceFile, "mime" | "path">) {
  return file.mime === "text/markdown" || ["md", "markdown"].includes(extension(file.path));
}
