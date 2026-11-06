import { randomUUID } from "node:crypto";

import type { Sql, Tx } from "./db";
import type { EventHub } from "./events";
import { isNodeId, NodeNotFoundError } from "./nodes";
import { kindForPath } from "./paths";

/**
 * Experiments: a user's sandbox on one knowledge node, or at the workspace
 * root (005_experiments.sql, 015_runs.sql). Forking copies the node's file
 * list into the experiment; the bytes are shared, since blobs are stored once
 * by content. After that the experiment's files change on their own, and the
 * node's stay as they were. An experiment with a report.md is a run.
 */

export type ExperimentStatus = "draft" | "shared" | "archived";
export const STATUSES: ExperimentStatus[] = ["draft", "shared", "archived"];
/** How far a run got; apart from status, which says who sees it. */
export type ExperimentState = "ready" | "running" | "done" | "failed";
export const STATES: ExperimentState[] = ["ready", "running", "done", "failed"];
/** writer: its author, while it isn't archived. reader: may look. */
export type ExperimentAccess = "writer" | "reader";

export interface Experiment {
  id: string;
  /** null: at the workspace root. */
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
  /** Where a run came from (016_run_provenance.sql); {} when nobody recorded it. */
  provenance: Record<string, unknown>;
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
  state?: ExperimentState;
}

/**
 * A file linked into a new run as one of its inputs: a read-only copy at
 * `path` of the file version `versionId`, sharing its stored bytes.
 */
export interface LinkedInput {
  path: string;
  versionId: string;
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
  if (input.state !== undefined) {
    if (!STATES.includes(input.state)) throw new ExperimentError("State must be ready, running, done or failed");
    out.state = input.state;
  }
  return out;
}

interface ExperimentRow {
  id: string;
  node_id: string | null;
  author_id: string;
  author_name: string | null;
  title: string;
  hypothesis: string;
  params: Record<string, unknown>;
  results: Record<string, unknown>;
  status: ExperimentStatus;
  state: ExperimentState;
  forked_at: Date;
  updated_at: Date;
  file_count: string;
  provenance: Record<string, unknown>;
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
  state: r.state,
  forkedAt: r.forked_at.toISOString(),
  updatedAt: r.updated_at.toISOString(),
  fileCount: Number(r.file_count),
  provenance: r.provenance,
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

  /**
   * Experiments `userId` can see, on one node (null: at the workspace root)
   * or, without `nodeId`, anywhere; newest first.
   */
  async list(userId: string, nodeId?: string | null): Promise<Experiment[]> {
    if (nodeId && !isNodeId(nodeId)) return [];
    const rows = await this.sql<ExperimentRow[]>`
      SELECT * FROM (
        SELECT e.id, e.node_id, e.author_id, u.name AS author_name, e.title, e.hypothesis,
               e.params, e.results, e.status, e.state, e.forked_at, e.updated_at, e.provenance,
               (SELECT count(*) FROM files f
                WHERE f.experiment_id = e.id AND f.deleted_at IS NULL) AS file_count,
               experiment_access(${userId}, e.id) AS access, e.author_id = ${userId} AS mine
        FROM experiments e LEFT JOIN nodes n ON n.id = e.node_id
        LEFT JOIN users u ON u.id = e.author_id
        WHERE e.workspace_id = ${this.workspaceId} AND e.deleted_at IS NULL
          AND (e.node_id IS NULL OR n.deleted_at IS NULL)
          ${nodeId === undefined ? this.sql`` : this.sql`AND e.node_id IS NOT DISTINCT FROM ${nodeId}::uuid`}
      ) x
      WHERE access IS NOT NULL
      ORDER BY forked_at DESC, id`;
    return rows.map(toExperiment);
  }

  async get(userId: string, id: string): Promise<Experiment | null> {
    if (!isNodeId(id)) return null;
    const rows = await this.sql<ExperimentRow[]>`
      SELECT e.id, e.node_id, e.author_id, u.name AS author_name, e.title, e.hypothesis,
             e.params, e.results, e.status, e.state, e.forked_at, e.updated_at, e.provenance,
             (SELECT count(*) FROM files f
              WHERE f.experiment_id = e.id AND f.deleted_at IS NULL) AS file_count,
             experiment_access(${userId}, e.id) AS access, e.author_id = ${userId} AS mine
      FROM experiments e LEFT JOIN users u ON u.id = e.author_id
      WHERE e.id = ${id} AND e.workspace_id = ${this.workspaceId} AND e.deleted_at IS NULL`;
    const row = rows[0];
    return row?.access ? toExperiment(row) : null;
  }

  /**
   * A new draft for `userId` on `nodeId`, or at the workspace root (null).
   * On a node it is a fork: the node's live files are copied in at their
   * current versions. At the root it starts empty, since the root's files are
   * the whole workspace's, not one subject's.
   */
  async create(
    userId: string,
    nodeId: string | null,
    input: ExperimentInput,
    inTx?: (tx: Tx, id: string) => Promise<unknown>,
    run: { inputs?: LinkedInput[]; provenance?: Record<string, unknown> } = {},
  ): Promise<Experiment> {
    return this.add(
      userId,
      nodeId,
      input,
      async (tx, id) => {
        if (nodeId !== null) await this.copyNodeFiles(tx, nodeId, id);
        if (run.inputs?.length) await this.linkInputs(tx, id, run.inputs);
        await inTx?.(tx, id);
      },
      run.provenance,
    );
  }

  /**
   * Read-only copies of other files' versions in experiment `id`, as a run's
   * inputs. Their bytes are shared, and since each starts from the version it
   * copies, promoting the run never proposes them back to its node.
   */
  private async linkInputs(tx: Tx, id: string, inputs: LinkedInput[]) {
    const linked: { path: string; sha256: string }[] = [];
    for (const input of inputs) {
      const [file] = await tx<{ id: string }[]>`
        INSERT INTO files (workspace_id, experiment_id, path, kind, mime, forked_from, read_only)
        SELECT ${this.workspaceId}, ${id}, ${input.path}, ${kindForPath(input.path)}, v.mime, v.id, true
        FROM file_versions v WHERE v.id = ${input.versionId}
        ON CONFLICT (workspace_id, node_id, experiment_id, path) WHERE deleted_at IS NULL DO NOTHING
        RETURNING id`;
      if (!file) throw new ExperimentError(`The run already has a file at ${input.path}; pick another name for this input`);
      const [version] = await tx<{ sha256: string }[]>`
        INSERT INTO file_versions (file_id, blob_sha256, size, mime, author_type, author_id, created_at)
        SELECT ${file.id}, v.blob_sha256, v.size, v.mime, v.author_type, v.author_id, v.created_at
        FROM file_versions v WHERE v.id = ${input.versionId}
        RETURNING blob_sha256 AS sha256`;
      await tx`
        UPDATE files f SET current_version_id = v.id
        FROM file_versions v WHERE v.file_id = f.id AND f.id = ${file.id}`;
      linked.push({ path: input.path, sha256: version.sha256 });
    }
    return linked;
  }

  /**
   * Links more inputs into experiment `id` (see linkInputs) and appends
   * `recorded` to the inputs its provenance lists; false if it is gone.
   */
  async addInputs(
    id: string,
    inputs: LinkedInput[],
    recorded: Record<string, unknown>[],
    inTx?: (tx: Tx) => Promise<unknown>,
  ): Promise<boolean> {
    if (!isNodeId(id)) return false;
    return this.sql.begin(async (tx) => {
      const [before] = await tx<{ node_id: string | null; state: ExperimentState; status: ExperimentStatus }[]>`
        SELECT node_id, state, status FROM experiments
        WHERE id = ${id} AND workspace_id = ${this.workspaceId} AND deleted_at IS NULL
        FOR UPDATE`;
      if (!before) return false;
      // Checked again under the lock: the run may have finished or been archived meanwhile.
      if (before.state === "done" || before.state === "failed") {
        throw new ExperimentError(`This run already finished (${before.state}); start a new run to add inputs`);
      }
      if (before.status === "archived") throw new ExperimentError("This experiment is archived; restore it to change it");
      const linked = await this.linkInputs(tx, id, inputs);
      await tx`
        UPDATE experiments
        SET provenance = jsonb_set(provenance, '{inputs}',
              COALESCE(provenance->'inputs', '[]'::jsonb) || ${tx.json(recorded as never)}),
            updated_at = now()
        WHERE id = ${id}`;
      await inTx?.(tx);
      // Open copies of the run pick up the new files, and its record.
      for (const file of linked) {
        await this.events.notify(tx, { op: "write", node: null, experiment: id, ...file, author: "user" });
      }
      await this.events.notify(tx, { op: "experiment", change: "update", id, node: before.node_id });
      return true;
    });
  }

  private async add(
    userId: string,
    nodeId: string | null,
    input: ExperimentInput,
    inTx: (tx: Tx, id: string) => Promise<unknown>,
    provenance: Record<string, unknown> = {},
  ): Promise<Experiment> {
    const fields = cleanInput(input);
    if (!fields.title) throw new ExperimentError("An experiment needs a title");
    if (nodeId !== null && !isNodeId(nodeId)) throw new NodeNotFoundError("Node not found");
    // Chosen here, not by the database: with row-level security the new row
    // can't be read back in the statement that adds it.
    const id = randomUUID();
    await this.sql.begin(async (tx) => {
      // The insert also checks and holds the node (experiments_place in
      // 005_experiments.sql), so a delete of it can't slip in between.
      await tx`
        INSERT INTO experiments (id, workspace_id, node_id, author_id, title, hypothesis, params, results, state,
                                 provenance)
        VALUES (${id}, ${this.workspaceId}, ${nodeId}, ${userId}, ${fields.title!},
                ${fields.hypothesis ?? ""}, ${tx.json((fields.params ?? {}) as never)},
                ${tx.json((fields.results ?? {}) as never)}, ${fields.state ?? "ready"},
                ${tx.json(provenance as never)})`;
      await inTx(tx, id);
      await this.events.notify(tx, { op: "experiment", change: "create", id, node: nodeId });
    }).catch((err: { code?: string; message?: string }) => {
      if (err.code === "P0001" && err.message === "Node not found") throw new NodeNotFoundError("Node not found");
      throw err;
    });
    const created = await this.get(userId, id);
    // Deleted right after this commit.
    if (!created) throw new NodeNotFoundError("Node not found");
    return created;
  }

  /** The node's live files into experiment `id`, each at its current version; bytes are shared. */
  private async copyNodeFiles(tx: Tx, nodeId: string, id: string) {
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
  }

  /**
   * Sets the given fields; false if the experiment is gone. `provenance`
   * keys are merged into the recorded provenance.
   */
  async update(
    id: string,
    input: ExperimentInput,
    inTx?: (tx: Tx) => Promise<unknown>,
    provenance?: Record<string, unknown>,
  ): Promise<boolean> {
    const fields = cleanInput(input);
    if (!isNodeId(id)) return false;
    return this.sql.begin(async (tx) => {
      const [before] = await tx<{ status: ExperimentStatus; node_id: string | null }[]>`
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
      if (fields.state !== undefined) set.state = fields.state;
      if (Object.keys(set).length) {
        await tx`
          UPDATE experiments SET ${tx(set as Record<string, never>)}, updated_at = now()
          WHERE id = ${id}`;
      }
      if (provenance) {
        await tx`
          UPDATE experiments SET provenance = provenance || ${tx.json(provenance as never)}, updated_at = now()
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
      const [gone] = await tx<{ node_id: string | null }[]>`
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
