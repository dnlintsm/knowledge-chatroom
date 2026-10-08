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

/** viewer reads, editor also writes, owner also deletes and shares. */
export type Role = "viewer" | "editor" | "owner";

export interface KnowledgeNode {
  id: string;
  parentId: string | null;
  type: string;
  depth: number;
  name: string;
  fileCount: number;
  updatedAt: string;
  /** Your role here; null when shown only as the path to something you can see. */
  role: Role | null;
}

export interface KnowledgeTree {
  types: NodeType[];
  /** Your role at the workspace root (root files and top-level nodes). */
  rootRole: Role | null;
  nodes: KnowledgeNode[];
}

/**
 * fetch for the storage API. With login on, a 401 means the session ended,
 * so the browser goes to sign in again and comes back here.
 */
export async function apiFetch(input: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(input, init);
  if (res.status === 401 && typeof window !== "undefined") {
    const here = window.location.pathname + window.location.search;
    window.location.assign(`/api/auth/login?returnTo=${encodeURIComponent(here)}`);
    // Nothing more happens on this page.
    await new Promise(() => {});
  }
  return res;
}

const nodeQuery = (node: NodeId) => (node ? `?node=${encodeURIComponent(node)}` : "");

export function fileUrl(path: string, node: NodeId = null) {
  return `/api/files/${path.split("/").map(encodeURIComponent).join("/")}${nodeQuery(node)}`;
}

/**
 * The file list; "starting" when storage (or the agent server) may just not be
 * up yet (503, 502, network error), so asking again shortly makes sense; null
 * when this session has no server storage (404 = not configured, 500 = failed).
 * A place you have no access to lists as empty.
 */
export async function listServerFiles(
  node: NodeId = null,
): Promise<ServerFile[] | "starting" | null> {
  try {
    const res = await apiFetch(`/api/files${nodeQuery(node)}`, { cache: "no-store" });
    if (res.ok) return ((await res.json()) as { files: ServerFile[] }).files;
    // Signed in, but nothing here is shared with you (e.g. the workspace root).
    if (res.status === 403) return [];
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
    ...(info.readOnly ? { readOnly: true } : {}),
  };
  const url = fileUrl(info.path, node);
  if (!isTextFile(info)) {
    return { ...base, content: `${url}${url.includes("?") ? "&" : "?"}v=${info.sha256}` };
  }
  const res = await apiFetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`GET ${info.path}: ${res.status}`);
  return { ...base, content: await res.text() };
}

/**
 * Saves a file. With `createOnly` the server refuses to replace an existing
 * file (FileExistsError); `readOnly` makes a newly created file read-only.
 * Writing a read-only file throws ReadOnlyFileError.
 */
export async function putServerFile(
  file: Pick<WorkspaceFile, "path" | "mime" | "content" | "readOnly">,
  node: NodeId = null,
  opts: { createOnly?: boolean; readOnly?: boolean } = {},
): Promise<ServerFile> {
  // Binary uploads arrive as data: URLs; send their bytes.
  const body =
    !isTextFile(file) && file.content.startsWith("data:")
      ? await (await fetch(file.content)).blob()
      : file.content;
  const headers: Record<string, string> = { "Content-Type": file.mime };
  if (opts.createOnly) headers["If-None-Match"] = "*";
  // A read-only browser file stays read-only when it first moves to the server.
  if (opts.readOnly ?? file.readOnly) headers["X-Read-Only"] = "true";
  const res = await apiFetch(fileUrl(file.path, node), { method: "PUT", headers, body });
  if (res.status === 412) throw new FileExistsError(file.path);
  if (res.status === 403) {
    const answer = (await res.json().catch(() => null)) as { readOnly?: boolean } | null;
    if (answer?.readOnly) throw new ReadOnlyFileError(file.path);
    throw new Error(`You can't change files here (${file.path})`);
  }
  if (!res.ok) throw new Error(`PUT ${file.path}: ${res.status}`);
  return (await res.json()) as ServerFile;
}

/** Asks the server itself, not the local copy of the file list. */
export async function serverFileExists(path: string, node: NodeId = null): Promise<boolean> {
  const res = await apiFetch(fileUrl(path, node), { method: "GET", cache: "no-store" });
  await res.body?.cancel();
  if (res.ok) return true;
  if (res.status === 404) return false;
  throw new Error(`GET ${path}: ${res.status}`);
}

export async function deleteServerFile(path: string, node: NodeId = null): Promise<void> {
  const res = await apiFetch(fileUrl(path, node), { method: "DELETE" });
  if (res.status === 403) {
    const answer = (await res.json().catch(() => null)) as { readOnly?: boolean } | null;
    if (answer?.readOnly) throw new ReadOnlyFileError(path);
  }
  if (!res.ok && res.status !== 404) throw new Error(`DELETE ${path}: ${res.status}`);
}

/** The knowledge tree's levels and the nodes you can see, or null when it can't be read. */
export async function listNodes(): Promise<KnowledgeTree | null> {
  try {
    const res = await apiFetch("/api/nodes", { cache: "no-store" });
    return res.ok ? ((await res.json()) as KnowledgeTree) : null;
  } catch {
    return null;
  }
}

async function nodeRequest(method: string, path: string, body?: unknown): Promise<KnowledgeNode> {
  const res = await apiFetch(`/api/nodes${path}`, {
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

/** Whether login is on, and who is signed in (null without login). */
export interface Account {
  login: boolean;
  user: { name: string | null; email: string | null } | null;
}

export async function getAccount(): Promise<Account> {
  try {
    const res = await fetch("/api/auth/me", { cache: "no-store" });
    if (res.ok) return (await res.json()) as Account;
  } catch {
    // Treated as no login, like before it existed.
  }
  return { login: false, user: null };
}
