import { KIND_FOLDERS, normalizePath, type FileKind } from "./files";

export type AuthorType = "user" | "agent";

/** JSON metadata returned by the storage HTTP API. */
export interface FileInfo {
  path: string;
  kind: FileKind;
  mime: string;
  size: number;
  sha256: string;
  updatedAt: string;
  author: AuthorType;
}

export interface FileEvent {
  op: "write" | "delete";
  node: string | null;
  experiment?: string | null;
  path: string;
  sha256?: string;
  author?: AuthorType;
}

export interface NodeEvent {
  op: "node";
  change: "create" | "rename" | "delete" | "restrict" | "unrestrict" | "takeover";
  id: string;
  /** On restrict: who lost access to it, so their open trees drop it too. */
  left?: string[];
}

export interface ExperimentEvent {
  op: "experiment";
  change: "create" | "update" | "status" | "delete" | "restore";
  id: string;
  /** null: an experiment at the workspace root. */
  node: string | null;
  /**
   * Users who just stopped working on it (a collaborator removed or leaving, a
   * previous maintainer not kept on). They hear this change even when they can't
   * see the experiment any more, so an open draft closes for them.
   */
  left?: string[];
}

export interface ProposalEvent {
  op: "proposal";
  change: "create" | "update" | "accepted" | "rejected" | "withdrawn";
  id: string;
  node: string | null;
  path: string;
  author: AuthorType;
  authorId: string;
}

/** A Run changed. Its Experiment's update event follows it. */
export interface RunEvent {
  op: "run";
  change: "create" | "finish" | "update" | "archive" | "delete" | "restore";
  id: string;
  experiment: string;
  /** The Experiment's node; null at the workspace root. */
  node: string | null;
}

export type WorkspaceEvent = FileEvent | NodeEvent | ExperimentEvent | RunEvent | ProposalEvent;

export class StorageContractError extends TypeError {}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new StorageContractError("Expected storage JSON object");
  return value as Record<string, unknown>;
}

const author = (value: unknown) => value === "user" || value === "agent";
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const hash = (value: unknown) => text(value) && /^[a-f0-9]{64}$/.test(value);
const canonicalPath = (value: unknown) => {
  try { return text(value) && normalizePath(value) === value; }
  catch { return false; }
};

/** Validate untrusted JSON once at the browser boundary, allowing extra fields. */
export function parseFileInfo(value: unknown): FileInfo {
  const item = object(value);
  if (!canonicalPath(item.path) ||
      (!text(item.kind) || !Object.keys(KIND_FOLDERS).includes(item.kind)) ||
      !text(item.mime) || !hash(item.sha256) || !author(item.author) ||
      typeof item.size !== "number" || !Number.isSafeInteger(item.size) || item.size < 0 ||
      !text(item.updatedAt) || !Number.isFinite(Date.parse(item.updatedAt))) {
    throw new StorageContractError("Invalid storage file metadata");
  }
  // Fields an older server still sends (readOnly) or a newer one adds are left as they are.
  return item as unknown as FileInfo;
}

export function parseFileList(value: unknown): FileInfo[] {
  const item = object(value);
  if (!Array.isArray(item.files)) throw new StorageContractError("Invalid storage file list");
  return item.files.map(parseFileInfo);
}

export function parseWorkspaceEvent(value: unknown): WorkspaceEvent {
  const item = object(value);
  if (item.op === "write" || item.op === "delete") {
    if ((item.node === null || text(item.node)) && canonicalPath(item.path) &&
        (item.experiment === undefined || item.experiment === null || text(item.experiment)) &&
        (item.sha256 === undefined || hash(item.sha256)) &&
        (item.author === undefined || author(item.author))) return item as unknown as FileEvent;
  } else if (item.op === "node") {
    if (text(item.id) && text(item.change) && ["create", "rename", "delete", "restrict", "unrestrict", "takeover"].includes(item.change)) return item as unknown as NodeEvent;
  } else if (item.op === "experiment") {
    if (text(item.id) && (item.node === null || text(item.node)) && text(item.change) && ["create", "update", "status", "delete", "restore"].includes(item.change)) return item as unknown as ExperimentEvent;
  } else if (item.op === "run") {
    if (text(item.id) && text(item.experiment) && (item.node === null || text(item.node)) && text(item.change) &&
        ["create", "finish", "update", "archive", "delete", "restore"].includes(item.change)) return item as unknown as RunEvent;
  }
  if (item.op === "proposal" && text(item.id) && (item.node === null || text(item.node)) &&
      canonicalPath(item.path) && author(item.author) && text(item.authorId) && text(item.change) &&
      ["create", "update", "accepted", "rejected", "withdrawn"].includes(item.change)) {
    return item as unknown as ProposalEvent;
  }
  throw new StorageContractError("Invalid storage event");
}

/** In-memory/persisted content: timestamps are numeric; binary content is a URL. */
export interface LocalFile {
  path: string;
  kind: FileKind;
  content: string;
  mime: string;
  updatedAt: number;
  author: AuthorType;
}

export function parseLocalFile(value: unknown): LocalFile {
  const item = object(value);
  if (!canonicalPath(item.path) || !text(item.kind) || !Object.keys(KIND_FOLDERS).includes(item.kind) ||
      typeof item.content !== "string" || !text(item.mime) || !author(item.author) ||
      typeof item.updatedAt !== "number" || !Number.isFinite(item.updatedAt)) {
    throw new StorageContractError("Invalid persisted workspace file");
  }
  return item as unknown as LocalFile;
}
