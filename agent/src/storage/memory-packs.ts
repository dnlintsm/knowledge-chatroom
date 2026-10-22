import { createHash } from "node:crypto";

import { strToU8 } from "fflate";

import { scanSkill, type ScanFlag } from "../skills/scan";
import type { Sql } from "./db";
import {
  MemoryConflictError,
  MemoryError,
  MemoryNotFoundError,
  toMarkdown,
  validName,
  type MemoryType,
} from "./memory";
import { SHARED_SCOPES, type SharedScope } from "./shared-memory";

/**
 * Memory packs (issue #93, step 4; migrations/021_memory_packs.sql): a place's
 * shared notes published to the hub as immutable, numbered versions, for any
 * workspace on the deployment to install, the way skills are (../skills/hub.ts).
 *
 * - Publishing takes the place's own shared notes (not ones from other packs);
 *   whoever publishes a name first owns it, and only they add versions.
 *   Unchanged notes add no version. Each version is scanned like a skill.
 * - Installing pins a version in a place you edit: its notes become that
 *   place's shared notes, read-only, and Manual for everyone, so nobody's
 *   chats change until someone turns them on. Updating to another version
 *   keeps each note's modes; uninstalling removes the notes.
 * - Forking turns an install's notes into the place's own, editable ones.
 * - Hub admins (HUB_ADMINS, or the local user without login) verify
 *   versions; the publisher or an admin yanks one, after which it can't be
 *   newly installed.
 */

export interface PackNote {
  name: string;
  description: string;
  type: MemoryType;
  body: string;
}

export interface PackVersion {
  version: number;
  description: string;
  notes: number;
  flags: ScanFlag[];
  publishedBy: string | null;
  publishedAt: string;
  verified: boolean;
  yanked: boolean;
  yankReason: string | null;
}

export interface PackListing {
  name: string;
  owner: string | null;
  mine: boolean;
  /** The newest version that isn't yanked; null when all are. */
  latest: PackVersion | null;
  updatedAt: string;
}

export interface PackDetail extends PackListing {
  versions: PackVersion[];
  /** The asked-for version (else the latest) and its notes. */
  version: PackVersion;
  notes: PackNote[];
  isAdmin: boolean;
}

/** A pack installed in a place the user reads. */
export interface PackInstall {
  id: string;
  name: string;
  version: number;
  /** A newer version that isn't yanked, if any. */
  latest: number | null;
  place: { scope: SharedScope; nodeId: string | null; groupId: string | null; label: string };
  canEdit: boolean;
  notes: number;
  installedAt: string;
}

export const MAX_PACK_NOTES = 100;

const UUID = /^[0-9a-f-]{36}$/i;

/** HUB_ADMINS: emails or login subjects, separated by commas or spaces. */
function parseAdmins(value: string | undefined) {
  return new Set(
    (value ?? "")
      .split(/[\s,]+/)
      .map((v) => v.trim().toLowerCase())
      .filter(Boolean),
  );
}

interface VersionRow {
  id: string;
  pack_id: string;
  version: number;
  description: string;
  notes: PackNote[];
  flags: ScanFlag[];
  published_by: string | null;
  published_at: Date;
  verified_at: Date | null;
  yanked_at: Date | null;
  yank_reason: string | null;
}

const toVersion = (r: VersionRow): PackVersion => ({
  version: r.version,
  description: r.description,
  notes: r.notes.length,
  flags: r.flags,
  publishedBy: r.published_by,
  publishedAt: r.published_at.toISOString(),
  verified: r.verified_at !== null,
  yanked: r.yanked_at !== null,
  yankReason: r.yank_reason,
});

/** The notes as files, for the skills' scan. */
const scanNotes = (notes: PackNote[]) =>
  scanSkill(notes.map((n) => ({ path: `${n.name}.md`, bytes: strToU8(toMarkdown(n)) })));

type Place = { scope: SharedScope; nodeId: string | null; groupId: string | null };

export class MemoryPackHub {
  private readonly admins: Set<string>;

  constructor(
    private readonly sql: Sql,
    private readonly workspaceId: string,
    options: { admins?: string } = {},
  ) {
    this.admins = parseAdmins(options.admins ?? process.env.HUB_ADMINS);
  }

  private async isAdmin(userId: string): Promise<boolean> {
    const [user] = await this.sql<{ subject: string; email: string | null }[]>`
      SELECT subject, email FROM users WHERE id = ${userId}`;
    if (!user) return false;
    return user.subject === "local" || this.admins.has(user.subject.toLowerCase()) ||
      (!!user.email && this.admins.has(user.email.toLowerCase()));
  }

  private place(input: { scope?: unknown; nodeId?: unknown; groupId?: unknown }): Place {
    const scope = input.scope as SharedScope;
    if (!SHARED_SCOPES.includes(scope)) throw new MemoryError("scope is workspace, node or group");
    const nodeId = scope === "node" ? input.nodeId : null;
    const groupId = scope === "group" ? input.groupId : null;
    if (scope === "node" && (typeof nodeId !== "string" || !UUID.test(nodeId))) throw new MemoryError("Say which node: nodeId");
    if (scope === "group" && (typeof groupId !== "string" || !UUID.test(groupId))) throw new MemoryError("Say which group: groupId");
    return { scope, nodeId: nodeId as string | null, groupId: groupId as string | null };
  }

  private async rank(db: Sql, userId: string, place: Place): Promise<number> {
    const [{ rank }] = await db<{ rank: number }[]>`
      SELECT shared_memory_rank(${this.workspaceId}, ${userId}, ${place.scope}, ${place.nodeId}::uuid, ${place.groupId}::uuid) AS rank`;
    return rank;
  }

  private async versions(packId: string): Promise<VersionRow[]> {
    return this.sql<VersionRow[]>`
      SELECT v.id, v.pack_id, v.version, v.description, v.notes, v.flags, v.published_at, v.verified_at,
        v.yanked_at, v.yank_reason, (SELECT coalesce(u.name, u.email) FROM users u WHERE u.id = v.published_by) AS published_by
      FROM hub_memory_pack_versions v WHERE v.pack_id = ${packId} ORDER BY v.version DESC`;
  }

  /** The hub's packs, newest first; `query` matches names and descriptions. */
  async list(userId: string, query = ""): Promise<{ packs: PackListing[]; isAdmin: boolean }> {
    const rows = await this.sql<{ id: string; name: string; owner_id: string; owner: string | null; updated_at: Date }[]>`
      SELECT p.id, p.name, p.owner_id, p.updated_at, (SELECT coalesce(u.name, u.email) FROM users u WHERE u.id = p.owner_id) AS owner
      FROM hub_memory_packs p ORDER BY p.updated_at DESC, p.name LIMIT 200`;
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const packs: PackListing[] = [];
    for (const row of rows) {
      const latest = (await this.versions(row.id)).find((v) => !v.yanked_at) ?? null;
      const text = `${row.name} ${latest?.description ?? ""}`.toLowerCase();
      if (words.some((w) => !text.includes(w))) continue;
      packs.push({
        name: row.name,
        owner: row.owner,
        mine: row.owner_id === userId,
        latest: latest && toVersion(latest),
        updatedAt: row.updated_at.toISOString(),
      });
    }
    return { packs, isAdmin: await this.isAdmin(userId) };
  }

  async detail(userId: string, name: string, version?: number): Promise<PackDetail> {
    const [pack] = await this.sql<{ id: string; name: string; owner_id: string; owner: string | null; updated_at: Date }[]>`
      SELECT p.id, p.name, p.owner_id, p.updated_at, (SELECT coalesce(u.name, u.email) FROM users u WHERE u.id = p.owner_id) AS owner
      FROM hub_memory_packs p WHERE p.name = ${name}`;
    if (!pack) throw new MemoryNotFoundError(`pack ${name}`);
    const versions = await this.versions(pack.id);
    const latest = versions.find((v) => !v.yanked_at) ?? null;
    const chosen = version === undefined ? (latest ?? versions[0]) : versions.find((v) => v.version === version);
    if (!chosen) throw new MemoryNotFoundError(`pack ${name} version ${version}`);
    return {
      name: pack.name,
      owner: pack.owner,
      mine: pack.owner_id === userId,
      latest: latest && toVersion(latest),
      updatedAt: pack.updated_at.toISOString(),
      versions: versions.map(toVersion),
      version: toVersion(chosen),
      notes: chosen.notes,
      isAdmin: await this.isAdmin(userId),
    };
  }

  /**
   * Publishes a place's own shared notes as the next version of the pack
   * `name` (creating it, owned by this user, if it's new).
   */
  async publish(
    userId: string,
    target: { scope?: unknown; nodeId?: unknown; groupId?: unknown },
    name: unknown,
    description: unknown,
  ): Promise<{ name: string; version: number; unchanged: boolean }> {
    if (!validName(name)) throw new MemoryError("A pack's name is lowercase letters, digits and dashes, at most 64");
    const about = typeof description === "string" ? description.replace(/\s+/g, " ").trim() : "";
    if (!about || about.length > 300) throw new MemoryError("A pack needs a one-line description, at most 300 characters");
    const place = this.place(target);
    return this.sql.begin(async (tx) => {
      const db = tx as unknown as Sql;
      if ((await this.rank(db, userId, place)) < 2) throw new MemoryError("Only the place's editors publish its notes");
      const notes = await db<PackNote[]>`
        SELECT name, description, type, body FROM shared_memories
        WHERE workspace_id = ${this.workspaceId} AND scope = ${place.scope} AND pack_install_id IS NULL
          AND node_id IS NOT DISTINCT FROM ${place.nodeId}::uuid AND group_id IS NOT DISTINCT FROM ${place.groupId}::uuid
        ORDER BY name`;
      if (!notes.length) throw new MemoryError("That place has no notes of its own to publish");
      if (notes.length > MAX_PACK_NOTES) throw new MemoryError(`A pack has at most ${MAX_PACK_NOTES} notes`);
      const fingerprint = createHash("sha256").update(JSON.stringify([about, notes])).digest("hex");
      await db`INSERT INTO hub_memory_packs (name, owner_id) VALUES (${name}, ${userId}) ON CONFLICT (name) DO NOTHING`;
      const [pack] = await db<{ id: string; owner_id: string }[]>`
        SELECT id, owner_id FROM hub_memory_packs WHERE name = ${name} FOR UPDATE`;
      if (pack.owner_id !== userId) throw new MemoryConflictError(`The pack ${name} on the hub was published by someone else`);
      const [latest] = await db<{ version: number; fingerprint: string }[]>`
        SELECT version, fingerprint FROM hub_memory_pack_versions WHERE pack_id = ${pack.id} ORDER BY version DESC LIMIT 1`;
      if (latest?.fingerprint === fingerprint) return { name, version: latest.version, unchanged: true };
      const version = (latest?.version ?? 0) + 1;
      await db`
        INSERT INTO hub_memory_pack_versions (pack_id, version, description, notes, fingerprint, flags, published_by)
        VALUES (${pack.id}, ${version}, ${about}, ${db.json(notes as never)}, ${fingerprint},
                ${db.json(scanNotes(notes) as never)}, ${userId})`;
      await db`UPDATE hub_memory_packs SET updated_at = now() WHERE id = ${pack.id}`;
      return { name, version, unchanged: false };
    }) as Promise<{ name: string; version: number; unchanged: boolean }>;
  }

  /**
   * Installs a pack in a place (or moves its install there to `version`, by
   * default the newest that isn't yanked). Notes it adds are Manual for
   * everyone; notes it keeps keep their modes.
   */
  async install(
    userId: string,
    target: { scope?: unknown; nodeId?: unknown; groupId?: unknown },
    name: unknown,
    version?: number,
  ): Promise<PackInstall> {
    if (!validName(name)) throw new MemoryError("Say which pack: name");
    const place = this.place(target);
    const id = await this.sql.begin(async (tx) => {
      const db = tx as unknown as Sql;
      if ((await this.rank(db, userId, place)) < 2) throw new MemoryError("Installing a memory pack needs edit access to the place");
      const [pack] = await db<{ id: string }[]>`SELECT id FROM hub_memory_packs WHERE name = ${name}`;
      if (!pack) throw new MemoryNotFoundError(`pack ${name}`);
      const [chosen] = await db<VersionRow[]>`
        SELECT * FROM hub_memory_pack_versions WHERE pack_id = ${pack.id}
          AND ${version === undefined ? db`yanked_at IS NULL` : db`version = ${version}`}
        ORDER BY version DESC LIMIT 1`;
      if (!chosen) throw new MemoryNotFoundError(`pack ${name}${version === undefined ? "" : ` version ${version}`}`);
      const samePlace = db`workspace_id = ${this.workspaceId} AND scope = ${place.scope}
        AND node_id IS NOT DISTINCT FROM ${place.nodeId}::uuid AND group_id IS NOT DISTINCT FROM ${place.groupId}::uuid`;
      const [current] = await db<{ id: string; version_id: string }[]>`
        SELECT id, version_id FROM memory_pack_installs WHERE ${samePlace} AND pack_id = ${pack.id} FOR UPDATE`;
      if (chosen.yanked_at && current?.version_id !== chosen.id) {
        throw new MemoryError(`Version ${chosen.version} of ${name} was yanked${chosen.yank_reason ? `: ${chosen.yank_reason}` : ""}`);
      }
      const taken = await db<{ name: string }[]>`
        SELECT name FROM shared_memories
        WHERE ${samePlace} AND name = ANY(${chosen.notes.map((n) => n.name)}::text[])
          ${current ? db`AND (pack_install_id IS NULL OR pack_install_id <> ${current.id})` : db``}`;
      if (taken.length) {
        throw new MemoryConflictError(`The place already has notes named ${taken.map((t) => t.name).join(", ")}; rename them first`);
      }
      let installId: string;
      if (current) {
        installId = current.id;
        await db`UPDATE memory_pack_installs SET version_id = ${chosen.id}, installed_by = ${userId}, installed_at = now() WHERE id = ${installId}`;
      } else {
        [{ id: installId }] = await db<{ id: string }[]>`
          INSERT INTO memory_pack_installs (workspace_id, scope, node_id, group_id, pack_id, version_id, installed_by)
          VALUES (${this.workspaceId}, ${place.scope}, ${place.nodeId}, ${place.groupId}, ${pack.id}, ${chosen.id}, ${userId})
          RETURNING id`;
      }
      const existing = new Map(
        (await db<{ id: string; name: string; description: string; type: string; body: string }[]>`
          SELECT id, name, description, type, body FROM shared_memories WHERE pack_install_id = ${installId}`).map((r) => [r.name, r]),
      );
      for (const note of chosen.notes) {
        const had = existing.get(note.name);
        existing.delete(note.name);
        if (had && had.description === note.description && had.type === note.type && had.body === note.body) continue;
        let memoryId: string;
        let next: number;
        if (had) {
          [{ id: memoryId, version: next }] = await db<{ id: string; version: number }[]>`
            UPDATE shared_memories SET description = ${note.description}, type = ${note.type}, body = ${note.body},
              version = version + 1, updated_by = ${userId}, updated_at = now()
            WHERE id = ${had.id} RETURNING id, version`;
        } else {
          [{ id: memoryId, version: next }] = await db<{ id: string; version: number }[]>`
            INSERT INTO shared_memories (workspace_id, scope, node_id, group_id, name, description, type, body,
                                         created_by, updated_by, pack_install_id)
            VALUES (${this.workspaceId}, ${place.scope}, ${place.nodeId}, ${place.groupId}, ${note.name},
                    ${note.description}, ${note.type}, ${note.body}, ${userId}, ${userId}, ${installId})
            RETURNING id, version`;
          await db`INSERT INTO shared_memory_settings (memory_id, user_id, mode) VALUES (${memoryId}, NULL, 'manual')`;
        }
        await db`
          INSERT INTO shared_memory_versions (memory_id, version, description, type, body, changed_by, changed_as)
          VALUES (${memoryId}, ${next}, ${note.description}, ${note.type}, ${note.body}, ${userId}, 'user')`;
      }
      // Notes the version no longer has.
      for (const gone of existing.values()) await db`DELETE FROM shared_memories WHERE id = ${gone.id}`;
      return installId;
    });
    return (await this.installs(userId)).find((i) => i.id === id)!;
  }

  /** Installed packs in places the user reads. */
  async installs(userId: string): Promise<PackInstall[]> {
    const rows = await this.sql<{
      id: string; name: string; version: number; latest: number | null; scope: SharedScope; node_id: string | null;
      group_id: string | null; label: string | null; rank: number; notes: number; installed_at: Date;
    }[]>`
      SELECT * FROM (
        SELECT i.id, p.name, v.version, i.scope, i.node_id, i.group_id, i.installed_at,
          (SELECT max(l.version) FROM hub_memory_pack_versions l
           WHERE l.pack_id = p.id AND l.yanked_at IS NULL AND l.version > v.version) AS latest,
          coalesce((SELECT n.name FROM nodes n WHERE n.id = i.node_id), (SELECT g.name FROM groups g WHERE g.id = i.group_id)) AS label,
          shared_memory_rank(i.workspace_id, ${userId}, i.scope, i.node_id, i.group_id) AS rank,
          (SELECT count(*)::int FROM shared_memories m WHERE m.pack_install_id = i.id) AS notes
        FROM memory_pack_installs i
        JOIN hub_memory_packs p ON p.id = i.pack_id
        JOIN hub_memory_pack_versions v ON v.id = i.version_id
        WHERE i.workspace_id = ${this.workspaceId}
      ) r WHERE r.rank >= 1
      ORDER BY r.name`;
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      version: r.version,
      latest: r.latest,
      place: {
        scope: r.scope,
        nodeId: r.node_id,
        groupId: r.group_id,
        label: r.scope === "workspace" ? "Workspace" : (r.label ?? (r.scope === "node" ? "A node" : "A group")),
      },
      canEdit: r.rank >= 2,
      notes: r.notes,
      installedAt: r.installed_at.toISOString(),
    }));
  }

  private async editableInstall(db: Sql, userId: string, id: string) {
    if (!UUID.test(id)) throw new MemoryNotFoundError("pack install");
    const [row] = await db<{ id: string; scope: SharedScope; node_id: string | null; group_id: string | null }[]>`
      SELECT id, scope, node_id, group_id FROM memory_pack_installs
      WHERE id = ${id} AND workspace_id = ${this.workspaceId} FOR UPDATE`;
    if (!row) throw new MemoryNotFoundError("pack install");
    if ((await this.rank(db, userId, { scope: row.scope, nodeId: row.node_id, groupId: row.group_id })) < 2) {
      throw new MemoryError("Only the place's editors change its packs");
    }
    return row;
  }

  /** Removes an install and its notes. */
  async uninstall(userId: string, id: string): Promise<void> {
    await this.sql.begin(async (tx) => {
      const db = tx as unknown as Sql;
      await this.editableInstall(db, userId, id);
      await db`DELETE FROM memory_pack_installs WHERE id = ${id}`;
    });
  }

  /** Makes an install's notes the place's own (editable) and drops the install. */
  async fork(userId: string, id: string): Promise<{ notes: number }> {
    return this.sql.begin(async (tx) => {
      const db = tx as unknown as Sql;
      await this.editableInstall(db, userId, id);
      const kept = await db`UPDATE shared_memories SET pack_install_id = NULL WHERE pack_install_id = ${id}`;
      await db`DELETE FROM memory_pack_installs WHERE id = ${id}`;
      return { notes: kept.count };
    }) as Promise<{ notes: number }>;
  }

  /** Marks a version checked (hub admins) or not. */
  async verify(userId: string, name: string, version: number, verified: boolean): Promise<void> {
    if (!(await this.isAdmin(userId))) throw new MemoryError("Only hub admins verify packs");
    const done = await this.sql`
      UPDATE hub_memory_pack_versions v SET
        verified_at = ${verified ? this.sql`now()` : null}, verified_by = ${verified ? userId : null}
      FROM hub_memory_packs p WHERE p.id = v.pack_id AND p.name = ${name} AND v.version = ${version}`;
    if (!done.count) throw new MemoryNotFoundError(`pack ${name} version ${version}`);
  }

  /** Yanks a version (its publisher or a hub admin), or takes the yank back. */
  async yank(userId: string, name: string, version: number, yanked: boolean, reason?: unknown): Promise<void> {
    const [pack] = await this.sql<{ id: string; owner_id: string }[]>`SELECT id, owner_id FROM hub_memory_packs WHERE name = ${name}`;
    if (!pack) throw new MemoryNotFoundError(`pack ${name}`);
    if (pack.owner_id !== userId && !(await this.isAdmin(userId))) throw new MemoryError("Only its publisher or a hub admin yanks a version");
    const why = typeof reason === "string" ? reason.trim().slice(0, 500) || null : null;
    const done = await this.sql`
      UPDATE hub_memory_pack_versions SET
        yanked_at = ${yanked ? this.sql`now()` : null}, yanked_by = ${yanked ? userId : null}, yank_reason = ${yanked ? why : null}
      WHERE pack_id = ${pack.id} AND version = ${version}`;
    if (!done.count) throw new MemoryNotFoundError(`pack ${name} version ${version}`);
  }
}
