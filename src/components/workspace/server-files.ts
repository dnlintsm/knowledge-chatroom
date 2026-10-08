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

/** A knowledge node id, or null for the workspace root. */
export type NodeId = string | null;

/** One committed change, from the /api/files?watch event stream. */
export type ServerEvent =
  | {
      op: "write" | "delete";
      node: NodeId;
      path: string;
      sha256?: string;
      author?: WorkspaceFile["author"];
    }
  | { op: "node"; change: "create" | "rename" | "delete"; id: string };

export const WATCH_URL = "/api/files?watch";

/** A level of the knowledge tree, such as tech (depth 1). */
export interface NodeType {
  name: string;
  depth: number;
}

export interface KnowledgeNode {
  id: string;
  parentId: string | null;
  type: string;
  depth: number;
  name: string;
  fileCount: number;
  updatedAt: string;
}

const nodeQuery = (node: NodeId) => (node ? `?node=${encodeURIComponent(node)}` : "");

export function fileUrl(path: string, node: NodeId = null) {
  return `/api/files/${path.split("/").map(encodeURIComponent).join("/")}${nodeQuery(node)}`;
}

/**
 * The file list; "starting" when storage (or the agent server) may just not be
 * up yet (503, 502, network error), so asking again shortly makes sense; null
 * when this session has no server storage (404 = not configured, 500 = failed).
 */
export async function listServerFiles(
  node: NodeId = null,
): Promise<ServerFile[] | "starting" | null> {
  try {
    const res = await fetch(`/api/files${nodeQuery(node)}`, { cache: "no-store" });
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
export async function loadServerFile(info: ServerFile, node: NodeId = null): Promise<WorkspaceFile> {
  const base = {
    path: info.path,
    kind: info.kind,
    mime: info.mime,
    author: info.author,
    updatedAt: Date.parse(info.updatedAt),
  };
  const url = fileUrl(info.path, node);
  if (!isTextFile(info)) {
    return { ...base, content: `${url}${url.includes("?") ? "&" : "?"}v=${info.sha256}` };
  }
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`GET ${info.path}: ${res.status}`);
  return { ...base, content: await res.text() };
}

export async function putServerFile(
  file: Pick<WorkspaceFile, "path" | "mime" | "content">,
  node: NodeId = null,
): Promise<ServerFile> {
  // Binary uploads arrive as data: URLs; send their bytes.
  const body =
    !isTextFile(file) && file.content.startsWith("data:")
      ? await (await fetch(file.content)).blob()
      : file.content;
  const res = await fetch(fileUrl(file.path, node), {
    method: "PUT",
    headers: { "Content-Type": file.mime },
    body,
  });
  if (!res.ok) throw new Error(`PUT ${file.path}: ${res.status}`);
  return (await res.json()) as ServerFile;
}

export async function deleteServerFile(path: string, node: NodeId = null): Promise<void> {
  const res = await fetch(fileUrl(path, node), { method: "DELETE" });
  if (!res.ok && res.status !== 404) throw new Error(`DELETE ${path}: ${res.status}`);
}

/** The knowledge tree's levels and nodes, or null when it can't be read. */
export async function listNodes(): Promise<{ types: NodeType[]; nodes: KnowledgeNode[] } | null> {
  try {
    const res = await fetch("/api/nodes", { cache: "no-store" });
    return res.ok ? ((await res.json()) as { types: NodeType[]; nodes: KnowledgeNode[] }) : null;
  } catch {
    return null;
  }
}

async function nodeRequest(method: string, path: string, body?: unknown): Promise<KnowledgeNode> {
  const res = await fetch(`/api/nodes${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = (await res.json().catch(() => ({}))) as KnowledgeNode & { error?: string };
  // The server's message says what to fix, e.g. a duplicate name.
  if (!res.ok) throw new Error(data.error ?? `${method} node: ${res.status}`);
  return data;
}

export const createServerNode = (parentId: NodeId, name: string) =>
  nodeRequest("POST", "", { parentId, name });
export const renameServerNode = (id: string, name: string) =>
  nodeRequest("PATCH", `/${encodeURIComponent(id)}`, { name });
export const deleteServerNode = (id: string) =>
  nodeRequest("DELETE", `/${encodeURIComponent(id)}`).then(() => undefined);
