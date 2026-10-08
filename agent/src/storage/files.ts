import type { BlobStore } from "./blobs";
import { sha256Hex } from "./blobs";
import type { Sql, Tx } from "./db";
import type { AuthorType, EventHub } from "./events";
import { lockLiveExperiment } from "./experiments";
import { isNodeId, NodeService } from "./nodes";
import { kindForPath, mimeForPath, normalizePath, type FileKind } from "./paths";

export type { AuthorType, FileEvent } from "./events";

export interface FileInfo {
  path: string;
  kind: FileKind;
  mime: string;
  size: number;
  sha256: string;
  updatedAt: string;
  author: AuthorType;
  /** Set when the file was created read-only; it can then never change or be deleted. */
  readOnly: boolean;
}

/** A write or delete of a read-only file. */
export class ReadOnlyFileError extends Error {
  constructor(readonly path: string) {
    super(`${path} is read-only`);
    this.name = "ReadOnlyFileError";
  }
}

/** A create-only write to a path that already has a file. */
export class FileExistsError extends Error {
  constructor(readonly path: string) {
    super(`${path} already exists`);
    this.name = "FileExistsError";
  }
}

export interface FileVersion {
  id: string;
  sha256: string;
  size: number;
  mime: string;
  author: AuthorType;
  authorId: string | null;
  createdAt: string;
}

export interface WriteOptions {
  mime?: string;
  author?: AuthorType;
  authorId?: string | null;
  /** Runs inside the write's transaction when it adds a version (e.g. audit). */
  inTx?: (tx: Tx) => Promise<unknown>;
  /** Fail with FileExistsError instead of replacing an existing file. */
  createOnly?: boolean;
  /** Make a newly created file read-only. Has no effect on an existing file. */
  readOnly?: boolean;
}

interface FileRow {
  path: string;
  kind: FileKind;
  mime: string;
  size: string;
  sha256: string;
  updated_at: Date;
  author_type: AuthorType;
  read_only: boolean;
}

function toInfo(row: FileRow): FileInfo {
  return {
    path: row.path,
    kind: row.kind,
    mime: row.mime,
    size: Number(row.size),
    sha256: row.sha256,
    updatedAt: row.updated_at.toISOString(),
    author: row.author_type,
    readOnly: row.read_only,
  };
}

/**
 * Files in one workspace, at its root, in one knowledge node or in one
 * experiment (each has its own paths). Every write adds an immutable version; reads return the current
 * one. Bytes go to the BlobStore first, so a crash can leave an unreferenced
 * blob (harmless, collectable later) but never a dangling row.
 */
export class FileService {
  constructor(
    private readonly sql: Sql,
    private readonly blobs: BlobStore,
    private readonly events: EventHub,
    private readonly workspaceId: string,
    /** null = the workspace root (or an experiment, below). */
    readonly nodeId: string | null = null,
    /** Set for an experiment's files; nodeId is then null. */
    readonly experimentId: string | null = null,
  ) {}

  /** The same files through another connection or transaction (see db.ts asUser). */
  withSql(sql: Sql): FileService {
    return new FileService(sql, this.blobs, this.events, this.workspaceId, this.nodeId, this.experimentId);
  }

  /** The same workspace's files in another node (null = root), or null if that node doesn't exist. */
  async inNode(nodeId: string | null): Promise<FileService | null> {
    if (nodeId === this.nodeId) return this;
    if (nodeId !== null) {
      if (!isNodeId(nodeId)) return null;
      const [row] = await this.sql`
        SELECT 1 FROM nodes
        WHERE id = ${nodeId} AND workspace_id = ${this.workspaceId} AND deleted_at IS NULL`;
      if (!row) return null;
    }
    return new FileService(this.sql, this.blobs, this.events, this.workspaceId, nodeId);
  }

  /** An experiment's files, or null if it doesn't exist (see experiments.ts). */
  async inExperiment(experimentId: string): Promise<FileService | null> {
    if (experimentId === this.experimentId) return this;
    if (!isNodeId(experimentId)) return null;
    const [row] = await this.sql`
      SELECT 1 FROM experiments
      WHERE id = ${experimentId} AND workspace_id = ${this.workspaceId} AND deleted_at IS NULL`;
    if (!row) return null;
    return new FileService(this.sql, this.blobs, this.events, this.workspaceId, null, experimentId);
  }

  /** WHERE condition for files in this service's place. */
  private get here() {
    if (this.experimentId !== null) {
      return this.sql`f.workspace_id = ${this.workspaceId} AND f.experiment_id = ${this.experimentId}`;
    }
    return this.nodeId === null
      ? this.sql`f.workspace_id = ${this.workspaceId} AND f.node_id IS NULL AND f.experiment_id IS NULL`
      : this.sql`f.workspace_id = ${this.workspaceId} AND f.node_id = ${this.nodeId}`;
  }

  /** Where change events say this service's files are. */
  private get place() {
    return this.experimentId ? { node: null, experiment: this.experimentId } : { node: this.nodeId };
  }

  async list(): Promise<FileInfo[]> {
    const rows = await this.sql<FileRow[]>`
      SELECT f.path, f.kind, f.mime, v.size, v.blob_sha256 AS sha256,
             f.updated_at, v.author_type, f.read_only
      FROM files f JOIN file_versions v ON v.id = f.current_version_id
      WHERE ${this.here} AND f.deleted_at IS NULL
      ORDER BY f.path`;
    return rows.map(toInfo);
  }

  async stat(rawPath: string): Promise<FileInfo | null> {
    const path = normalizePath(rawPath);
    const [row] = await this.sql<FileRow[]>`
      SELECT f.path, f.kind, f.mime, v.size, v.blob_sha256 AS sha256,
             f.updated_at, v.author_type, f.read_only
      FROM files f JOIN file_versions v ON v.id = f.current_version_id
      WHERE ${this.here} AND f.path = ${path} AND f.deleted_at IS NULL`;
    return row ? toInfo(row) : null;
  }

  async read(rawPath: string): Promise<{ info: FileInfo; bytes: Uint8Array } | null> {
    const info = await this.stat(rawPath);
    if (!info) return null;
    return { info, bytes: await this.blobs.get(info.sha256) };
  }

  /**
   * Creates the file when missing. Writing identical bytes adds no version.
   * Throws ReadOnlyFileError for a read-only file, and FileExistsError for an
   * existing one when `createOnly` is set.
   */
  async write(rawPath: string, bytes: Uint8Array, opts: WriteOptions = {}): Promise<FileInfo> {
    const path = normalizePath(rawPath);
    const mime = opts.mime || mimeForPath(path);
    const author = opts.author ?? "user";
    const sha256 = sha256Hex(bytes);

    await this.blobs.put(sha256, bytes, mime);

    await this.sql.begin(async (tx) => {
      await tx`
        INSERT INTO blobs (sha256, size) VALUES (${sha256}, ${bytes.byteLength})
        ON CONFLICT (sha256) DO NOTHING`;

      if (this.nodeId) await NodeService.lockLive(tx, this.workspaceId, this.nodeId);
      if (this.experimentId) await lockLiveExperiment(tx, this.workspaceId, this.experimentId);

      // Create the row if needed, then lock it so concurrent writers to one
      // path serialize instead of racing on the unique index.
      const created = await tx`
        INSERT INTO files (workspace_id, node_id, experiment_id, path, kind, mime, read_only)
        VALUES (${this.workspaceId}, ${this.nodeId}, ${this.experimentId}, ${path},
                ${kindForPath(path)}, ${mime}, ${opts.readOnly ?? false})
        ON CONFLICT (workspace_id, node_id, experiment_id, path) WHERE deleted_at IS NULL DO NOTHING`;
      const [file] = await tx<
        { id: string; sha256: string | null; mime: string; read_only: boolean }[]
      >`
        SELECT f.id, v.blob_sha256 AS sha256, f.mime, f.read_only
        FROM files f LEFT JOIN file_versions v ON v.id = f.current_version_id
        WHERE ${this.here} AND f.path = ${path} AND f.deleted_at IS NULL
        FOR UPDATE OF f`;

      if (created.count === 0) {
        if (opts.createOnly) throw new FileExistsError(path);
        if (file.read_only) throw new ReadOnlyFileError(path);
      }
      if (file.sha256 === sha256 && file.mime === mime) return;

      const [version] = await tx<{ id: string }[]>`
        INSERT INTO file_versions (file_id, blob_sha256, size, mime, author_type, author_id)
        VALUES (${file.id}, ${sha256}, ${bytes.byteLength}, ${mime}, ${author},
                ${opts.authorId ?? null})
        RETURNING id`;

      await tx`
        UPDATE files
        SET current_version_id = ${version.id}, mime = ${mime}, updated_at = now()
        WHERE id = ${file.id}`;

      await opts.inTx?.(tx);
      await this.events.notify(tx, { op: "write", ...this.place, path, sha256, author });
    });

    return (await this.stat(path))!;
  }

  /** Soft delete: history stays, and the path is free for a new file. Read-only files can't be deleted. */
  async remove(rawPath: string, inTx?: (tx: Tx) => Promise<unknown>): Promise<boolean> {
    const path = normalizePath(rawPath);
    return this.sql.begin(async (tx) => {
      const [file] = await tx<{ id: string; read_only: boolean }[]>`
        SELECT f.id, f.read_only FROM files f
        WHERE ${this.here} AND f.path = ${path} AND f.deleted_at IS NULL
        FOR UPDATE OF f`;
      if (!file) return false;
      if (file.read_only) throw new ReadOnlyFileError(path);
      await tx`UPDATE files SET deleted_at = now() WHERE id = ${file.id}`;
      await inTx?.(tx);
      await this.events.notify(tx, { op: "delete", ...this.place, path });
      return true;
    });
  }

  async history(rawPath: string): Promise<FileVersion[] | null> {
    const path = normalizePath(rawPath);
    const [file] = await this.sql<{ id: string }[]>`
      SELECT f.id FROM files f
      WHERE ${this.here} AND f.path = ${path} AND f.deleted_at IS NULL`;
    if (!file) return null;
    const rows = await this.sql<
      {
        id: string;
        blob_sha256: string;
        size: string;
        mime: string;
        author_type: AuthorType;
        author_id: string | null;
        created_at: Date;
      }[]
    >`
      SELECT id, blob_sha256, size, mime, author_type, author_id, created_at
      FROM file_versions WHERE file_id = ${file.id}
      ORDER BY created_at DESC, id DESC`;
    return rows.map((r) => ({
      id: r.id,
      sha256: r.blob_sha256,
      size: Number(r.size),
      mime: r.mime,
      author: r.author_type,
      authorId: r.author_id,
      createdAt: r.created_at.toISOString(),
    }));
  }
}
