/**
 * Workspace paths, matching the UI's model: the top-level folder decides the
 * kind of file (notes/, skills/, uploads/, artifacts/; anything else is a note).
 */

export type FileKind = "note" | "skill" | "upload" | "artifact";

const KIND_FOLDERS: Record<string, FileKind> = {
  notes: "note",
  skills: "skill",
  uploads: "upload",
  artifacts: "artifact",
};

export class InvalidPathError extends Error {}

/** Normalizes a relative path and rejects anything that could escape the tree. */
export function normalizePath(raw: string): string {
  const path = raw.trim().replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+/g, "/");
  const segments = path.split("/");
  if (
    path === "" ||
    path.endsWith("/") ||
    path.length > 1024 ||
    segments.some((s) => s === "." || s === ".." || /[\u0000-\u001f]/.test(s))
  ) {
    throw new InvalidPathError(`Invalid path: ${JSON.stringify(raw)}`);
  }
  return path;
}

export function kindForPath(path: string): FileKind {
  return KIND_FOLDERS[path.split("/")[0]] ?? "note";
}

const MIME_BY_EXT: Record<string, string> = {
  md: "text/markdown",
  markdown: "text/markdown",
  txt: "text/plain",
  csv: "text/csv",
  json: "application/json",
  html: "text/html",
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
};

export function mimeForPath(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}
