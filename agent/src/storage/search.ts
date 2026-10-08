import { isNotFound, type BlobStore } from "./blobs";
import type { Sql, Tx } from "./db";
import type { AuthorType } from "./events";
import { isNodeId } from "./nodes";
import type { FileKind } from "./paths";

/**
 * Full-text search over workspace files (issue #4, step 6; 006_search.sql).
 * Text is extracted once per blob when it is written; a search then matches
 * the current version of every live file the user may read, by content or by
 * path, optionally inside one subtree, and ranks results near where the user
 * is working first.
 */

/** Text beyond this is left out of the index (the file itself is untouched). */
const MAX_INDEX_BYTES = 2 * 1024 * 1024;
const CHUNK_TARGET = 1000;
const CHUNK_MAX = 1500;
const SNIPPET_CHARS = 220;
export const MAX_RESULTS = 50;

/**
 * The bytes as text, or null when they aren't text (not UTF-8, or with NUL
 * bytes). Decided by content rather than name, since one blob can sit behind
 * files of any name.
 */
export function extractText(bytes: Uint8Array): string | null {
  try {
    // stream: a character cut at the size limit isn't an error.
    const text = new TextDecoder("utf-8", { fatal: true }).decode(
      bytes.subarray(0, MAX_INDEX_BYTES),
      {
        stream: true,
      },
    );
    return text.includes("\u0000") ? null : text;
  } catch {
    return null;
  }
}

/** Splits text into pieces of about a paragraph or a few, none over CHUNK_MAX chars. */
export function chunkText(text: string): string[] {
  const chunks: string[] = [];
  let current = "";
  const flush = () => {
    if (current.trim()) chunks.push(current.trim());
    current = "";
  };
  for (const paragraph of text.split(/\n\s*\n/)) {
    if (current && current.length + paragraph.length + 2 > CHUNK_TARGET) flush();
    let rest = paragraph;
    while (rest.length > CHUNK_MAX) {
      flush();
      let cut = rest.lastIndexOf(" ", CHUNK_MAX);
      if (cut < CHUNK_MAX / 2) cut = CHUNK_MAX;
      current = rest.slice(0, cut);
      flush();
      rest = rest.slice(cut);
    }
    current = current ? `${current}\n\n${rest}` : rest;
  }
  flush();
  return chunks;
}

/**
 * Indexes a blob's text inside the transaction that adds a version holding
 * it (row-level security lets a writer add it then). Does nothing when the
 * blob was indexed before, e.g. by an identical file elsewhere.
 */
export async function indexBlob(tx: Tx | Sql, sha256: string, bytes: Uint8Array): Promise<void> {
  const text = extractText(bytes);
  const chunks = text ? chunkText(text) : [];
  const [fresh] = await tx`
    INSERT INTO blob_texts (sha256, chars) VALUES (${sha256}, ${text?.length ?? 0})
    ON CONFLICT (sha256) DO NOTHING
    RETURNING sha256`;
  if (!fresh || chunks.length === 0) return;
  await tx`
    INSERT INTO blob_chunks ${tx(chunks.map((body, ord) => ({ sha256, ord, body })))}`;
}

export interface SearchOptions {
  query: string;
  /** Only files in this node, the nodes below it and their experiments. */
  scope?: string | null;
  /** Where the user is working (a node; null = the root), so nearby files rank first. */
  near?: string | null;
  /**
   * An experiment the user is in: counts as its node for `near`, and its
   * unchanged copies of the node's files are found too (for others they'd
   * only repeat the node's).
   */
  nearExperiment?: string | null;
  limit?: number;
}

export interface SearchHit {
  path: string;
  kind: FileKind;
  mime: string;
  /** The file's node, or null at the root or in an experiment. */
  node: string | null;
  experiment: string | null;
  /** Node names from the top down to the file's node (the experiment's node for an experiment). */
  where: string[];
  /** The experiment's title, for its files. */
  experimentTitle: string | null;
  /** The passage that matched, or "" when only the path did. */
  snippet: string;
  updatedAt: string;
  author: AuthorType;
}

export class SearchError extends Error {}

interface HitRow {
  path: string;
  kind: FileKind;
  mime: string;
  node_id: string | null;
  experiment_id: string | null;
  experiment_title: string | null;
  body: string | null;
  lineage: string[] | null;
  updated_at: Date;
  author_type: AuthorType;
}

/**
 * The query's wanted words joined with `or`, for finding the passages that
 * could be part of a match (words to exclude and quotes dropped).
 */
export function anyWords(query: string): string {
  return (query.match(/-?"[^"]*"?|\S+/g) ?? [])
    .filter((token) => !token.startsWith("-"))
    .flatMap((token) => token.replace(/"/g, " ").split(/\s+/))
    .filter((word) => word && word.toLowerCase() !== "or")
    .join(" or ");
}

/** Plain words of a query, for picking the passage to show. */
function queryTerms(query: string): string[] {
  return query
    .split(/\s+/)
    .map((t) => t.replace(/^[-"]+|"+$/g, "").toLowerCase())
    .filter((t) => t && t !== "or");
}

/** About SNIPPET_CHARS of `body` around the first query word in it. */
export function snippetFor(body: string, query: string): string {
  const flat = body.replace(/\s+/g, " ").trim();
  if (flat.length <= SNIPPET_CHARS) return flat;
  const lower = flat.toLowerCase();
  const whole = lower.indexOf(query.trim().toLowerCase());
  const hits = [whole, ...queryTerms(query).map((t) => lower.indexOf(t))].filter((i) => i >= 0);
  const at = hits.length ? Math.min(...hits) : 0;
  const start = Math.max(0, Math.min(at - 60, flat.length - SNIPPET_CHARS));
  const end = start + SNIPPET_CHARS;
  return `${start > 0 ? "…" : ""}${flat.slice(start, end).trim()}${end < flat.length ? "…" : ""}`;
}

export class SearchService {
  constructor(
    private readonly sql: Sql,
    private readonly blobs: BlobStore,
    private readonly workspaceId: string,
  ) {}

  /** The same search through another connection or transaction (see db.ts asUser). */
  withSql(sql: Sql): SearchService {
    return new SearchService(sql, this.blobs, this.workspaceId);
  }

  /** A node's path if `userId` can see it (as in the tree), else null. */
  private async visiblePath(userId: string, id: string): Promise<string | null> {
    if (!isNodeId(id)) return null;
    const [row] = await this.sql<{ path: string }[]>`
      SELECT path::text FROM nodes
      WHERE id = ${id} AND workspace_id = ${this.workspaceId} AND deleted_at IS NULL
        AND sees_path(workspace_id, ${userId}, path)`;
    return row?.path ?? null;
  }

  private async experimentPath(userId: string, id: string): Promise<string | null> {
    if (!isNodeId(id)) return null;
    const [row] = await this.sql<{ path: string }[]>`
      SELECT n.path::text FROM experiments e JOIN nodes n ON n.id = e.node_id
      WHERE e.id = ${id} AND e.workspace_id = ${this.workspaceId}
        AND experiment_access(${userId}, e.id) IS NOT NULL`;
    return row?.path ?? null;
  }

  /** Files `userId` may read that match `query`, best first. Throws SearchError for a bad scope. */
  async search(userId: string, opts: SearchOptions): Promise<SearchHit[]> {
    const query = opts.query.trim();
    if (!query) throw new SearchError("Search for at least one word");
    if (query.length > 500)
      throw new SearchError("Search text is too long (500 characters at most)");
    const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 20), 1), MAX_RESULTS);

    let scope: string | null = null;
    if (opts.scope) {
      scope = await this.visiblePath(userId, opts.scope);
      if (scope === null) throw new SearchError("No such knowledge node to search in");
    }
    const near =
      (opts.nearExperiment ? await this.experimentPath(userId, opts.nearExperiment) : null) ??
      (opts.near ? await this.visiblePath(userId, opts.near) : null) ??
      "";

    const workingIn =
      opts.nearExperiment && isNodeId(opts.nearExperiment) ? opts.nearExperiment : null;
    // Substring match too, for what full-text search doesn't split into words.
    const pattern = `%${query.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    // A file matches when its whole text satisfies the query (so -word and
    // words in different passages count across the file), its text contains
    // the query as written, or its path does. `any` (one of the wanted words)
    // finds candidate passages fast and picks the one to show.
    const rows = await this.sql<HitRow[]>`
      WITH q AS (
        SELECT websearch_to_tsquery('english', ${query}) AS tsq,
               websearch_to_tsquery('english', ${anyWords(query)}) AS anyq
      ),
      candidates AS (
        SELECT f.id, f.path, f.kind, f.mime, f.node_id, f.experiment_id, f.updated_at,
               v.author_type, v.blob_sha256, e.title AS experiment_title,
               coalesce(n.path, en.path, ''::ltree) AS place_path
        FROM files f
        JOIN file_versions v ON v.id = f.current_version_id
        LEFT JOIN nodes n ON n.id = f.node_id
        LEFT JOIN file_versions fv ON fv.id = f.forked_from
        LEFT JOIN experiments e ON e.id = f.experiment_id
        LEFT JOIN nodes en ON en.id = e.node_id
        CROSS JOIN q
        WHERE f.workspace_id = ${this.workspaceId} AND f.deleted_at IS NULL
          AND (f.path ILIKE ${pattern} OR EXISTS (
                SELECT 1 FROM blob_chunks c
                WHERE c.sha256 = v.blob_sha256 AND (c.tsv @@ q.anyq OR c.body ILIKE ${pattern})))
          AND place_rank(f.workspace_id, ${userId}, f.node_id, f.experiment_id) >= 1
          -- An experiment's unchanged copy of a node file would only repeat the
          -- node's, except for someone working in that experiment.
          AND NOT (fv.blob_sha256 IS NOT DISTINCT FROM v.blob_sha256
                   AND f.experiment_id IS DISTINCT FROM ${workingIn}::uuid)
          ${scope === null ? this.sql`` : this.sql`AND coalesce(n.path, en.path) <@ ${scope}::ltree`}
      ),
      hits AS (
        SELECT h.*, passage.body,
          (CASE WHEN doc.tsv @@ q.tsq THEN ts_rank(doc.tsv, q.tsq) + 0.1
                WHEN passage.literal THEN 0.1 ELSE 0 END
           + CASE WHEN h.path ILIKE ${pattern} THEN 1 ELSE 0 END) AS score
        FROM candidates h
        CROSS JOIN q
        CROSS JOIN LATERAL (
          SELECT tsvector_agg(c.tsv ORDER BY c.ord) AS tsv
          FROM blob_chunks c WHERE c.sha256 = h.blob_sha256
        ) doc
        LEFT JOIN LATERAL (
          SELECT c.body, c.body ILIKE ${pattern} AS literal
          FROM blob_chunks c
          WHERE c.sha256 = h.blob_sha256 AND (c.tsv @@ q.anyq OR c.body ILIKE ${pattern})
          ORDER BY c.tsv @@ q.tsq DESC, c.body ILIKE ${pattern} DESC,
                   ts_rank(c.tsv, q.anyq) DESC, c.ord
          LIMIT 1
        ) passage ON true
        WHERE doc.tsv @@ q.tsq OR h.path ILIKE ${pattern}
           OR EXISTS (SELECT 1 FROM blob_chunks c
                      WHERE c.sha256 = h.blob_sha256 AND c.body ILIKE ${pattern})
      ),
      best AS (
        SELECT * FROM hits
        ORDER BY score / (1 + 0.25 * tree_distance(place_path, ${near}::ltree)) DESC,
                 updated_at DESC, path
        LIMIT ${limit}
      )
      SELECT b.*,
        (SELECT array_agg(a.name ORDER BY nlevel(a.path)) FROM nodes a
         WHERE a.workspace_id = ${this.workspaceId} AND a.path @> b.place_path
           AND nlevel(b.place_path) > 0) AS lineage
      FROM best b
      ORDER BY b.score / (1 + 0.25 * tree_distance(b.place_path, ${near}::ltree)) DESC,
               b.updated_at DESC, b.path`;

    return rows.map((r) => ({
      path: r.path,
      kind: r.kind,
      mime: r.mime,
      node: r.node_id,
      experiment: r.experiment_id,
      where: r.lineage ?? [],
      experimentTitle: r.experiment_title,
      snippet: r.body ? snippetFor(r.body, query) : "",
      updatedAt: r.updated_at.toISOString(),
      author: r.author_type,
    }));
  }

  /**
   * Indexes current file versions written before search existed (or whose
   * indexing was missed), a batch at a time, leaving out `skip`. Returns the
   * blobs it indexed and those it couldn't read this time (a store error
   * other than "not there"); those stay pending for a later try.
   * Runs with the server's own connection, outside any user's rights.
   */
  async indexPending(
    batch = 20,
    skip: ReadonlySet<string> = new Set(),
  ): Promise<{ indexed: number; failed: string[] }> {
    const rows = await this.sql<{ sha256: string }[]>`
      SELECT DISTINCT v.blob_sha256 AS sha256
      FROM files f
      JOIN file_versions v ON v.id = f.current_version_id
      LEFT JOIN blob_texts t ON t.sha256 = v.blob_sha256
      WHERE f.deleted_at IS NULL AND t.sha256 IS NULL
        AND NOT (v.blob_sha256 = ANY(${[...skip]}::text[]))
      LIMIT ${batch}`;
    const failed: string[] = [];
    for (const { sha256 } of rows) {
      let bytes: Uint8Array;
      try {
        bytes = await this.blobs.get(sha256);
      } catch (err) {
        if (!isNotFound(err)) {
          console.warn(`[search] could not read blob ${sha256} to index it, will retry:`, err);
          failed.push(sha256);
          continue;
        }
        // Gone from the store: recorded as no text, so it isn't retried forever.
        console.warn(`[search] blob ${sha256} is missing from the store; indexed as empty`);
        bytes = new Uint8Array();
      }
      await this.sql.begin((tx) => indexBlob(tx, sha256, bytes));
    }
    return { indexed: rows.length - failed.length, failed };
  }

  /**
   * indexPending() until nothing is left but blobs that failed in this pass.
   * Returns how many it indexed and how many failed.
   */
  async indexAll(): Promise<{ indexed: number; failed: number }> {
    const skip = new Set<string>();
    let indexed = 0;
    for (;;) {
      const batch = await this.indexPending(20, skip);
      indexed += batch.indexed;
      for (const sha of batch.failed) skip.add(sha);
      if (batch.indexed === 0 && batch.failed.length === 0) return { indexed, failed: skip.size };
    }
  }
}
