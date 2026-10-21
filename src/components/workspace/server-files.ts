import { parseFileInfo, parseFileList, StorageContractError } from "../../../shared/storage-contract";
import type { FileInfo as ServerFile } from "../../../shared/storage-contract";
export type { FileInfo as ServerFile, WorkspaceEvent as ServerEvent } from "../../../shared/storage-contract";
import { FileExistsError, isTextFile, ReadOnlyFileError, type FileKind, type WorkspaceFile } from "./types";

/**
 * Client for the server file API (/api/files, forwarded to the agent's
 * storage service). When it answers, workspace files live on the server;
 * otherwise the workspace keeps them in the browser (see store.tsx).
 */

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
    if (res.ok) {
      try { return parseFileList(await res.json()); }
      catch { throw new StorageContractError("Storage returned invalid file metadata"); }
    }
    // Signed in, but nothing here is shared with you (e.g. the workspace root).
    if (res.status === 403) return [];
    return res.status === 503 || res.status === 502 ? "starting" : null;
  } catch (error) {
    if (error instanceof StorageContractError) throw error;
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
    ...(info.readOnly ? { readOnly: true } : {}),
  };
  const url = fileUrl(info.path, place);
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
  place: PlaceId = null,
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
  const res = await apiFetch(fileUrl(file.path, place), { method: "PUT", headers, body });
  if (res.status === 412) throw new FileExistsError(file.path);
  if (res.status === 403) {
    const answer = (await res.json().catch(() => null)) as { readOnly?: boolean } | null;
    if (answer?.readOnly) throw new ReadOnlyFileError(file.path);
    throw new Error(`You can't change files here (${file.path})`);
  }
  if (!res.ok) throw new Error(`PUT ${file.path}: ${res.status}`);
  return parseFileInfo(await res.json());
}

/** Asks the server itself, not the local copy of the file list. */
export async function serverFileExists(path: string, place: PlaceId = null): Promise<boolean> {
  const res = await apiFetch(fileUrl(path, place), { method: "GET", cache: "no-store" });
  await res.body?.cancel();
  if (res.ok) return true;
  if (res.status === 404) return false;
  throw new Error(`GET ${path}: ${res.status}`);
}

export async function deleteServerFile(path: string, place: PlaceId = null): Promise<void> {
  const res = await apiFetch(fileUrl(path, place), { method: "DELETE" });
  if (res.status === 403) {
    const answer = (await res.json().catch(() => null)) as { readOnly?: boolean } | null;
    if (answer?.readOnly) throw new ReadOnlyFileError(path);
  }
  if (!res.ok && res.status !== 404) throw new Error(`DELETE ${path}: ${res.status}`);
}

/** Renames a file within its place, keeping its history. */
export async function renameServerFile(from: string, to: string, place: PlaceId = null): Promise<ServerFile> {
  const res = await apiFetch(fileUrl(from, place), {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: to }),
  });
  if (res.status === 412) throw new FileExistsError(to);
  if (res.status === 403) {
    const answer = (await res.json().catch(() => null)) as { readOnly?: boolean } | null;
    if (answer?.readOnly) throw new ReadOnlyFileError(from);
    throw new Error(`You can't change files here (${from})`);
  }
  if (!res.ok) throw new Error(`Couldn't rename ${from}: ${res.status}`);
  return parseFileInfo(await res.json());
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
/** How far a run got, apart from who sees it (status). */
export type ExperimentState = "ready" | "running" | "done" | "failed";

/**
 * A sandbox on a knowledge node, with its own copy of the node's files, or
 * at the workspace root (nodeId null), starting empty. One with a report.md
 * is a run.
 */
export interface Experiment {
  id: string;
  nodeId: string | null;
  authorId: string;
  authorName: string | null;
  title: string;
  hypothesis: string;
  params: Record<string, unknown>;
  results: Record<string, unknown>;
  status: ExperimentStatus;
  state: ExperimentState;
  forkedAt: string;
  updatedAt: string;
  fileCount: number;
  /** Where a run came from, when Claude started it (agent/src/storage/run-report.ts); else {}. */
  provenance?: RunProvenance;
  /** writer: you are its author and it isn't archived. */
  access: "writer" | "reader";
  /** You are its author: you may share, archive, restore or delete it. */
  mine: boolean;
}

/** Recorded by the agent; every field may be missing on older or hand-made runs. */
export interface RunProvenance {
  startedBy?: { id: string; name: string | null };
  startedAt?: string;
  finishedAt?: string;
  chat?: string | null;
  model?: string | null;
  skill?: { name: string; source?: string; version?: number; sha256?: string };
  /** The run this one ran again. */
  rerunOf?: { id: string };
  tools?: Record<string, string>;
  inputs?: {
    path: string;
    from: { node: string | null; experiment: string | null; path: string };
    version: string;
    sha256: string;
    size: number;
  }[];
}

export type ExperimentChange = Partial<
  Pick<Experiment, "title" | "hypothesis" | "params" | "results" | "status" | "state">
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

export const createServerExperiment = (nodeId: string | null, title: string) =>
  experimentRequest("POST", "", { nodeId, title });
/** Moves a folder's files into a new experiment of yours (needs editor where the folder is). */
export const serverExperimentFromFolder = (nodeId: string | null, folder: string) =>
  apiFetch("/api/experiments/from-folder", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ nodeId, folder }),
  }).then(async (res) => {
    const data = (await res.json().catch(() => ({}))) as { experiment?: Experiment; error?: string };
    if (!res.ok || !data.experiment) throw new Error(data.error ?? `Convert folder: ${res.status}`);
    return data.experiment;
  });
export const updateServerExperiment = (id: string, change: ExperimentChange) =>
  experimentRequest("PATCH", `/${encodeURIComponent(id)}`, change);
export const deleteServerExperiment = (id: string) =>
  experimentRequest("DELETE", `/${encodeURIComponent(id)}`).then(() => undefined);

export type ProposalStatus = "open" | "accepted" | "rejected" | "withdrawn";

/**
 * A proposed version of a file in a node (or at the root), waiting for someone
 * who can edit there to accept or reject it (agent/src/storage/proposals.ts).
 */
export interface Proposal {
  id: string;
  node: NodeId;
  path: string;
  sha256: string;
  size: number;
  mime: string;
  /** agent: Claude proposed it, acting for authorName. */
  author: WorkspaceFile["author"];
  authorId: string;
  authorName: string | null;
  /** The experiment it was promoted from, if any (and its title, if you may see it). */
  experiment: string | null;
  experimentTitle: string | null;
  note: string;
  status: ProposalStatus;
  decidedByName: string | null;
  decidedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Accepting creates the file. */
  isNew: boolean;
  /** The file changed after this was proposed. */
  fileChanged: boolean;
  /** You proposed it, so you may withdraw it. */
  mine: boolean;
  /** You may accept or reject it. */
  canDecide: boolean;
}

/** A file an experiment changed that its node doesn't have yet. */
export interface Promotable {
  path: string;
  change: "new" | "changed";
  size: number;
  mime: string;
  /** This experiment's open proposal with exactly this content, if any. */
  proposal: string | null;
}

/** Open proposals you can see, everywhere; null when they can't be read. */
export async function listProposals(): Promise<Proposal[] | null> {
  try {
    const res = await apiFetch("/api/proposals", { cache: "no-store" });
    return res.ok ? ((await res.json()) as { proposals: Proposal[] }).proposals : null;
  } catch {
    return null;
  }
}

async function proposalRequest<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await apiFetch(`/api/proposals${path}`, {
    method,
    cache: "no-store",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `${method} proposal: ${res.status}`);
  return data;
}

/** The proposed content as text. */
export async function proposalText(id: string): Promise<string> {
  const res = await apiFetch(`/api/proposals/${encodeURIComponent(id)}/content`, { cache: "no-store" });
  if (!res.ok) throw new Error(`Couldn't load the proposed version (${res.status})`);
  return res.text();
}

export const decideProposal = (id: string, decision: "accept" | "reject" | "withdraw") =>
  proposalRequest<Proposal>("POST", `/${encodeURIComponent(id)}/${decision}`);

/** Proposes an experiment's changed files (all, or `paths`) to its node. */
export const promoteExperiment = (experimentId: string, paths?: string[], note?: string) =>
  proposalRequest<{ proposals: Proposal[] }>("POST", "", { experimentId, paths, note }).then((r) => r.proposals);

export const listPromotable = (experimentId: string) =>
  proposalRequest<{ files: Promotable[] }>(
    "GET",
    `/promotable?experiment=${encodeURIComponent(experimentId)}`,
  ).then((r) => r.files);

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
  /** "meaning": no words in common, but a passage close in meaning. */
  match: "words" | "meaning";
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
