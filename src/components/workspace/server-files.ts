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

/**
 * Where a set of files lives: the workspace root (null), a knowledge node (its
 * id), or an experiment (experimentPlace(id)).
 */
export type PlaceId = string | null;
const EXPERIMENT_PREFIX = "x:";
export const experimentPlace = (id: string): PlaceId => `${EXPERIMENT_PREFIX}${id}`;
/** The experiment a place is, or null for the root and nodes. */
export const experimentOf = (place: PlaceId) =>
  place?.startsWith(EXPERIMENT_PREFIX) ? place.slice(EXPERIMENT_PREFIX.length) : null;

/** One committed change, from the /api/files?watch event stream. */
export type ServerEvent =
  | {
      op: "write" | "delete";
      node: NodeId;
      /** Set for an experiment's files (node is then null). */
      experiment?: string | null;
      path: string;
      sha256?: string;
      author?: WorkspaceFile["author"];
    }
  | { op: "node"; change: "create" | "rename" | "delete"; id: string }
  | { op: "experiment"; change: "create" | "update" | "status" | "delete"; id: string; node: string };

/** The place a file event is about. */
export const eventPlace = (event: { node: NodeId; experiment?: string | null }): PlaceId =>
  event.experiment ? experimentPlace(event.experiment) : event.node;

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

function placeQuery(place: PlaceId) {
  if (!place) return "";
  const experiment = experimentOf(place);
  return experiment ? `?experiment=${encodeURIComponent(experiment)}` : `?node=${encodeURIComponent(place)}`;
}

export function fileUrl(path: string, place: PlaceId = null) {
  return `/api/files/${path.split("/").map(encodeURIComponent).join("/")}${placeQuery(place)}`;
}

/**
 * The file list; "starting" when storage (or the agent server) may just not be
 * up yet (503, 502, network error), so asking again shortly makes sense; null
 * when this session has no server storage (404 = not configured, 500 = failed).
 * A place you have no access to lists as empty.
 */
export async function listServerFiles(
  place: PlaceId = null,
): Promise<ServerFile[] | "starting" | null> {
  try {
    const res = await apiFetch(`/api/files${placeQuery(place)}`, { cache: "no-store" });
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
export async function loadServerFile(info: ServerFile, place: PlaceId = null): Promise<WorkspaceFile> {
  const base = {
    path: info.path,
    kind: info.kind,
    mime: info.mime,
    author: info.author,
    updatedAt: Date.parse(info.updatedAt),
  };
  const url = fileUrl(info.path, place);
  if (!isTextFile(info)) {
    return { ...base, content: `${url}${url.includes("?") ? "&" : "?"}v=${info.sha256}` };
  }
  const res = await apiFetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`GET ${info.path}: ${res.status}`);
  return { ...base, content: await res.text() };
}

export async function putServerFile(
  file: Pick<WorkspaceFile, "path" | "mime" | "content">,
  place: PlaceId = null,
): Promise<ServerFile> {
  // Binary uploads arrive as data: URLs; send their bytes.
  const body =
    !isTextFile(file) && file.content.startsWith("data:")
      ? await (await fetch(file.content)).blob()
      : file.content;
  const res = await apiFetch(fileUrl(file.path, place), {
    method: "PUT",
    headers: { "Content-Type": file.mime },
    body,
  });
  if (res.status === 403) throw new Error(`You can't change files here (${file.path})`);
  if (!res.ok) throw new Error(`PUT ${file.path}: ${res.status}`);
  return (await res.json()) as ServerFile;
}

export async function deleteServerFile(path: string, place: PlaceId = null): Promise<void> {
  const res = await apiFetch(fileUrl(path, place), { method: "DELETE" });
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

export type ExperimentStatus = "draft" | "shared" | "archived";

/** A sandbox on a knowledge node, with its own copy of the node's files. */
export interface Experiment {
  id: string;
  nodeId: string;
  authorId: string;
  authorName: string | null;
  title: string;
  hypothesis: string;
  params: Record<string, unknown>;
  results: Record<string, unknown>;
  status: ExperimentStatus;
  forkedAt: string;
  updatedAt: string;
  fileCount: number;
  /** writer: you are its author and it isn't archived. */
  access: "writer" | "reader";
  /** You are its author: you may share, archive, restore or delete it. */
  mine: boolean;
}

export type ExperimentChange = Partial<
  Pick<Experiment, "title" | "hypothesis" | "params" | "results" | "status">
>;

/** Experiments you can see, anywhere in the tree; null when they can't be read. */
export async function listExperiments(): Promise<Experiment[] | null> {
  try {
    const res = await apiFetch("/api/experiments", { cache: "no-store" });
    return res.ok ? ((await res.json()) as { experiments: Experiment[] }).experiments : null;
  } catch {
    return null;
  }
}

async function experimentRequest(method: string, path: string, body?: unknown): Promise<Experiment> {
  const res = await apiFetch(`/api/experiments${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = (await res.json().catch(() => ({}))) as Experiment & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `${method} experiment: ${res.status}`);
  return data;
}

export const createServerExperiment = (nodeId: string, title: string) =>
  experimentRequest("POST", "", { nodeId, title });
export const updateServerExperiment = (id: string, change: ExperimentChange) =>
  experimentRequest("PATCH", `/${encodeURIComponent(id)}`, change);
export const deleteServerExperiment = (id: string) =>
  experimentRequest("DELETE", `/${encodeURIComponent(id)}`).then(() => undefined);

/** A file whose text or path matched a search (agent/src/storage/search.ts). */
export interface SearchHit {
  path: string;
  kind: FileKind;
  mime: string;
  node: NodeId;
  experiment: string | null;
  /** Node names from the top down to the file's node (an experiment's node for its files). */
  where: string[];
  experimentTitle: string | null;
  /** The passage that matched; "" when only the path did. */
  snippet: string;
  updatedAt: string;
}

/**
 * Files you can read that match `query`, best first; those near `near` (where
 * you are) come first, and `scope` keeps to one node and what is below it.
 */
export async function searchFiles(
  query: string,
  opts: { near?: PlaceId; scope?: string | null; signal?: AbortSignal } = {},
): Promise<SearchHit[]> {
  const params = new URLSearchParams({ q: query });
  const experiment = experimentOf(opts.near ?? null);
  if (experiment) params.set("experiment", experiment);
  else if (opts.near) params.set("near", opts.near);
  if (opts.scope) params.set("scope", opts.scope);
  const res = await apiFetch(`/api/search?${params}`, { cache: "no-store", signal: opts.signal });
  const data = (await res.json().catch(() => ({}))) as { results?: SearchHit[]; error?: string };
  if (!res.ok || !data.results) throw new Error(data.error ?? `Search failed (${res.status})`);
  return data.results;
}

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
