import { FileExistsError, isTextFile, ReadOnlyFileError, type FileKind, type WorkspaceFile } from "./types";

/**
 * Client for the server file API (/api/files, forwarded to the agent's
 * storage service). When it answers, workspace files live on the server;
 * otherwise the workspace keeps them in the browser (see store.tsx).
 */

export interface ServerFile {
  path: string;
  kind: FileKind;
  mime: string;
  size: number;
  sha256: string;
  updatedAt: string;
  author: WorkspaceFile["author"];
  readOnly?: boolean;
}

/** One committed change, from the /api/files?watch event stream. */
export interface ServerFileEvent {
  op: "write" | "delete";
  path: string;
  sha256?: string;
  author?: WorkspaceFile["author"];
}

export const WATCH_URL = "/api/files?watch";

export function fileUrl(path: string) {
  return `/api/files/${path.split("/").map(encodeURIComponent).join("/")}`;
}

/**
 * The file list; "starting" when storage (or the agent server) may just not be
 * up yet (503, 502, network error), so asking again shortly makes sense; null
 * when this session has no server storage (404 = not configured, 500 = failed).
 */
export async function listServerFiles(): Promise<ServerFile[] | "starting" | null> {
  try {
    const res = await fetch("/api/files", { cache: "no-store" });
    if (res.ok) return ((await res.json()) as { files: ServerFile[] }).files;
    return res.status === 503 || res.status === 502 ? "starting" : null;
  } catch {
    return "starting";
  }
}

/**
 * Loads a file into the workspace model. Text is fetched; binary files point
 * at their URL (versioned by hash so caches never show stale bytes), which
 * works anywhere the UI used a data: URL, like <img src>.
 */
export async function loadServerFile(info: ServerFile): Promise<WorkspaceFile> {
  const base = {
    path: info.path,
    kind: info.kind,
    mime: info.mime,
    author: info.author,
    updatedAt: Date.parse(info.updatedAt),
    ...(info.readOnly ? { readOnly: true } : {}),
  };
  if (!isTextFile(info)) return { ...base, content: `${fileUrl(info.path)}?v=${info.sha256}` };
  const res = await fetch(fileUrl(info.path), { cache: "no-store" });
  if (!res.ok) throw new Error(`GET ${info.path}: ${res.status}`);
  return { ...base, content: await res.text() };
}

/**
 * Saves a file. With `createOnly` the server refuses to replace an existing
 * file (FileExistsError); `readOnly` makes a newly created file read-only.
 * Writing a read-only file throws ReadOnlyFileError.
 */
export async function putServerFile(
  file: Pick<WorkspaceFile, "path" | "mime" | "content">,
  opts: { createOnly?: boolean; readOnly?: boolean } = {},
): Promise<ServerFile> {
  // Binary uploads arrive as data: URLs; send their bytes.
  const body =
    !isTextFile(file) && file.content.startsWith("data:")
      ? await (await fetch(file.content)).blob()
      : file.content;
  const headers: Record<string, string> = { "Content-Type": file.mime };
  if (opts.createOnly) headers["If-None-Match"] = "*";
  if (opts.readOnly) headers["X-Read-Only"] = "true";
  const res = await fetch(fileUrl(file.path), { method: "PUT", headers, body });
  if (res.status === 412) throw new FileExistsError(file.path);
  if (res.status === 403) throw new ReadOnlyFileError(file.path);
  if (!res.ok) throw new Error(`PUT ${file.path}: ${res.status}`);
  return (await res.json()) as ServerFile;
}

/** Asks the server itself, not the local copy of the file list. */
export async function serverFileExists(path: string): Promise<boolean> {
  const res = await fetch(fileUrl(path), { method: "GET", cache: "no-store" });
  await res.body?.cancel();
  if (res.ok) return true;
  if (res.status === 404) return false;
  throw new Error(`GET ${path}: ${res.status}`);
}

export async function deleteServerFile(path: string): Promise<void> {
  const res = await fetch(fileUrl(path), { method: "DELETE" });
  if (res.status === 403) throw new ReadOnlyFileError(path);
  if (!res.ok && res.status !== 404) throw new Error(`DELETE ${path}: ${res.status}`);
}
