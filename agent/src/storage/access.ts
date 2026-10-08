import type { Sql, Tx } from "./db";
import { isNodeId } from "./nodes";

/**
 * Users, the org tree (groups), grants and the audit log. The role logic lives
 * in SQL (effective_role in 003_access.sql); this is the TypeScript side.
 */

export type Role = "viewer" | "editor" | "owner";
export const ROLES: Role[] = ["viewer", "editor", "owner"];

export function atLeast(role: Role | null, min: Role): boolean {
  return role !== null && ROLES.indexOf(role) >= ROLES.indexOf(min);
}

/** Who is asking: a user, or Claude acting for that user. */
export interface Principal {
  userId: string;
  actor: "user" | "agent";
}

/** Signed in, but not allowed to do this. */
export class ForbiddenError extends Error {}
/** The request names something invalid (bad name, unknown user, …). */
export class AccessError extends Error {}

export interface User {
  id: string;
  subject: string;
  email: string | null;
  name: string | null;
}

export interface Group {
  id: string;
  parentId: string | null;
  name: string;
  /** Direct members; members of sub-groups are listed on those groups. */
  memberIds: string[];
}

export interface Grant {
  id: string;
  /** null = the whole workspace. */
  nodeId: string | null;
  principalType: "user" | "group";
  principalId: string;
  role: Role;
  createdAt: string;
}

export interface AuditEntry {
  id: string;
  actorType: "user" | "agent";
  actorId: string | null;
  action: string;
  target: Record<string, unknown>;
  at: string;
}

const isUuid = isNodeId;

function cleanName(name: string, what: string) {
  const trimmed = name.trim().replace(/\s+/g, " ");
  if (!trimmed) throw new AccessError(`A ${what} needs a name`);
  if (trimmed.length > 200) throw new AccessError(`${what} names are at most 200 characters`);
  return trimmed;
}

function explain(err: unknown): never {
  const e = err as { code?: string; message?: string };
  if (e.code === "23505") throw new AccessError("That name is already taken here");
  if (e.code === "23503") throw new AccessError("Unknown user or group");
  if (e.code === "P0001") throw new AccessError(e.message ?? "Invalid request");
  throw err;
}

export class AccessService {
  private localUser: Promise<string> | null = null;
  private readonly subjects = new Map<string, string>();

  constructor(
    private readonly sql: Sql,
    private readonly workspaceId: string,
  ) {}

  /** The built-in user of a deployment without login. */
  localUserId(): Promise<string> {
    this.localUser ??= this.sql<{ id: string }[]>`
      SELECT id FROM users WHERE subject = 'local'`.then(([row]) => row.id);
    return this.localUser;
  }

  /**
   * The user for a login identity, created on first sight. Name and email
   * follow the provider. The first user to sign in to a workspace that only
   * the local user owns becomes its owner, so a new deployment can be set up.
   */
  async userForSubject(subject: string, profile: { email?: string; name?: string } = {}) {
    const cached = this.subjects.get(subject);
    if (cached) return cached;
    const id = await this.sql.begin(async (tx) => {
      const [user] = await tx<{ id: string }[]>`
        INSERT INTO users (subject, email, name)
        VALUES (${subject}, ${profile.email ?? null}, ${profile.name ?? null})
        ON CONFLICT (subject) DO UPDATE
          SET email = coalesce(EXCLUDED.email, users.email),
              name = coalesce(EXCLUDED.name, users.name)
        RETURNING id`;
      // Serialize first sign-ins so exactly one becomes the owner.
      await tx`SELECT pg_advisory_xact_lock(hashtext('knowledge-chatroom:first-owner'))`;
      await tx`
        INSERT INTO grants (workspace_id, node_id, principal_type, principal_id, role)
        SELECT ${this.workspaceId}, NULL, 'user', ${user.id}, 'owner'
        WHERE NOT EXISTS (
          SELECT 1 FROM grants g JOIN users u ON u.id = g.principal_id
          WHERE g.workspace_id = ${this.workspaceId} AND g.principal_type = 'user'
            AND g.role = 'owner' AND u.subject <> 'local')
        ON CONFLICT DO NOTHING`;
      return user.id;
    });
    this.subjects.set(subject, id);
    return id;
  }

  /** The user's best role on a node (null = workspace root), or null if none. */
  async role(userId: string, nodeId: string | null): Promise<Role | null> {
    if (nodeId !== null && !isUuid(nodeId)) return null;
    const [row] = await this.sql<{ role: Role | null }[]>`
      SELECT effective_role(${this.workspaceId}, ${userId}, ${nodeId}::uuid) AS role`;
    return row.role;
  }

  /** The user's role on every live node, keyed by node id. */
  async nodeRoles(userId: string): Promise<Map<string, Role | null>> {
    const rows = await this.sql<{ id: string; role: Role | null }[]>`
      SELECT id, effective_role(${this.workspaceId}, ${userId}, id) AS role
      FROM nodes WHERE workspace_id = ${this.workspaceId} AND deleted_at IS NULL`;
    return new Map(rows.map((r) => [r.id, r.role]));
  }

  async users(): Promise<User[]> {
    return this.sql<User[]>`
      SELECT id, subject, email, name FROM users ORDER BY coalesce(name, email, subject)`;
  }

  async user(id: string): Promise<User | null> {
    if (!isUuid(id)) return null;
    const [row] = await this.sql<User[]>`
      SELECT id, subject, email, name FROM users WHERE id = ${id}`;
    return row ?? null;
  }

  async groups(): Promise<Group[]> {
    const rows = await this.sql<
      { id: string; parent_id: string | null; name: string; member_ids: string[] }[]
    >`
      SELECT g.id, g.parent_id, g.name,
             coalesce(array_agg(m.user_id) FILTER (WHERE m.user_id IS NOT NULL), '{}') AS member_ids
      FROM groups g LEFT JOIN group_members m ON m.group_id = g.id
      WHERE g.workspace_id = ${this.workspaceId}
      GROUP BY g.id
      ORDER BY nlevel(g.path), lower(g.name)`;
    return rows.map((r) => ({
      id: r.id,
      parentId: r.parent_id,
      name: r.name,
      memberIds: r.member_ids,
    }));
  }

  async createGroup(parentId: string | null, name: string, inTx?: (tx: Tx, id: string) => Promise<unknown>) {
    const clean = cleanName(name, "group");
    if (parentId !== null && !isUuid(parentId)) throw new AccessError("Parent group not found");
    return this.sql
      .begin(async (tx) => {
        const [row] = await tx<{ id: string }[]>`
          INSERT INTO groups (workspace_id, parent_id, name)
          VALUES (${this.workspaceId}, ${parentId}, ${clean}) RETURNING id`;
        await inTx?.(tx, row.id);
        return row.id;
      })
      .catch(explain);
  }

  async renameGroup(id: string, name: string, inTx?: (tx: Tx) => Promise<unknown>) {
    const clean = cleanName(name, "group");
    if (!isUuid(id)) return false;
    return this.sql
      .begin(async (tx) => {
        const rows = await tx`
          UPDATE groups SET name = ${clean}
          WHERE id = ${id} AND workspace_id = ${this.workspaceId}`;
        if (!rows.count) return false;
        await inTx?.(tx);
        return true;
      })
      .catch(explain);
  }

  /** Deletes the group, its sub-groups, their memberships and grants. */
  async deleteGroup(id: string, inTx?: (tx: Tx) => Promise<unknown>) {
    if (!isUuid(id)) return false;
    return this.sql.begin(async (tx) => {
      const rows = await tx`
        DELETE FROM groups WHERE id = ${id} AND workspace_id = ${this.workspaceId}`;
      if (!rows.count) return false;
      await inTx?.(tx);
      return true;
    });
  }

  async setMember(groupId: string, userId: string, member: boolean, inTx?: (tx: Tx) => Promise<unknown>) {
    if (!isUuid(groupId) || !isUuid(userId)) return false;
    return this.sql
      .begin(async (tx) => {
        const [group] = await tx`
          SELECT 1 FROM groups WHERE id = ${groupId} AND workspace_id = ${this.workspaceId}`;
        if (!group) return false;
        const rows = member
          ? await tx`
              INSERT INTO group_members (group_id, user_id) VALUES (${groupId}, ${userId})
              ON CONFLICT DO NOTHING`
          : await tx`
              DELETE FROM group_members WHERE group_id = ${groupId} AND user_id = ${userId}`;
        if (rows.count) await inTx?.(tx);
        return true;
      })
      .catch(explain);
  }

  /** Grants on one node (null = workspace), or on every node when `nodeId` is undefined. */
  async grants(nodeId?: string | null): Promise<Grant[]> {
    if (nodeId && !isUuid(nodeId)) return [];
    const rows = await this.sql<
      {
        id: string;
        node_id: string | null;
        principal_type: "user" | "group";
        principal_id: string;
        role: Role;
        created_at: Date;
      }[]
    >`
      SELECT id, node_id, principal_type, principal_id, role, created_at FROM grants
      WHERE workspace_id = ${this.workspaceId}
        ${nodeId === undefined ? this.sql`` : nodeId === null ? this.sql`AND node_id IS NULL` : this.sql`AND node_id = ${nodeId}`}
      ORDER BY created_at`;
    return rows.map((r) => ({
      id: r.id,
      nodeId: r.node_id,
      principalType: r.principal_type,
      principalId: r.principal_id,
      role: r.role,
      createdAt: r.created_at.toISOString(),
    }));
  }

  /** Gives a user or group a role on a node (null = workspace); replaces their earlier role there. */
  async setGrant(
    nodeId: string | null,
    principalType: "user" | "group",
    principalId: string,
    role: Role,
    createdBy: string,
    inTx?: (tx: Tx) => Promise<unknown>,
  ): Promise<string> {
    if (!ROLES.includes(role)) throw new AccessError("Role must be viewer, editor or owner");
    if (!isUuid(principalId)) throw new AccessError("Unknown user or group");
    return this.sql
      .begin(async (tx) => {
        const [exists] =
          principalType === "user"
            ? await tx`SELECT 1 FROM users WHERE id = ${principalId}`
            : await tx`SELECT 1 FROM groups WHERE id = ${principalId} AND workspace_id = ${this.workspaceId}`;
        if (!exists) throw new AccessError(`Unknown ${principalType}`);
        await this.keepAnOwner(tx, { nodeId, principalType, principalId, role });
        const [row] = await tx<{ id: string }[]>`
          INSERT INTO grants (workspace_id, node_id, principal_type, principal_id, role, created_by)
          VALUES (${this.workspaceId}, ${nodeId}, ${principalType}, ${principalId}, ${role}, ${createdBy})
          ON CONFLICT (workspace_id, node_id, principal_type, principal_id)
          DO UPDATE SET role = EXCLUDED.role
          RETURNING id`;
        await inTx?.(tx);
        return row.id;
      })
      .catch(explain);
  }

  async revoke(id: string, inTx?: (tx: Tx) => Promise<unknown>): Promise<boolean> {
    if (!isUuid(id)) return false;
    return this.sql.begin(async (tx) => {
      const [grant] = await tx<
        { node_id: string | null; principal_type: "user" | "group"; principal_id: string }[]
      >`
        SELECT node_id, principal_type, principal_id FROM grants
        WHERE id = ${id} AND workspace_id = ${this.workspaceId}`;
      if (!grant) return false;
      await this.keepAnOwner(tx, {
        nodeId: grant.node_id,
        principalType: grant.principal_type,
        principalId: grant.principal_id,
        role: null,
      });
      await tx`DELETE FROM grants WHERE id = ${id}`;
      await inTx?.(tx);
      return true;
    });
  }

  /** Refuses a change that would leave the workspace without a user who owns it. */
  private async keepAnOwner(
    tx: Tx,
    change: { nodeId: string | null; principalType: string; principalId: string; role: Role | null },
  ) {
    if (change.nodeId !== null || change.role === "owner") return;
    await tx`SELECT pg_advisory_xact_lock(hashtext('knowledge-chatroom:first-owner'))`;
    // Once people sign in, the local user can't, so it doesn't count as an owner.
    const local = await this.localUserId();
    const changingLocal = change.principalType === "user" && change.principalId === local;
    const [other] = await tx`
      SELECT 1 FROM grants
      WHERE workspace_id = ${this.workspaceId} AND node_id IS NULL AND role = 'owner'
        AND principal_type = 'user'
        AND NOT (principal_type = ${change.principalType} AND principal_id = ${change.principalId})
        AND (${changingLocal} OR principal_id <> ${local})`;
    if (!other) {
      throw new AccessError("The workspace needs at least one owner; make someone else owner first");
    }
  }

  audit(tx: Tx, principal: Principal, action: string, target: Record<string, unknown>) {
    return tx`
      INSERT INTO audit_log (workspace_id, actor_type, actor_id, action, target)
      VALUES (${this.workspaceId}, ${principal.actor}, ${principal.userId}, ${action},
              ${tx.json(target as never)})`;
  }

  async auditLog(limit = 100): Promise<AuditEntry[]> {
    const rows = await this.sql<
      {
        id: string;
        actor_type: "user" | "agent";
        actor_id: string | null;
        action: string;
        target: Record<string, unknown>;
        at: Date;
      }[]
    >`
      SELECT id, actor_type, actor_id, action, target, at FROM audit_log
      WHERE workspace_id = ${this.workspaceId}
      ORDER BY at DESC, id DESC LIMIT ${Math.min(Math.max(limit, 1), 1000)}`;
    return rows.map((r) => ({
      id: String(r.id),
      actorType: r.actor_type,
      actorId: r.actor_id,
      action: r.action,
      target: r.target,
      at: r.at.toISOString(),
    }));
  }
}
