import { isTextFile, type FileKind, type WorkspaceFile } from "./types";

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
  };
  if (!isTextFile(info)) return { ...base, content: `${fileUrl(info.path)}?v=${info.sha256}` };
  const res = await fetch(fileUrl(info.path), { cache: "no-store" });
  if (!res.ok) throw new Error(`GET ${info.path}: ${res.status}`);
  return { ...base, content: await res.text() };
}

export async function putServerFile(
  file: Pick<WorkspaceFile, "path" | "mime" | "content">,
): Promise<ServerFile> {
  // Binary uploads arrive as data: URLs; send their bytes.
  const body =
    !isTextFile(file) && file.content.startsWith("data:")
      ? await (await fetch(file.content)).blob()
      : file.content;
  const res = await fetch(fileUrl(file.path), {
    method: "PUT",
    headers: { "Content-Type": file.mime },
    body,
  });
  if (!res.ok) throw new Error(`PUT ${file.path}: ${res.status}`);
  return (await res.json()) as ServerFile;
}

export async function deleteServerFile(path: string): Promise<void> {
  const res = await fetch(fileUrl(path), { method: "DELETE" });
  if (!res.ok && res.status !== 404) throw new Error(`DELETE ${path}: ${res.status}`);
}
