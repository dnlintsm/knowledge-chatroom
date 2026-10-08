import type { Sql, Tx } from "./db";
import type { EventHub } from "./events";

/** A level of the knowledge tree, such as tech (depth 1) or process (depth 4). */
export interface NodeType {
  name: string;
  depth: number;
}

export interface KnowledgeNode {
  id: string;
  parentId: string | null;
  type: string;
  depth: number;
  name: string;
  /** Live files attached directly to this node. */
  fileCount: number;
  updatedAt: string;
}

/** The request can't be done as asked (bad name, no deeper level, duplicate). */
export class NodeError extends Error {}
export class NodeNotFoundError extends NodeError {}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isNodeId = (id: string) => UUID.test(id);

interface NodeRow {
  id: string;
  parent_id: string | null;
  type: string;
  depth: number;
  name: string;
  file_count: string;
  updated_at: Date;
}

const toNode = (row: NodeRow): KnowledgeNode => ({
  id: row.id,
  parentId: row.parent_id,
  type: row.type,
  depth: row.depth,
  name: row.name,
  fileCount: Number(row.file_count),
  updatedAt: row.updated_at.toISOString(),
});

function cleanName(name: string) {
  const trimmed = name.trim().replace(/\s+/g, " ");
  if (!trimmed) throw new NodeError("A node needs a name");
  if (trimmed.length > 200) throw new NodeError("Node names are at most 200 characters");
  return trimmed;
}

/** Turns constraint and trigger errors into messages a user can act on. */
function explain(err: unknown): never {
  const e = err as { code?: string; message?: string };
  if (e.code === "23505") throw new NodeError("A node with that name already exists here");
  if (e.code === "P0001") throw new NodeError(e.message ?? "Invalid node");
  throw err;
}

/**
 * The knowledge tree of one workspace. Levels come from node_types (seeded as
 * tech › module › loop › process), and every node sits exactly one level below
 * its parent; the database enforces that (see 002_knowledge_tree.sql).
 */
export class NodeService {
  constructor(
    private readonly sql: Sql,
    private readonly events: EventHub,
    private readonly workspaceId: string,
  ) {}

  async types(): Promise<NodeType[]> {
    return this.sql<NodeType[]>`
      SELECT name, depth FROM node_types
      WHERE workspace_id = ${this.workspaceId} ORDER BY depth`;
  }

  /** Every live node, parents before children, siblings by name. */
  async list(): Promise<KnowledgeNode[]> {
    const rows = await this.sql<NodeRow[]>`
      SELECT n.id, n.parent_id, t.name AS type, t.depth, n.name, n.updated_at,
             (SELECT count(*) FROM files f
              WHERE f.node_id = n.id AND f.deleted_at IS NULL) AS file_count
      FROM nodes n JOIN node_types t ON t.id = n.type_id
      WHERE n.workspace_id = ${this.workspaceId} AND n.deleted_at IS NULL
      ORDER BY t.depth, lower(n.name)`;
    return rows.map(toNode);
  }

  async get(id: string): Promise<KnowledgeNode | null> {
    if (!isNodeId(id)) return null;
    const [row] = await this.sql<NodeRow[]>`
      SELECT n.id, n.parent_id, t.name AS type, t.depth, n.name, n.updated_at,
             (SELECT count(*) FROM files f
              WHERE f.node_id = n.id AND f.deleted_at IS NULL) AS file_count
      FROM nodes n JOIN node_types t ON t.id = n.type_id
      WHERE n.id = ${id} AND n.workspace_id = ${this.workspaceId}
        AND n.deleted_at IS NULL`;
    return row ? toNode(row) : null;
  }

  /** The node and its ancestors, top level first; null if the node is missing. */
  async lineage(id: string): Promise<KnowledgeNode[] | null> {
    if (!isNodeId(id)) return null;
    const rows = await this.sql<NodeRow[]>`
      SELECT a.id, a.parent_id, t.name AS type, t.depth, a.name, a.updated_at,
             (SELECT count(*) FROM files f
              WHERE f.node_id = a.id AND f.deleted_at IS NULL) AS file_count
      FROM nodes n
      JOIN nodes a ON a.path @> n.path AND a.workspace_id = n.workspace_id
      JOIN node_types t ON t.id = a.type_id
      WHERE n.id = ${id} AND n.workspace_id = ${this.workspaceId}
        AND n.deleted_at IS NULL
      ORDER BY t.depth`;
    return rows.length ? rows.map(toNode) : null;
  }

  /**
   * Adds a node under `parentId` (null for the top level). Its type is the
   * level below the parent's.
   */
  async create(parentId: string | null, rawName: string): Promise<KnowledgeNode> {
    const name = cleanName(rawName);
    if (parentId !== null && !isNodeId(parentId)) throw new NodeNotFoundError("Parent node not found");
    const id = await this.sql
      .begin(async (tx) => {
        let parent: { depth: number; type: string } | undefined;
        if (parentId) {
          [parent] = await tx<{ depth: number; type: string }[]>`
            SELECT t.depth, t.name AS type
            FROM nodes n JOIN node_types t ON t.id = n.type_id
            WHERE n.id = ${parentId} AND n.workspace_id = ${this.workspaceId}
              AND n.deleted_at IS NULL`;
          if (!parent) throw new NodeNotFoundError("Parent node not found");
        }
        const [type] = await tx<{ id: string }[]>`
          SELECT id FROM node_types
          WHERE workspace_id = ${this.workspaceId} AND depth = ${(parent?.depth ?? 0) + 1}`;
        if (!type) {
          throw new NodeError(
            parent ? `Nothing can go below a ${parent.type}` : "No knowledge levels are set up",
          );
        }
        const [row] = await tx<{ id: string }[]>`
          INSERT INTO nodes (workspace_id, parent_id, type_id, name)
          VALUES (${this.workspaceId}, ${parentId}, ${type.id}, ${name})
          RETURNING id`;
        await this.events.notify(tx, { op: "node", change: "create", id: row.id });
        return row.id;
      })
      .catch(explain);
    return (await this.get(id))!;
  }

  async rename(id: string, rawName: string): Promise<KnowledgeNode | null> {
    const name = cleanName(rawName);
    if (!isNodeId(id)) return null;
    const renamed = await this.sql
      .begin(async (tx) => {
        const rows = await tx`
          UPDATE nodes SET name = ${name}, updated_at = now()
          WHERE id = ${id} AND workspace_id = ${this.workspaceId} AND deleted_at IS NULL`;
        if (rows.count === 0) return false;
        await this.events.notify(tx, { op: "node", change: "rename", id });
        return true;
      })
      .catch(explain);
    return renamed ? this.get(id) : null;
  }

  /**
   * Soft-deletes the node, everything below it, and their files. History
   * stays in the database.
   */
  async remove(id: string): Promise<boolean> {
    if (!isNodeId(id)) return false;
    return this.sql.begin(async (tx) => {
      const [target] = await tx<{ path: string }[]>`
        SELECT path FROM nodes
        WHERE id = ${id} AND workspace_id = ${this.workspaceId} AND deleted_at IS NULL
        FOR UPDATE`;
      if (!target) return false;
      await tx`
        WITH gone AS (
          UPDATE nodes SET deleted_at = now()
          WHERE workspace_id = ${this.workspaceId} AND deleted_at IS NULL
            AND path <@ ${target.path}::ltree
          RETURNING id)
        UPDATE files SET deleted_at = now()
        WHERE deleted_at IS NULL AND node_id IN (SELECT id FROM gone)`;
      await this.events.notify(tx, { op: "node", change: "delete", id });
      return true;
    });
  }

  /**
   * Inside a file write: fails unless the node is live, and holds it so a
   * concurrent delete waits for the write (and then removes the file too).
   */
  static async lockLive(tx: Tx, workspaceId: string, id: string) {
    const [row] = await tx`
      SELECT 1 FROM nodes
      WHERE id = ${id} AND workspace_id = ${workspaceId} AND deleted_at IS NULL
      FOR SHARE`;
    if (!row) throw new NodeNotFoundError("Node not found");
  }
}
