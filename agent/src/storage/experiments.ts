import { randomUUID } from "node:crypto";

import type { Sql, Tx } from "./db";
import type { EventHub } from "./events";
import { isNodeId, NodeNotFoundError } from "./nodes";

/**
 * Experiments: a user's sandbox on one knowledge node (005_experiments.sql).
 * Forking copies the node's file list into the experiment; the bytes are
 * shared, since blobs are stored once by content. After that the experiment's
 * files change on their own, and the node's stay as they were.
 */

export type ExperimentStatus = "draft" | "shared" | "archived";
export const STATUSES: ExperimentStatus[] = ["draft", "shared", "archived"];
/** writer: its author, while it isn't archived. reader: may look. */
export type ExperimentAccess = "writer" | "reader";

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
  /** What the asking user may do with it. */
  access: ExperimentAccess;
  /** Whether the asking user is its author (who may also restore or delete it). */
  mine: boolean;
}

export interface ExperimentInput {
  title?: string;
  hypothesis?: string;
  params?: Record<string, unknown>;
  results?: Record<string, unknown>;
  status?: ExperimentStatus;
}

/** The request can't be done as asked (no title, params not an object, …). */
export class ExperimentError extends Error {}

const MAX_JSON_CHARS = 64 * 1024;

/** Checks and tidies the fields a create or update sets. */
export function cleanInput(input: ExperimentInput): ExperimentInput {
  const out: ExperimentInput = {};
  if (input.title !== undefined) {
    const title = String(input.title).trim().replace(/\s+/g, " ");
    if (!title) throw new ExperimentError("An experiment needs a title");
    if (title.length > 200) throw new ExperimentError("Titles are at most 200 characters");
    out.title = title;
  }
  if (input.hypothesis !== undefined) {
    const hypothesis = String(input.hypothesis);
    if (hypothesis.length > 20_000) throw new ExperimentError("The hypothesis is at most 20000 characters");
    out.hypothesis = hypothesis;
  }
  for (const key of ["params", "results"] as const) {
    const value = input[key];
    if (value === undefined) continue;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new ExperimentError(`${key} must be an object, e.g. {"temperature": 60}`);
    }
    if (JSON.stringify(value).length > MAX_JSON_CHARS) {
      throw new ExperimentError(`${key} is too large (at most ${MAX_JSON_CHARS} characters of JSON)`);
    }
    out[key] = value;
  }
  if (input.status !== undefined) {
    if (!STATUSES.includes(input.status)) throw new ExperimentError("Status must be draft, shared or archived");
    out.status = input.status;
  }
  return out;
}

interface ExperimentRow {
  id: string;
  node_id: string;
  author_id: string;
  author_name: string | null;
  title: string;
  hypothesis: string;
  params: Record<string, unknown>;
  results: Record<string, unknown>;
  status: ExperimentStatus;
  forked_at: Date;
  updated_at: Date;
  file_count: string;
  access: ExperimentAccess;
  mine: boolean;
}

const toExperiment = (r: ExperimentRow): Experiment => ({
  id: r.id,
  nodeId: r.node_id,
  authorId: r.author_id,
  authorName: r.author_name,
  title: r.title,
  hypothesis: r.hypothesis,
  params: r.params,
  results: r.results,
  status: r.status,
  forkedAt: r.forked_at.toISOString(),
  updatedAt: r.updated_at.toISOString(),
  fileCount: Number(r.file_count),
  access: r.access,
  mine: r.mine,
});

/**
 * Inside a file write: fails unless the experiment is live, and holds it so a
 * concurrent delete waits for the write.
 */
export async function lockLiveExperiment(tx: Tx, workspaceId: string, id: string) {
  const [row] = await tx`
    SELECT 1 FROM experiments
    WHERE id = ${id} AND workspace_id = ${workspaceId} AND deleted_at IS NULL
    FOR SHARE`;
  if (!row) throw new NodeNotFoundError("Experiment not found");
}

export class ExperimentService {
  constructor(
    private readonly sql: Sql,
    private readonly events: EventHub,
    private readonly workspaceId: string,
  ) {}

  /** The same experiments through another connection or transaction (see db.ts asUser). */
  withSql(sql: Sql): ExperimentService {
    return new ExperimentService(sql, this.events, this.workspaceId);
  }

  /** Experiments `userId` can see, on one node or (without `nodeId`) anywhere; newest first. */
  async list(userId: string, nodeId?: string): Promise<Experiment[]> {
    if (nodeId !== undefined && !isNodeId(nodeId)) return [];
    const rows = await this.sql<ExperimentRow[]>`
      SELECT * FROM (
        SELECT e.id, e.node_id, e.author_id, u.name AS author_name, e.title, e.hypothesis,
               e.params, e.results, e.status, e.forked_at, e.updated_at,
               (SELECT count(*) FROM files f
                WHERE f.experiment_id = e.id AND f.deleted_at IS NULL) AS file_count,
               experiment_access(${userId}, e.id) AS access, e.author_id = ${userId} AS mine
        FROM experiments e JOIN nodes n ON n.id = e.node_id
        LEFT JOIN users u ON u.id = e.author_id
        WHERE e.workspace_id = ${this.workspaceId} AND e.deleted_at IS NULL
          AND n.deleted_at IS NULL
          ${nodeId === undefined ? this.sql`` : this.sql`AND e.node_id = ${nodeId}`}
      ) x
      WHERE access IS NOT NULL
      ORDER BY forked_at DESC, id`;
    return rows.map(toExperiment);
  }

  async get(userId: string, id: string): Promise<Experiment | null> {
    if (!isNodeId(id)) return null;
    const rows = await this.sql<ExperimentRow[]>`
      SELECT e.id, e.node_id, e.author_id, u.name AS author_name, e.title, e.hypothesis,
             e.params, e.results, e.status, e.forked_at, e.updated_at,
             (SELECT count(*) FROM files f
              WHERE f.experiment_id = e.id AND f.deleted_at IS NULL) AS file_count,
             experiment_access(${userId}, e.id) AS access, e.author_id = ${userId} AS mine
      FROM experiments e LEFT JOIN users u ON u.id = e.author_id
      WHERE e.id = ${id} AND e.workspace_id = ${this.workspaceId} AND e.deleted_at IS NULL`;
    const row = rows[0];
    return row?.access ? toExperiment(row) : null;
  }

  /**
   * Forks `nodeId` into a new draft for `userId`: the node's live files are
   * copied in at their current versions.
   */
  async create(
    userId: string,
    nodeId: string,
    input: ExperimentInput,
    inTx?: (tx: Tx, id: string) => Promise<unknown>,
  ): Promise<Experiment> {
    const fields = cleanInput(input);
    if (!fields.title) throw new ExperimentError("An experiment needs a title");
    if (!isNodeId(nodeId)) throw new NodeNotFoundError("Node not found");
    // Chosen here, not by the database: with row-level security the new row
    // can't be read back in the statement that adds it.
    const id = randomUUID();
    await this.sql.begin(async (tx) => {
      // No row lock here: viewers fork too, and locking needs write access.
      // If the node is deleted meanwhile, the experiment goes with it (its
      // access requires a live node).
      const [node] = await tx`
        SELECT 1 FROM nodes
        WHERE id = ${nodeId} AND workspace_id = ${this.workspaceId} AND deleted_at IS NULL`;
      if (!node) throw new NodeNotFoundError("Node not found");
      await tx`
        INSERT INTO experiments (id, workspace_id, node_id, author_id, title, hypothesis, params, results)
        VALUES (${id}, ${this.workspaceId}, ${nodeId}, ${userId}, ${fields.title!},
                ${fields.hypothesis ?? ""}, ${tx.json((fields.params ?? {}) as never)},
                ${tx.json((fields.results ?? {}) as never)})`;
      // The node's files, each at its current version; bytes are shared.
      await tx`
        INSERT INTO files (workspace_id, experiment_id, path, kind, mime, forked_from, updated_at)
        SELECT f.workspace_id, ${id}, f.path, f.kind, f.mime, f.current_version_id, f.updated_at
        FROM files f
        WHERE f.workspace_id = ${this.workspaceId} AND f.node_id = ${nodeId}
          AND f.deleted_at IS NULL AND f.current_version_id IS NOT NULL`;
      await tx`
        INSERT INTO file_versions (file_id, blob_sha256, size, mime, author_type, author_id, created_at)
        SELECT f.id, v.blob_sha256, v.size, v.mime, v.author_type, v.author_id, v.created_at
        FROM files f JOIN file_versions v ON v.id = f.forked_from
        WHERE f.experiment_id = ${id}`;
      await tx`
        UPDATE files f SET current_version_id = v.id
        FROM file_versions v
        WHERE v.file_id = f.id AND f.experiment_id = ${id}`;
      await inTx?.(tx, id);
      await this.events.notify(tx, { op: "experiment", change: "create", id, node: nodeId });
    });
    return (await this.get(userId, id))!;
  }

  /** Sets the given fields; false if the experiment is gone. */
  async update(id: string, input: ExperimentInput, inTx?: (tx: Tx) => Promise<unknown>): Promise<boolean> {
    const fields = cleanInput(input);
    if (!isNodeId(id)) return false;
    return this.sql.begin(async (tx) => {
      const [before] = await tx<{ status: ExperimentStatus; node_id: string }[]>`
        SELECT status, node_id FROM experiments
        WHERE id = ${id} AND workspace_id = ${this.workspaceId} AND deleted_at IS NULL
        FOR UPDATE`;
      if (!before) return false;
      const set: Record<string, unknown> = {};
      if (fields.title !== undefined) set.title = fields.title;
      if (fields.hypothesis !== undefined) set.hypothesis = fields.hypothesis;
      if (fields.params !== undefined) set.params = tx.json(fields.params as never);
      if (fields.results !== undefined) set.results = tx.json(fields.results as never);
      if (fields.status !== undefined) set.status = fields.status;
      if (Object.keys(set).length) {
        await tx`
          UPDATE experiments SET ${tx(set as Record<string, never>)}, updated_at = now()
          WHERE id = ${id}`;
      }
      await inTx?.(tx);
      const change = fields.status !== undefined && fields.status !== before.status ? "status" : "update";
      await this.events.notify(tx, { op: "experiment", change, id, node: before.node_id });
      return true;
    });
  }

  /** Soft-deletes the experiment and its files; history stays. */
  async remove(id: string, inTx?: (tx: Tx) => Promise<unknown>): Promise<boolean> {
    if (!isNodeId(id)) return false;
    return this.sql.begin(async (tx) => {
      const [gone] = await tx<{ node_id: string }[]>`
        UPDATE experiments SET deleted_at = now()
        WHERE id = ${id} AND workspace_id = ${this.workspaceId} AND deleted_at IS NULL
        RETURNING node_id`;
      if (!gone) return false;
      // Its files go with it (a trigger, see 005_experiments.sql).
      await inTx?.(tx);
      await this.events.notify(tx, { op: "experiment", change: "delete", id, node: gone.node_id });
      return true;
    });
  }

  /**
   * Whether `userId` should hear about a change to an experiment. Its author
   * always; others who can view its node when it isn't a draft, or when it
   * just stopped or started being one (so their list updates). Answers for a
   * deleted experiment too.
   */
  async hears(userId: string, id: string, change: string): Promise<boolean> {
    const [row] = await this.sql<{ hears: boolean }[]>`
      SELECT e.author_id = ${userId}
          OR ((e.status <> 'draft' OR ${change} = 'status')
              AND effective_role(e.workspace_id, ${userId}, e.node_id) IS NOT NULL) AS hears
      FROM experiments e
      WHERE e.id = ${id} AND e.workspace_id = ${this.workspaceId}`;
    return Boolean(row?.hears);
  }

  /** What `userId` may do with an experiment's files, or null for nothing. */
  async access(userId: string, id: string): Promise<ExperimentAccess | null> {
    if (!isNodeId(id)) return null;
    const [row] = await this.sql<{ access: ExperimentAccess | null }[]>`
      SELECT experiment_access(${userId}, ${id}::uuid) AS access`;
    return row.access;
  }
}
