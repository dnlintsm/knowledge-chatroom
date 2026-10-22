import { asUser, inTransaction, type Sql, type Tx } from "./db";
import {
  MemoryConflictError,
  MemoryError,
  MemoryNotFoundError,
  checkInput,
  validName,
  type InboxOp,
  type MemoryInput,
  type MemoryType,
} from "./memory";

/**
 * Shared memory (issue #93, step 3; migrations/020_shared_memory.sql): notes
 * like personal memory's, but for a whole workspace, a knowledge node (and
 * everything below it) or a group of people. Who reads and edits each place
 * follows the grants (shared_memory_rank in the migration). Every query checks
 * that rank itself, and with row-level security Postgres checks it too.
 *
 * A chat run gets the workspace's notes, its user's groups' notes, and the
 * notes of the node the user is in and the nodes above it, each one Auto (in
 * the prompt's memory index), Manual (only found by searching) or Off: for
 * everyone, as its editors set it, or for one person.
 *
 * Claude never changes a shared note itself: its changes are proposals, which
 * someone who can edit the place accepts or rejects. A person shares one of
 * their own notes by copying it in: directly where they can edit, else as a
 * proposal.
 */

export type SharedScope = "workspace" | "node" | "group";
export const SHARED_SCOPES: readonly SharedScope[] = ["workspace", "node", "group"];
export type SharedMode = "auto" | "manual" | "off";
export const SHARED_MODES: readonly SharedMode[] = ["auto", "manual", "off"];
/** Notes per place; more are refused. */
export const MAX_SHARED_NOTES = 200;
/** Open proposals per author; more are refused until some are decided. */
export const MAX_SHARED_PROPOSALS = 50;

/** Where a shared note lives. */
export interface SharedPlace {
  scope: SharedScope;
  nodeId: string | null;
  groupId: string | null;
  /** "Workspace", the node's or the group's name. */
  label: string;
}

export interface SharedSummary {
  id: string;
  name: string;
  description: string;
  type: MemoryType;
  version: number;
  place: SharedPlace;
  /** You can edit it, set it for everyone, and decide its proposals. */
  canEdit: boolean;
  /** What applies to you: yours, else everyone's (Auto by default). */
  mode: SharedMode;
  myMode: SharedMode | null;
  everyoneMode: SharedMode;
  updatedAt: string;
  /** Installed from a memory pack (step 4): read-only until the pack is forked. */
  pack: { installId: string; name: string; version: number } | null;
}

export interface SharedNote extends SharedSummary {
  body: string;
}

export interface SharedVersion {
  version: number;
  description: string;
  type: MemoryType;
  body: string;
  changedBy: string | null;
  changedAs: "user" | "agent";
  createdAt: string;
}

export interface SharedProposal {
  id: string;
  op: InboxOp;
  place: SharedPlace;
  memoryId: string | null;
  name: string;
  description: string | null;
  type: MemoryType | null;
  body: string | null;
  baseVersion: number | null;
  /** The person, or the person Claude was working for. */
  author: string | null;
  authorType: "user" | "agent";
  mine: boolean;
  canDecide: boolean;
  threadId: string | null;
  reason: string | null;
  createdAt: string;
}

/** A shared note in a run's memory: Auto ones go in the index. */
export interface RunSharedNote {
  id: string;
  name: string;
  description: string;
  type: MemoryType;
  label: string;
  mode: Exclude<SharedMode, "off">;
}

/** The handle Claude uses for a shared note, next to personal notes' names. */
export const sharedRef = (id: string) => `shared:${id}`;
const REF = /^shared:([0-9a-f-]{36})$/i;
export const parseSharedRef = (ref: string): string | null => REF.exec(ref)?.[1] ?? null;

const UUID = /^[0-9a-f-]{36}$/i;

interface Row {
  id: string;
  scope: SharedScope;
  node_id: string | null;
  group_id: string | null;
  name: string;
  description: string;
  type: MemoryType;
  body: string;
  version: number;
  updated_at: Date;
  rank: number;
  pack_install_id: string | null;
  pack_name: string | null;
  pack_version: number | null;
  my_mode: SharedMode | null;
  everyone_mode: SharedMode | null;
  label: string | null;
}

interface ProposalRow {
  id: string;
  op: InboxOp;
  scope: SharedScope;
  node_id: string | null;
  group_id: string | null;
  memory_id: string | null;
  name: string;
  description: string | null;
  type: MemoryType | null;
  body: string | null;
  base_version: number | null;
  author_id: string;
  author_type: "user" | "agent";
  thread_id: string | null;
  reason: string | null;
  created_at: Date;
  rank: number;
  label: string | null;
  author: string | null;
}

const placeOf = (row: { scope: SharedScope; node_id: string | null; group_id: string | null; label: string | null }): SharedPlace => ({
  scope: row.scope,
  nodeId: row.node_id,
  groupId: row.group_id,
  label: row.scope === "workspace" ? "Workspace" : row.label ?? (row.scope === "node" ? "A node" : "A group"),
});

const toSummary = (row: Row): SharedSummary => {
  const everyoneMode = row.everyone_mode ?? "auto";
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    type: row.type,
    version: row.version,
    place: placeOf(row),
    canEdit: row.rank >= 2,
    mode: row.my_mode ?? everyoneMode,
    myMode: row.my_mode,
    everyoneMode,
    updatedAt: row.updated_at.toISOString(),
    pack: row.pack_install_id ? { installId: row.pack_install_id, name: row.pack_name ?? "", version: row.pack_version ?? 0 } : null,
  };
};

const toNote = (row: Row): SharedNote => ({ ...toSummary(row), body: row.body });

/** A memory pack's notes change only with the pack. */
function fromPack(row: Row) {
  if (row.pack_install_id) {
    throw new MemoryError(`${row.name} comes from the memory pack ${row.pack_name}: update or fork the pack to change it`);
  }
}

export class SharedMemoryService {
  constructor(
    private readonly sql: Sql,
    private readonly workspaceId: string,
    private readonly rowSecurity: boolean,
  ) {}

  private as<T>(userId: string, fn: (db: Sql) => Promise<T>): Promise<T> {
    if (this.rowSecurity) return asUser(this.sql, userId, fn);
    return this.sql.begin((tx) => fn(inTransaction(tx as Tx))) as Promise<T>;
  }

  /** The user's rank on a place: 0 none, 1 reads, 2 edits. */
  private async rank(db: Sql, userId: string, scope: SharedScope, nodeId: string | null, groupId: string | null): Promise<number> {
    const [{ rank }] = await db<{ rank: number }[]>`
      SELECT shared_memory_rank(${this.workspaceId}, ${userId}, ${scope}, ${nodeId}::uuid, ${groupId}::uuid) AS rank`;
    return rank;
  }

  /**
   * Readable notes, with the user's rank and modes. Labels come from groups
   * and nodes the user may see the note of, so this reads them as the server.
   */
  private async rows(db: Sql, userId: string, where: ReturnType<Sql>): Promise<Row[]> {
    const rows = await db<Row[]>`
      SELECT * FROM (
        SELECT m.id, m.scope, m.node_id, m.group_id, m.name, m.description, m.type, m.body, m.version, m.updated_at,
          shared_memory_rank(m.workspace_id, ${userId}, m.scope, m.node_id, m.group_id) AS rank,
          m.pack_install_id, pk.name AS pack_name, pv.version AS pack_version,
          (SELECT s.mode FROM shared_memory_settings s WHERE s.memory_id = m.id AND s.user_id = ${userId}) AS my_mode,
          (SELECT s.mode FROM shared_memory_settings s WHERE s.memory_id = m.id AND s.user_id IS NULL) AS everyone_mode
        FROM shared_memories m
        LEFT JOIN nodes n ON n.id = m.node_id
        LEFT JOIN memory_pack_installs pi ON pi.id = m.pack_install_id
        LEFT JOIN hub_memory_packs pk ON pk.id = pi.pack_id
        LEFT JOIN hub_memory_pack_versions pv ON pv.id = pi.version_id
        WHERE m.workspace_id = ${this.workspaceId} AND (m.node_id IS NULL OR n.deleted_at IS NULL) AND ${where}
      ) r
      WHERE r.rank >= 1
      ORDER BY r.scope, r.name`;
    return this.label(rows);
  }

  private async label<T extends { scope: SharedScope; node_id: string | null; group_id: string | null; label: string | null }>(rows: T[]): Promise<T[]> {
    const nodes = [...new Set(rows.map((r) => r.node_id).filter((id): id is string => !!id))];
    const groups = [...new Set(rows.map((r) => r.group_id).filter((id): id is string => !!id))];
    const names = new Map<string, string>();
    if (nodes.length) {
      for (const n of await this.sql<{ id: string; name: string }[]>`SELECT id, name FROM nodes WHERE id = ANY(${nodes}::uuid[])`) {
        names.set(n.id, n.name);
      }
    }
    if (groups.length) {
      for (const g of await this.sql<{ id: string; name: string }[]>`SELECT id, name FROM groups WHERE id = ANY(${groups}::uuid[])`) {
        names.set(g.id, g.name);
      }
    }
    for (const row of rows) row.label = names.get(row.node_id ?? row.group_id ?? "") ?? null;
    return rows;
  }

  /** Holds the note until the transaction ends, so a version check stays true while writing. */
  private async lock(db: Sql, id: string): Promise<void> {
    if (UUID.test(id)) await db`SELECT 1 FROM shared_memories WHERE id = ${id} FOR UPDATE`;
  }

  private async one(db: Sql, userId: string, id: string): Promise<Row> {
    if (!UUID.test(id)) throw new MemoryNotFoundError(sharedRef(String(id)));
    const [row] = await this.rows(db, userId, db`m.id = ${id}`);
    if (!row) throw new MemoryNotFoundError(sharedRef(id));
    return row;
  }

  /** Every shared note the user can read. */
  list(userId: string): Promise<SharedSummary[]> {
    return this.as(userId, async (db) => (await this.rows(db, userId, db`true`)).map(toSummary));
  }

  /**
   * The notes a run gets: the workspace's, the user's groups', and those of
   * `nodeId` and the nodes above it; not the ones Off for the user.
   */
  forRun(userId: string, nodeId: string | null): Promise<RunSharedNote[]> {
    const node = nodeId && UUID.test(nodeId) ? nodeId : null;
    return this.as(userId, async (db) => {
      const rows = await this.rows(
        db,
        userId,
        db`(m.scope <> 'node' OR (${node}::uuid IS NOT NULL AND n.path @> (SELECT t.path FROM nodes t WHERE t.id = ${node}::uuid)))`,
      );
      return rows
        .map((row) => ({ row, mode: toSummary(row).mode }))
        .filter((r): r is { row: Row; mode: Exclude<SharedMode, "off"> } => r.mode !== "off")
        .map(({ row, mode }) => ({
          id: row.id,
          name: row.name,
          description: row.description,
          type: row.type,
          label: placeOf(row).label,
          mode,
        }));
    });
  }

  /** One note with its body. */
  get(userId: string, id: string): Promise<SharedNote> {
    return this.as(userId, async (db) => toNote(await this.one(db, userId, id)));
  }

  versions(userId: string, id: string): Promise<SharedVersion[]> {
    return this.as(userId, async (db) => {
      await this.one(db, userId, id);
      const rows = await db<{ version: number; description: string; type: MemoryType; body: string; changed_by: string | null; changed_as: "user" | "agent"; created_at: Date }[]>`
        SELECT v.version, v.description, v.type, v.body, v.changed_as, v.created_at,
          (SELECT coalesce(u.name, u.email) FROM users u WHERE u.id = v.changed_by) AS changed_by
        FROM shared_memory_versions v WHERE v.memory_id = ${id} ORDER BY v.version DESC`;
      return rows.map((r) => ({
        version: r.version,
        description: r.description,
        type: r.type,
        body: r.body,
        changedBy: r.changed_by,
        changedAs: r.changed_as,
        createdAt: r.created_at.toISOString(),
      }));
    });
  }

  /** The place, checked: a known scope with the ids it needs. */
  private place(input: { scope?: unknown; nodeId?: unknown; groupId?: unknown }): { scope: SharedScope; nodeId: string | null; groupId: string | null } {
    const scope = input.scope as SharedScope;
    if (!SHARED_SCOPES.includes(scope)) throw new MemoryError("scope is workspace, node or group");
    const nodeId = scope === "node" ? input.nodeId : null;
    const groupId = scope === "group" ? input.groupId : null;
    if (scope === "node" && (typeof nodeId !== "string" || !UUID.test(nodeId))) throw new MemoryError("Say which node: nodeId");
    if (scope === "group" && (typeof groupId !== "string" || !UUID.test(groupId))) throw new MemoryError("Say which group: groupId");
    return { scope, nodeId: nodeId as string | null, groupId: groupId as string | null };
  }

  /** Writes the next version of a note (or its first). */
  private async write(db: Sql, row: { id: string } | null, place: { scope: SharedScope; nodeId: string | null; groupId: string | null }, name: string, input: MemoryInput, by: string, as: "user" | "agent"): Promise<string> {
    let id: string;
    let version: number;
    if (row) {
      [{ id, version }] = await db<{ id: string; version: number }[]>`
        UPDATE shared_memories SET description = ${input.description}, type = ${input.type}, body = ${input.body},
          version = version + 1, updated_by = ${by}, updated_at = now()
        WHERE id = ${row.id} RETURNING id, version`;
    } else {
      const [{ count }] = await db<{ count: number }[]>`
        SELECT count(*)::int AS count FROM shared_memories
        WHERE workspace_id = ${this.workspaceId} AND scope = ${place.scope}
          AND node_id IS NOT DISTINCT FROM ${place.nodeId}::uuid AND group_id IS NOT DISTINCT FROM ${place.groupId}::uuid`;
      if (count >= MAX_SHARED_NOTES) throw new MemoryError(`A place has at most ${MAX_SHARED_NOTES} shared notes`);
      const [taken] = await db`
        SELECT 1 FROM shared_memories
        WHERE workspace_id = ${this.workspaceId} AND scope = ${place.scope} AND name = ${name}
          AND node_id IS NOT DISTINCT FROM ${place.nodeId}::uuid AND group_id IS NOT DISTINCT FROM ${place.groupId}::uuid`;
      if (taken) throw new MemoryConflictError(`There is already a shared note named ${name} there`);
      [{ id, version }] = await db<{ id: string; version: number }[]>`
        INSERT INTO shared_memories (workspace_id, scope, node_id, group_id, name, description, type, body, created_by, updated_by)
        VALUES (${this.workspaceId}, ${place.scope}, ${place.nodeId}, ${place.groupId}, ${name},
                ${input.description}, ${input.type}, ${input.body}, ${by}, ${by})
        RETURNING id, version`;
    }
    await db`
      INSERT INTO shared_memory_versions (memory_id, version, description, type, body, changed_by, changed_as)
      VALUES (${id}, ${version}, ${input.description}, ${input.type}, ${input.body}, ${by}, ${as})`;
    return id;
  }

  /**
   * Shares a copy of a note into a place: made there when the user can edit
   * it, else proposed to its editors.
   */
  async share(
    userId: string,
    target: { scope?: unknown; nodeId?: unknown; groupId?: unknown },
    name: unknown,
    input: Partial<MemoryInput>,
  ): Promise<{ note: SharedNote | null; proposal: SharedProposal | null }> {
    if (!validName(name)) throw new MemoryError("A memory's name is lowercase letters, digits and dashes, at most 64 (e.g. writing-style)");
    const place = this.place(target);
    const clean = checkInput(input);
    const made = await this.as(userId, async (db) => {
      const rank = await this.rank(db, userId, place.scope, place.nodeId, place.groupId);
      if (rank < 1) throw new MemoryError("You can't share to that place");
      if (rank < 2) return null;
      return this.write(db, null, place, name, clean, userId, "user");
    });
    if (made) return { note: await this.get(userId, made), proposal: null };
    const proposal = await this.propose(userId, { op: "add", place: target, name, input: clean }, { authorType: "user" });
    return { note: null, proposal };
  }

  /** An editor's own change; `ifVersion` refuses a note that changed since. */
  update(userId: string, id: string, input: Partial<MemoryInput>, ifVersion?: number): Promise<SharedNote> {
    const clean = checkInput(input);
    return this.as(userId, async (db) => {
      await this.lock(db, id);
      const row = await this.one(db, userId, id);
      if (row.rank < 2) throw new MemoryError("Only its place's editors change a shared note; Claude can propose a change");
      fromPack(row);
      if (ifVersion !== undefined && row.version !== ifVersion) throw new MemoryConflictError(`${row.name} changed since`);
      if (row.description === clean.description && row.type === clean.type && row.body === clean.body) return toNote(row);
      await this.write(db, row, placeOf(row), row.name, clean, userId, "user");
      return toNote(await this.one(db, userId, id));
    });
  }

  /** Deletes a note for good, with its versions. */
  remove(userId: string, id: string): Promise<void> {
    return this.as(userId, async (db) => {
      const row = await this.one(db, userId, id);
      if (row.rank < 2) throw new MemoryError("Only its place's editors delete a shared note");
      fromPack(row);
      await db`DELETE FROM shared_memories WHERE id = ${row.id}`;
    });
  }

  /**
   * Proposes a change for the place's editors: a new note (`place`), or a
   * change to or deletion of one (`id`). Proposing the same again replaces
   * the author's open proposal.
   */
  async propose(
    userId: string,
    change: {
      op: InboxOp;
      id?: string;
      place?: { scope?: unknown; nodeId?: unknown; groupId?: unknown };
      name?: unknown;
      input?: Partial<MemoryInput>;
      reason?: string | null;
    },
    origin: { authorType: "user" | "agent"; threadId?: string | null },
  ): Promise<SharedProposal> {
    const { op } = change;
    if (op !== "add" && op !== "update" && op !== "delete") throw new MemoryError("op is add, update or delete");
    const clean = op === "delete" ? null : checkInput(change.input ?? {});
    const reason = change.reason?.replace(/\s+/g, " ").trim().slice(0, 500) || null;
    const id = await this.as(userId, async (db) => {
      let place: { scope: SharedScope; nodeId: string | null; groupId: string | null };
      let memoryId: string | null = null;
      let name: string;
      let base: number | null = null;
      if (op === "add") {
        place = this.place(change.place ?? {});
        if (!validName(change.name)) throw new MemoryError(`Invalid memory name: ${String(change.name)}`);
        name = change.name;
        if (await this.rank(db, userId, place.scope, place.nodeId, place.groupId) < 1) {
          throw new MemoryError("You can't propose notes for that place");
        }
      } else {
        const row = await this.one(db, userId, change.id ?? "");
        fromPack(row);
        place = placeOf(row);
        memoryId = row.id;
        name = row.name;
        base = row.version;
      }
      const [{ count }] = await db<{ count: number }[]>`
        SELECT count(*)::int AS count FROM shared_memory_proposals
        WHERE workspace_id = ${this.workspaceId} AND author_id = ${userId} AND status = 'open'`;
      const [open] = await db<{ id: string }[]>`
        SELECT id FROM shared_memory_proposals
        WHERE workspace_id = ${this.workspaceId} AND author_id = ${userId} AND author_type = ${origin.authorType}
          AND status = 'open' AND op = ${op} AND scope = ${place.scope} AND name = ${name}
          AND node_id IS NOT DISTINCT FROM ${place.nodeId}::uuid AND group_id IS NOT DISTINCT FROM ${place.groupId}::uuid
        FOR UPDATE`;
      if (open) {
        await db`
          UPDATE shared_memory_proposals SET
            description = ${clean?.description ?? null}, type = ${clean?.type ?? null}, body = ${clean?.body ?? null},
            base_version = ${base}, thread_id = ${origin.threadId ?? null}, reason = ${reason}, created_at = now()
          WHERE id = ${open.id}`;
        return open.id;
      }
      if (count >= MAX_SHARED_PROPOSALS) {
        throw new MemoryError(`You have ${MAX_SHARED_PROPOSALS} shared-memory proposals waiting; more wait until some are decided`);
      }
      const [row] = await db<{ id: string }[]>`
        INSERT INTO shared_memory_proposals
          (workspace_id, scope, node_id, group_id, memory_id, op, name, description, type, body,
           base_version, author_id, author_type, thread_id, reason)
        VALUES (${this.workspaceId}, ${place.scope}, ${place.nodeId}, ${place.groupId}, ${memoryId}, ${op}, ${name},
                ${clean?.description ?? null}, ${clean?.type ?? null}, ${clean?.body ?? null}, ${base},
                ${userId}, ${origin.authorType}, ${origin.threadId ?? null}, ${reason})
        RETURNING id`;
      return row.id;
    });
    const [proposal] = await this.proposalRows(userId, id);
    return proposal;
  }

  private proposalRows(userId: string, id?: string): Promise<SharedProposal[]> {
    return this.as(userId, async (db) => {
      const rows = await db<ProposalRow[]>`
        SELECT * FROM (
          SELECT p.*, shared_memory_rank(p.workspace_id, ${userId}, p.scope, p.node_id, p.group_id) AS rank,
            NULL::text AS label,
            (SELECT coalesce(u.name, u.email) FROM users u WHERE u.id = p.author_id) AS author
          FROM shared_memory_proposals p
          WHERE p.workspace_id = ${this.workspaceId} AND p.status = 'open' ${id ? db`AND p.id = ${id}` : db``}
        ) r
        WHERE r.author_id = ${userId} OR r.rank >= 2
        ORDER BY r.created_at, r.id`;
      return (await this.label(rows)).map((r) => ({
        id: r.id,
        op: r.op,
        place: placeOf(r),
        memoryId: r.memory_id,
        name: r.name,
        description: r.description,
        type: r.type,
        body: r.body,
        baseVersion: r.base_version,
        author: r.author,
        authorType: r.author_type,
        mine: r.author_id === userId,
        canDecide: r.rank >= 2,
        threadId: r.thread_id,
        reason: r.reason,
        createdAt: r.created_at.toISOString(),
      }));
    });
  }

  /** Open proposals the user may decide, and their own. */
  proposals(userId: string): Promise<SharedProposal[]> {
    return this.proposalRows(userId);
  }

  /**
   * Accepts, rejects or (the author) withdraws a proposal. Accepting makes the
   * change, credited to its author; a note changed since is a conflict.
   */
  decide(userId: string, id: string, decision: "accept" | "reject" | "withdraw"): Promise<{ note: SharedNote | null }> {
    if (!UUID.test(id)) return Promise.reject(new MemoryNotFoundError("proposal"));
    return this.as(userId, async (db) => {
      const [p] = await db<(ProposalRow & { rank: number })[]>`
        SELECT p.*, shared_memory_rank(p.workspace_id, ${userId}, p.scope, p.node_id, p.group_id) AS rank
        FROM shared_memory_proposals p
        WHERE p.id = ${id} AND p.workspace_id = ${this.workspaceId} AND p.status = 'open'
        FOR UPDATE`;
      if (!p || (p.author_id !== userId && p.rank < 2)) throw new MemoryError("No open proposal like that");
      if (decision === "withdraw") {
        if (p.author_id !== userId) throw new MemoryError("Only its author withdraws a proposal");
        await db`UPDATE shared_memory_proposals SET status = 'withdrawn', decided_at = now() WHERE id = ${id}`;
        return { note: null };
      }
      if (p.rank < 2) throw new MemoryError("Only its place's editors decide a proposal");
      await db`
        UPDATE shared_memory_proposals SET status = ${decision === "accept" ? "accepted" : "rejected"},
          decided_by = ${userId}, decided_at = now()
        WHERE id = ${id}`;
      if (decision === "reject") return { note: null };
      const place = { scope: p.scope, nodeId: p.node_id, groupId: p.group_id };
      if (p.op === "add") {
        const made = await this.write(db, null, place, p.name, { description: p.description!, type: p.type!, body: p.body! }, p.author_id, p.author_type);
        return { note: toNote(await this.one(db, userId, made)) };
      }
      const [row] = p.memory_id
        ? await db<{ id: string; version: number }[]>`SELECT id, version FROM shared_memories WHERE id = ${p.memory_id} FOR UPDATE`
        : [];
      if (!row || row.version !== p.base_version) {
        throw new MemoryConflictError(`${p.name} changed since this was proposed; reject it, or edit the note yourself`);
      }
      if (p.op === "delete") {
        await db`DELETE FROM shared_memories WHERE id = ${row.id}`;
        return { note: null };
      }
      await this.write(db, row, place, p.name, { description: p.description!, type: p.type!, body: p.body! }, p.author_id, p.author_type);
      return { note: toNote(await this.one(db, userId, row.id)) };
    });
  }

  /**
   * Sets a note's mode for the user, or (`everyone`, its editors) the default
   * for everyone; null clears the user's own, back to everyone's.
   */
  setMode(userId: string, id: string, mode: unknown, everyone: boolean): Promise<SharedSummary> {
    if (mode !== null && !SHARED_MODES.includes(mode as SharedMode)) {
      return Promise.reject(new MemoryError("mode is auto, manual or off"));
    }
    if (everyone && mode === null) return Promise.reject(new MemoryError("Say the mode for everyone"));
    return this.as(userId, async (db) => {
      const row = await this.one(db, userId, id);
      if (everyone && row.rank < 2) throw new MemoryError("Only its place's editors set a shared note for everyone");
      const owner = everyone ? null : userId;
      if (mode === null) {
        await db`DELETE FROM shared_memory_settings WHERE memory_id = ${row.id} AND user_id = ${userId}`;
      } else {
        await db`
          INSERT INTO shared_memory_settings (memory_id, user_id, mode) VALUES (${row.id}, ${owner}, ${mode as SharedMode})
          ON CONFLICT (memory_id, user_id) DO UPDATE SET mode = EXCLUDED.mode, updated_at = now()`;
      }
      return toSummary(await this.one(db, userId, id));
    });
  }

  /** Places the user can share to: the workspace, `nodeId`, their groups. */
  targets(userId: string, nodeId: string | null): Promise<(SharedPlace & { canEdit: boolean })[]> {
    const node = nodeId && UUID.test(nodeId) ? nodeId : null;
    return this.as(userId, async (db) => {
      const rows = await db<{ scope: SharedScope; node_id: string | null; group_id: string | null; rank: number; label: string | null }[]>`
        SELECT * FROM (
          SELECT 'workspace' AS scope, NULL::uuid AS node_id, NULL::uuid AS group_id, NULL::text AS label,
            shared_memory_rank(${this.workspaceId}, ${userId}, 'workspace', NULL, NULL) AS rank
          UNION ALL
          SELECT 'node', ${node}::uuid, NULL, NULL,
            shared_memory_rank(${this.workspaceId}, ${userId}, 'node', ${node}::uuid, NULL)
          WHERE ${node}::uuid IS NOT NULL
        ) r WHERE r.rank >= 1`;
      // Groups aren't readable as the user: the rank says which are theirs.
      rows.push(...(await this.sql<typeof rows>`
        SELECT * FROM (
          SELECT 'group' AS scope, NULL::uuid AS node_id, id AS group_id, NULL::text AS label,
            shared_memory_rank(${this.workspaceId}, ${userId}, 'group', NULL, id) AS rank
          FROM groups WHERE workspace_id = ${this.workspaceId}
        ) r WHERE r.rank >= 1`));
      return (await this.label(rows)).map((r) => ({ ...placeOf(r), canEdit: r.rank >= 2 }));
    });
  }

  /** Shared notes in the run's set (not Off) matching words in the query. */
  async search(userId: string, nodeId: string | null, query: string, limit = 10): Promise<(RunSharedNote & { snippet: string })[]> {
    const words = [...new Set(query.toLowerCase().split(/\s+/).filter((w) => w.length > 1))].slice(0, 12);
    if (!words.length) return [];
    const notes = await this.forRun(userId, nodeId);
    if (!notes.length) return [];
    const bodies = await this.as(userId, (db) => db<{ id: string; body: string }[]>`
      SELECT id, body FROM shared_memories WHERE id = ANY(${notes.map((n) => n.id)}::uuid[])`);
    const body = new Map(bodies.map((b) => [b.id, b.body]));
    return notes
      .map((n) => {
        const text = `${n.name} ${n.description} ${body.get(n.id) ?? ""}`.toLowerCase();
        const score = words.filter((w) => text.includes(w)).length;
        const line = (body.get(n.id) ?? "").split("\n").find((l) => words.some((w) => l.toLowerCase().includes(w))) ?? "";
        return { note: { ...n, snippet: line.trim().slice(0, 200) }, score };
      })
      .filter((n) => n.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((n) => n.note);
  }
}
