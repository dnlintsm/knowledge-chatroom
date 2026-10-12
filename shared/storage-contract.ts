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
  readOnly: boolean;
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
  change: "create" | "rename" | "delete";
  id: string;
}

export interface ExperimentEvent {
  op: "experiment";
  change: "create" | "update" | "status" | "delete";
  id: string;
  node: string;
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

export type WorkspaceEvent = FileEvent | NodeEvent | ExperimentEvent | ProposalEvent;

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
      !text(item.updatedAt) || !Number.isFinite(Date.parse(item.updatedAt)) ||
      (item.readOnly !== undefined && typeof item.readOnly !== "boolean")) {
    throw new StorageContractError("Invalid storage file metadata");
  }
  return { ...item, readOnly: item.readOnly ?? false } as unknown as FileInfo;
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
    if (text(item.id) && text(item.change) && ["create", "rename", "delete"].includes(item.change)) return item as unknown as NodeEvent;
  } else if (item.op === "experiment") {
    if (text(item.id) && text(item.node) && text(item.change) && ["create", "update", "status", "delete"].includes(item.change)) return item as unknown as ExperimentEvent;
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
  readOnly?: boolean;
}

export function parseLocalFile(value: unknown): LocalFile {
  const item = object(value);
  if (!canonicalPath(item.path) || !text(item.kind) || !Object.keys(KIND_FOLDERS).includes(item.kind) ||
      typeof item.content !== "string" || !text(item.mime) || !author(item.author) ||
      typeof item.updatedAt !== "number" || !Number.isFinite(item.updatedAt) ||
      (item.readOnly !== undefined && typeof item.readOnly !== "boolean")) {
    throw new StorageContractError("Invalid persisted workspace file");
  }
  return item as unknown as LocalFile;
}
