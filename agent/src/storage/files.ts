import type { BlobStore } from "./blobs";
import { sha256Hex } from "./blobs";
import type { Sql } from "./db";
import { kindForPath, mimeForPath, normalizePath, type FileKind } from "./paths";

export type AuthorType = "user" | "agent";

export interface FileInfo {
  path: string;
  kind: FileKind;
  mime: string;
  size: number;
  sha256: string;
  updatedAt: string;
  author: AuthorType;
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
}

interface FileRow {
  path: string;
  kind: FileKind;
  mime: string;
  size: string;
  sha256: string;
  updated_at: Date;
  author_type: AuthorType;
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
  };
}

/**
 * Files in one workspace. Every write adds an immutable version; reads return
 * the current one. Bytes go to the BlobStore first, so a crash can leave an
 * unreferenced blob (harmless, collectable later) but never a dangling row.
 */
export class FileService {
  constructor(
    private readonly sql: Sql,
    private readonly blobs: BlobStore,
    private readonly workspaceId: string,
  ) {}

  static async forWorkspace(sql: Sql, blobs: BlobStore, slug = "default") {
    const [ws] = await sql<{ id: string }[]>`
      SELECT id FROM workspaces WHERE slug = ${slug}`;
    if (!ws) throw new Error(`Workspace ${slug} not found`);
    return new FileService(sql, blobs, ws.id);
  }

  async list(): Promise<FileInfo[]> {
    const rows = await this.sql<FileRow[]>`
      SELECT f.path, f.kind, f.mime, v.size, v.blob_sha256 AS sha256,
             f.updated_at, v.author_type
      FROM files f JOIN file_versions v ON v.id = f.current_version_id
      WHERE f.workspace_id = ${this.workspaceId} AND f.deleted_at IS NULL
      ORDER BY f.path`;
    return rows.map(toInfo);
  }

  async stat(rawPath: string): Promise<FileInfo | null> {
    const path = normalizePath(rawPath);
    const [row] = await this.sql<FileRow[]>`
      SELECT f.path, f.kind, f.mime, v.size, v.blob_sha256 AS sha256,
             f.updated_at, v.author_type
      FROM files f JOIN file_versions v ON v.id = f.current_version_id
      WHERE f.workspace_id = ${this.workspaceId} AND f.path = ${path}
        AND f.deleted_at IS NULL`;
    return row ? toInfo(row) : null;
  }

  async read(rawPath: string): Promise<{ info: FileInfo; bytes: Uint8Array } | null> {
    const info = await this.stat(rawPath);
    if (!info) return null;
    return { info, bytes: await this.blobs.get(info.sha256) };
  }

  /** Creates the file when missing. Writing identical bytes adds no version. */
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

      // Create the row if needed, then lock it so concurrent writers to one
      // path serialize instead of racing on the unique index.
      await tx`
        INSERT INTO files (workspace_id, path, kind, mime)
        VALUES (${this.workspaceId}, ${path}, ${kindForPath(path)}, ${mime})
        ON CONFLICT (workspace_id, path) WHERE deleted_at IS NULL DO NOTHING`;
      const [file] = await tx<{ id: string; sha256: string | null; mime: string }[]>`
        SELECT f.id, v.blob_sha256 AS sha256, f.mime
        FROM files f LEFT JOIN file_versions v ON v.id = f.current_version_id
        WHERE f.workspace_id = ${this.workspaceId} AND f.path = ${path}
          AND f.deleted_at IS NULL
        FOR UPDATE OF f`;

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
    });

    return (await this.stat(path))!;
  }

  /** Soft delete: history stays, and the path is free for a new file. */
  async remove(rawPath: string): Promise<boolean> {
    const path = normalizePath(rawPath);
    const rows = await this.sql`
      UPDATE files SET deleted_at = now()
      WHERE workspace_id = ${this.workspaceId} AND path = ${path}
        AND deleted_at IS NULL`;
    return rows.count > 0;
  }

  async history(rawPath: string): Promise<FileVersion[] | null> {
    const path = normalizePath(rawPath);
    const [file] = await this.sql<{ id: string }[]>`
      SELECT id FROM files
      WHERE workspace_id = ${this.workspaceId} AND path = ${path}
        AND deleted_at IS NULL`;
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
