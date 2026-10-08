import { randomUUID } from "node:crypto";

import type postgres from "postgres";

import type { BlobStore } from "./blobs";
import { sha256Hex } from "./blobs";
import type { Sql, Tx } from "./db";
import type { AuthorType, EventHub } from "./events";
import { isNodeId, NodeNotFoundError } from "./nodes";
import { mimeForPath, normalizePath } from "./paths";

/**
 * Proposed versions (007_proposals.sql): a change to a file in a knowledge
 * node, or at the workspace root, that someone who can edit there accepts or
 * rejects. Claude's edits to a node arrive this way, and an experiment's
 * author promotes its work to the node the same way. The bytes are a blob, so
 * proposing an experiment's file copies nothing.
 */

export type ProposalStatus = "open" | "accepted" | "rejected" | "withdrawn";
export type Decision = "accept" | "reject" | "withdraw";

const DECIDED: Record<Decision, ProposalStatus> = {
  accept: "accepted",
  reject: "rejected",
  withdraw: "withdrawn",
};

export interface Proposal {
  id: string;
  /** The node whose file it changes; null for the workspace root. */
  node: string | null;
  path: string;
  sha256: string;
  size: number;
  mime: string;
  author: AuthorType;
  /** The user, or the user Claude was acting for. */
  authorId: string;
  authorName: string | null;
  /** The experiment it was promoted from, if any. */
  experiment: string | null;
  /** That experiment's title, when the asking user may see it. */
  experimentTitle: string | null;
  note: string;
  status: ProposalStatus;
  decidedByName: string | null;
  decidedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** No live file at the path yet: accepting creates it. */
  isNew: boolean;
  /** The file changed after this was proposed (the diff to review is against the file as it is now). */
  fileChanged: boolean;
  /** Whether the asking user proposed it (and may withdraw it). */
  mine: boolean;
  /** Whether the asking user may accept or reject it (editor on its place). */
  canDecide: boolean;
}

/** A file an experiment changed that its node doesn't have yet. */
export interface Promotable {
  path: string;
  /** new: the node has no file there; changed: the node's differs. */
  change: "new" | "changed";
  size: number;
  mime: string;
  /** This experiment's open proposal with exactly these bytes, if any. */
  proposal: string | null;
}

export interface ProposeInput {
  node: string | null;
  path: string;
  /** The proposed content: bytes, or a blob already stored (an experiment's file). */
  content: Uint8Array | { sha256: string; size: number };
  mime?: string;
  author: AuthorType;
  authorId: string;
  experimentId?: string | null;
  note?: string;
}

/** The request can't be done as asked (nothing changed, already decided, …). */
export class ProposalError extends Error {}

export interface ListOptions {
  /** One place's proposals (null = the root); undefined for every place. */
  node?: string | null;
  /** Those promoted from this experiment. */
  experiment?: string;
  /** Default: open. */
  status?: ProposalStatus | "all";
  limit?: number;
}

interface ProposalRow {
  id: string;
  node_id: string | null;
  path: string;
  blob_sha256: string;
  size: string;
  mime: string;
  author_type: AuthorType;
  author_id: string;
  author_name: string | null;
  experiment_id: string | null;
  experiment_title: string | null;
  note: string;
  status: ProposalStatus;
  decided_by_name: string | null;
  decided_at: Date | null;
  created_at: Date;
  updated_at: Date;
  is_new: boolean;
  file_changed: boolean;
  mine: boolean;
  can_decide: boolean;
}

const toProposal = (r: ProposalRow): Proposal => ({
  id: r.id,
  node: r.node_id,
  path: r.path,
  sha256: r.blob_sha256,
  size: Number(r.size),
  mime: r.mime,
  author: r.author_type,
  authorId: r.author_id,
  authorName: r.author_name,
  experiment: r.experiment_id,
  experimentTitle: r.experiment_title,
  note: r.note,
  status: r.status,
  decidedByName: r.decided_by_name,
  decidedAt: r.decided_at?.toISOString() ?? null,
  createdAt: r.created_at.toISOString(),
  updatedAt: r.updated_at.toISOString(),
  isNew: r.is_new,
  fileChanged: r.file_changed,
  mine: r.mine,
  canDecide: r.can_decide,
});

const MAX_NOTE_CHARS = 2000;

export class ProposalService {
  constructor(
    private readonly sql: Sql,
    private readonly blobs: BlobStore,
    private readonly events: EventHub,
    private readonly workspaceId: string,
  ) {}

  /** The same proposals through another connection or transaction (see db.ts asUser). */
  withSql(sql: Sql): ProposalService {
    return new ProposalService(sql, this.blobs, this.events, this.workspaceId);
  }

  /** The live file at a place's path, as a join condition on `f` for proposal `p`. */
  private get targetFile() {
    return this.sql`
      f.workspace_id = p.workspace_id AND f.node_id IS NOT DISTINCT FROM p.node_id
      AND f.experiment_id IS NULL AND f.path = p.path AND f.deleted_at IS NULL`;
  }

  /** Proposals with what `userId` needs to know about each; filter with `where`. */
  private select(userId: string, where: postgres.PendingQuery<postgres.Row[]>) {
    return this.sql<ProposalRow[]>`
      SELECT p.id, p.node_id, p.path, p.blob_sha256, p.size, p.mime, p.author_type, p.author_id,
             u.name AS author_name, p.experiment_id,
             CASE WHEN experiment_access(${userId}, p.experiment_id) IS NOT NULL THEN e.title END
               AS experiment_title,
             p.note, p.status, d.name AS decided_by_name, p.decided_at, p.created_at, p.updated_at,
             f.id IS NULL AS is_new,
             f.current_version_id IS DISTINCT FROM p.base_version_id AS file_changed,
             p.author_id = ${userId} AS mine,
             place_rank(p.workspace_id, ${userId}, p.node_id, NULL) >= 2 AS can_decide
      FROM proposals p
      LEFT JOIN nodes n ON n.id = p.node_id
      LEFT JOIN users u ON u.id = p.author_id
      LEFT JOIN users d ON d.id = p.decided_by
      LEFT JOIN experiments e ON e.id = p.experiment_id
      LEFT JOIN files f ON ${this.targetFile}
      WHERE p.workspace_id = ${this.workspaceId}
        AND (p.node_id IS NULL OR n.deleted_at IS NULL)
        AND (p.author_id = ${userId} OR place_rank(p.workspace_id, ${userId}, p.node_id, NULL) >= 1)
        ${where}`;
  }

  /** Proposals `userId` may see (on places they can read, and their own), newest first. */
  async list(userId: string, opts: ListOptions = {}): Promise<Proposal[]> {
    if (opts.node && !isNodeId(opts.node)) return [];
    if (opts.experiment !== undefined && !isNodeId(opts.experiment)) return [];
    const status = opts.status ?? "open";
    const limit = Math.min(Math.max(opts.limit ?? 200, 1), 500);
    const rows = await this.select(
      userId,
      this.sql`
        ${status === "all" ? this.sql`` : this.sql`AND p.status = ${status}`}
        ${opts.node === undefined ? this.sql`` : this.sql`AND p.node_id IS NOT DISTINCT FROM ${opts.node}::uuid`}
        ${opts.experiment === undefined ? this.sql`` : this.sql`AND p.experiment_id = ${opts.experiment}`}
        ORDER BY p.updated_at DESC, p.id
        LIMIT ${limit}`,
    );
    return rows.map(toProposal);
  }

  async get(userId: string, id: string): Promise<Proposal | null> {
    if (!isNodeId(id)) return null;
    const rows = await this.select(userId, this.sql`AND p.id = ${id}`);
    return rows[0] ? toProposal(rows[0]) : null;
  }

  /** The proposed bytes. */
  content(proposal: Pick<Proposal, "sha256">): Promise<Uint8Array> {
    return this.blobs.get(proposal.sha256);
  }

  /**
   * Proposes new content for a file. The proposer's open proposal for the
   * same file, if any, is replaced (so Claude revising its edit leaves one to
   * review). Returns its id; throws ProposalError when the file already has
   * this content.
   */
  async propose(input: ProposeInput, inTx?: (tx: Tx, id: string) => Promise<unknown>): Promise<string> {
    const path = normalizePath(input.path);
    const mime = input.mime || mimeForPath(path);
    const note = (input.note ?? "").trim();
    if (note.length > MAX_NOTE_CHARS) throw new ProposalError(`Notes are at most ${MAX_NOTE_CHARS} characters`);
    let sha256: string;
    let size: number;
    if (input.content instanceof Uint8Array) {
      sha256 = sha256Hex(input.content);
      size = input.content.byteLength;
      await this.blobs.put(sha256, input.content, mime);
    } else {
      ({ sha256, size } = input.content);
    }

    return this.sql.begin(async (tx) => {
      if (input.content instanceof Uint8Array) {
        await tx`INSERT INTO blobs (sha256, size) VALUES (${sha256}, ${size}) ON CONFLICT (sha256) DO NOTHING`;
      }
      // No row lock (viewers may propose, and can't lock a node): a proposal on a
      // node deleted meanwhile is just never listed.
      if (input.node) {
        const [live] = await tx`
          SELECT 1 FROM nodes
          WHERE id = ${input.node} AND workspace_id = ${this.workspaceId} AND deleted_at IS NULL`;
        if (!live) throw new NodeNotFoundError("Node not found");
      }
      const [file] = await tx<{ version: string; sha256: string; mime: string }[]>`
        SELECT f.current_version_id AS version, v.blob_sha256 AS sha256, f.mime
        FROM files f JOIN file_versions v ON v.id = f.current_version_id
        WHERE f.workspace_id = ${this.workspaceId} AND f.node_id IS NOT DISTINCT FROM ${input.node}::uuid
          AND f.experiment_id IS NULL AND f.path = ${path} AND f.deleted_at IS NULL`;
      if (file && file.sha256 === sha256 && file.mime === mime) {
        throw new ProposalError(`${path} already has this content; there is nothing to propose`);
      }
      const fields = {
        base_version_id: file?.version ?? null,
        blob_sha256: sha256,
        size,
        mime,
        experiment_id: input.experimentId ?? null,
        note,
      };
      const [replaced] = await tx<{ id: string }[]>`
        UPDATE proposals SET ${tx(fields)}, updated_at = now()
        WHERE workspace_id = ${this.workspaceId} AND node_id IS NOT DISTINCT FROM ${input.node}::uuid
          AND path = ${path} AND author_type = ${input.author} AND author_id = ${input.authorId}
          AND status = 'open'
        RETURNING id`;
      // Chosen here: with row-level security a new row may not be readable back.
      const id = replaced?.id ?? randomUUID();
      if (!replaced) {
        await tx`
          INSERT INTO proposals ${tx({
            id,
            workspace_id: this.workspaceId,
            node_id: input.node,
            path,
            author_type: input.author,
            author_id: input.authorId,
            ...fields,
          })}`;
      }
      await inTx?.(tx, id);
      await this.events.notify(tx, {
        op: "proposal",
        change: replaced ? "update" : "create",
        id,
        node: input.node,
        path,
        author: input.author,
        authorId: input.authorId,
      });
      return id;
    }) as Promise<string>;
  }

  /**
   * Inside a transaction, marks an open proposal decided. For an accept, call
   * it after writing the file, so it records the version that made. Throws
   * ProposalError if it was already decided.
   */
  async decideIn(tx: Tx, id: string, decision: Decision, userId: string): Promise<void> {
    const status = DECIDED[decision];
    const [row] = await tx<{ node_id: string | null; path: string; author_type: AuthorType; author_id: string }[]>`
      UPDATE proposals p
      SET status = ${status}, decided_by = ${userId}, decided_at = now(), updated_at = now(),
          version_id = CASE WHEN ${status} = 'accepted' THEN (
            SELECT f.current_version_id FROM files f WHERE ${this.targetFile}) END
      WHERE p.id = ${id} AND p.workspace_id = ${this.workspaceId} AND p.status = 'open'
      RETURNING p.node_id, p.path, p.author_type, p.author_id`;
    if (!row) throw new ProposalError("This proposal was already accepted, rejected or withdrawn");
    await this.events.notify(tx, {
      op: "proposal",
      change: status as "accepted" | "rejected" | "withdrawn",
      id,
      node: row.node_id,
      path: row.path,
      author: row.author_type,
      authorId: row.author_id,
    });
  }

  /** Marks an open proposal decided in a transaction of its own. */
  decide(id: string, decision: Decision, userId: string, inTx?: (tx: Tx) => Promise<unknown>): Promise<void> {
    return this.sql.begin(async (tx) => {
      await this.decideIn(tx, id, decision, userId);
      await inTx?.(tx);
    }) as Promise<void>;
  }

  /**
   * Files an experiment changed (or added) since it forked that its node
   * doesn't have as they are now: what promoting it would propose. A file the
   * experiment left alone isn't listed even if the node's copy moved on, so
   * promoting never undoes someone else's work on the node.
   */
  async promotable(experimentId: string): Promise<Promotable[]> {
    if (!isNodeId(experimentId)) return [];
    const rows = await this.sql<
      { path: string; size: string; mime: string; change: "new" | "changed"; proposal: string | null }[]
    >`
      SELECT f.path, v.size, f.mime,
             CASE WHEN nf.id IS NULL THEN 'new' ELSE 'changed' END AS change,
             (SELECT p.id FROM proposals p
              WHERE p.experiment_id = e.id AND p.status = 'open' AND p.path = f.path
                AND p.node_id = e.node_id AND p.blob_sha256 = v.blob_sha256 AND p.mime = f.mime
              LIMIT 1) AS proposal
      FROM experiments e
      JOIN files f ON f.experiment_id = e.id AND f.deleted_at IS NULL
      JOIN file_versions v ON v.id = f.current_version_id
      LEFT JOIN file_versions fv ON fv.id = f.forked_from
      LEFT JOIN files nf ON nf.workspace_id = e.workspace_id AND nf.node_id = e.node_id
        AND nf.experiment_id IS NULL AND nf.path = f.path AND nf.deleted_at IS NULL
      LEFT JOIN file_versions nv ON nv.id = nf.current_version_id
      WHERE e.id = ${experimentId} AND e.workspace_id = ${this.workspaceId} AND e.deleted_at IS NULL
        AND (fv.id IS NULL OR fv.blob_sha256 <> v.blob_sha256 OR fv.mime <> f.mime)
        AND (nv.id IS NULL OR nv.blob_sha256 <> v.blob_sha256 OR nf.mime <> f.mime)
      ORDER BY f.path`;
    return rows.map((r) => ({ ...r, size: Number(r.size) }));
  }

  /** The current bytes' blob of an experiment's file, for proposing it. */
  async experimentFile(
    experimentId: string,
    path: string,
  ): Promise<{ sha256: string; size: number; mime: string } | null> {
    const [row] = await this.sql<{ sha256: string; size: string; mime: string }[]>`
      SELECT v.blob_sha256 AS sha256, v.size, f.mime
      FROM files f JOIN file_versions v ON v.id = f.current_version_id
      WHERE f.workspace_id = ${this.workspaceId} AND f.experiment_id = ${experimentId}
        AND f.path = ${normalizePath(path)} AND f.deleted_at IS NULL`;
    return row ? { sha256: row.sha256, size: Number(row.size), mime: row.mime } : null;
  }
}
