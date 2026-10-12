import type { Storage } from "../storage";
import { atLeast, type Role } from "../storage/access";
import {
  builtinSkills,
  chosenMode,
  describe,
  effectiveMode,
  mergeSkills,
  SKILL_MODES,
  workspaceSkills,
  skillFromFiles,
  type Skill,
  type ModeLayers,
  type SkillInfo,
  type SkillMode,
  type SkillSource,
} from "./catalog";

/** A skill with the mode that applies to this user. */
export interface UserSkill {
  skill: Skill;
  mode: SkillMode;
}

/** A file of a published hub version: its bytes are the blob with that hash. */
export interface HubFile {
  path: string;
  sha256: string;
  size: number;
}

export class UnknownSkillError extends Error {}
export class InvalidModeError extends Error {}
/** Setting the workspace's default needs editor access at the root. */
export class SkillForbiddenError extends Error {}

export type SkillTrigger = "slash" | "model";

/** Which level a mode is set at; see ModeLayers. */
export type ModeScope = "workspace" | "user" | "chat";
export const MODE_SCOPES: readonly ModeScope[] = ["workspace", "user", "chat"];

export interface SkillList {
  skills: SkillInfo[];
  /**
   * Whether this user may set the workspace's defaults, and add skills to it
   * (install from the hub, fork, import): editor or owner at the root.
   */
  canSetDefaults: boolean;
  /** Whether this user may publish the workspace's skills to the hub: owner at the root. */
  canPublish: boolean;
  /** Whether there is a hub (it needs server storage). */
  hub: boolean;
}

/**
 * Skills per user: which exist for them (built-in, installed from the hub,
 * and the workspace's own; the latter two if they can read the workspace
 * root) and the mode each is in, chosen at up to three levels: for
 * everyone (by an editor of the workspace root), by the user, and by the user
 * for one chat; the most specific applies. With storage these live in
 * Postgres (009_skills.sql, 010_skill_scopes.sql); without it there is only
 * the local user, whose choices are kept in memory and whose skills are the
 * built-in ones.
 */
export class SkillService {
  private readonly local = {
    workspace: new Map<string, SkillMode>(),
    user: new Map<string, SkillMode>(),
    chat: new Map<string, Map<string, SkillMode>>(),
  };
  /** Skill file bytes by content hash, so runs don't fetch unchanged files again. */
  private readonly blobCache = new Map<string, Uint8Array>();

  constructor(
    private readonly storage: () => Storage | null,
    private readonly builtins: () => Skill[] = builtinSkills,
  ) {}

  /** Every skill the user can see, with its modes (with `threadId`, that chat's too). */
  async list(userId: string | null, threadId?: string): Promise<SkillList> {
    const [skills, layers, role] = await Promise.all([
      this.skills(userId),
      this.layers(userId, threadId),
      this.rootRole(userId),
    ]);
    return {
      skills: skills.map((skill) => describe(skill, layers.get(skill.name))),
      canSetDefaults: atLeast(role, "editor"),
      canPublish: atLeast(role, "owner"),
      hub: this.storage() !== null,
    };
  }

  /** The skills a run for this user (in this chat) gets: everything not off, with its mode. */
  async forRun(userId: string | null, threadId?: string): Promise<UserSkill[]> {
    const [skills, layers] = await Promise.all([this.skills(userId), this.layers(userId, threadId)]);
    return skills
      .map((skill) => ({ skill, mode: effectiveMode(skill, chosenMode(layers.get(skill.name))) }))
      .filter(({ mode }) => mode !== "off");
  }

  /**
   * Sets a skill's mode at one level; null clears it there, so the level
   * above applies again. Returns the skill as this user (in that chat) sees it.
   */
  async setMode(
    userId: string | null,
    name: string,
    mode: unknown,
    scope: unknown = "user",
    threadId?: string,
  ): Promise<SkillInfo> {
    if (mode !== null && (typeof mode !== "string" || !SKILL_MODES.includes(mode as SkillMode))) {
      throw new InvalidModeError(`mode must be one of ${SKILL_MODES.join(", ")}, or null to clear it`);
    }
    if (typeof scope !== "string" || !MODE_SCOPES.includes(scope as ModeScope)) {
      throw new InvalidModeError(`scope must be one of ${MODE_SCOPES.join(", ")}`);
    }
    if (scope === "chat" && !(threadId && threadId.length <= 200)) {
      throw new InvalidModeError("A chat's mode needs its thread");
    }
    const skill = (await this.skills(userId)).find((s) => s.name === name);
    if (!skill) throw new UnknownSkillError(`No skill named ${name}`);
    if (scope === "workspace" && !(await this.canSetDefaults(userId))) {
      throw new SkillForbiddenError("Only editors of the workspace can set its defaults");
    }

    const storage = this.storage();
    const value = mode as SkillMode | null;
    if (storage && userId) {
      const ws = storage.workspaceId;
      if (scope === "chat") {
        await (value === null
          ? storage.sql`
              DELETE FROM chat_skill_settings
              WHERE workspace_id = ${ws} AND user_id = ${userId} AND thread_id = ${threadId!} AND skill = ${name}`
          : storage.sql`
              INSERT INTO chat_skill_settings (workspace_id, user_id, thread_id, skill, mode)
              VALUES (${ws}, ${userId}, ${threadId!}, ${name}, ${value})
              ON CONFLICT (workspace_id, user_id, thread_id, skill)
              DO UPDATE SET mode = EXCLUDED.mode, updated_at = now()`);
      } else {
        const owner = scope === "workspace" ? null : userId;
        await (value === null
          ? storage.sql`
              DELETE FROM skill_settings
              WHERE workspace_id = ${ws} AND user_id IS NOT DISTINCT FROM ${owner} AND skill = ${name}`
          : storage.sql`
              INSERT INTO skill_settings (workspace_id, user_id, skill, mode)
              VALUES (${ws}, ${owner}, ${name}, ${value})
              ON CONFLICT (workspace_id, user_id, skill)
              DO UPDATE SET mode = EXCLUDED.mode, updated_at = now()`);
      }
    } else {
      const map =
        scope === "chat"
          ? this.local.chat.get(threadId!) ?? this.local.chat.set(threadId!, new Map()).get(threadId!)!
          : this.local[scope as "workspace" | "user"];
      if (value === null) map.delete(name);
      else map.set(name, value);
    }
    const layers = await this.layers(userId, scope === "chat" ? threadId : undefined);
    return describe(skill, layers.get(name));
  }

  /** Notes that a turn used a skill; history for later (best effort, never fails a run). */
  async record(
    userId: string | null,
    use: { threadId: string; runId: string; skill: string; source: SkillSource; trigger: SkillTrigger },
  ): Promise<void> {
    const storage = this.storage();
    if (!storage || !userId) return;
    try {
      await storage.sql`
        INSERT INTO skill_invocations (workspace_id, user_id, thread_id, run_id, skill, source, trigger)
        VALUES (${storage.workspaceId}, ${userId}, ${use.threadId}, ${use.runId},
                ${use.skill}, ${use.source}, ${use.trigger})`;
    } catch (err) {
      console.warn(`[skills] couldn't record a skill use: ${err instanceof Error ? err.message : err}`);
    }
  }

  /** Each skill's choices at the three levels. */
  private async layers(userId: string | null, threadId?: string): Promise<Map<string, ModeLayers>> {
    const layers = new Map<string, ModeLayers>();
    const add = (skill: string, level: keyof ModeLayers, mode: SkillMode) =>
      layers.set(skill, { ...layers.get(skill), [level]: mode });
    const storage = this.storage();
    if (!storage || !userId) {
      for (const [skill, mode] of this.local.workspace) add(skill, "workspace", mode);
      for (const [skill, mode] of this.local.user) add(skill, "user", mode);
      for (const [skill, mode] of (threadId && this.local.chat.get(threadId)) || []) add(skill, "chat", mode);
      return layers;
    }
    const rows = await storage.sql<{ skill: string; mode: SkillMode; level: keyof ModeLayers }[]>`
      SELECT skill, mode, CASE WHEN user_id IS NULL THEN 'workspace' ELSE 'user' END AS level
      FROM skill_settings
      WHERE workspace_id = ${storage.workspaceId} AND (user_id IS NULL OR user_id = ${userId})
      UNION ALL
      SELECT skill, mode, 'chat' FROM chat_skill_settings
      WHERE workspace_id = ${storage.workspaceId} AND user_id = ${userId}
        AND thread_id = ${threadId ?? ""}`;
    for (const row of rows) add(row.skill, row.level, row.mode);
    return layers;
  }

  /** The skill named so, with its files, as this user sees it; null if there is none. */
  async find(userId: string | null, name: string): Promise<Skill | null> {
    return (await this.skills(userId)).find((s) => s.name === name) ?? null;
  }

  /** The user's role at the workspace root; without storage the local user owns everything. */
  async rootRole(userId: string | null): Promise<Role | null> {
    const storage = this.storage();
    if (!storage || !userId) return "owner";
    return storage.access.role(userId, null);
  }

  /** Editors and owners of the workspace root set its defaults; the local user always may. */
  private async canSetDefaults(userId: string | null): Promise<boolean> {
    return atLeast(await this.rootRole(userId), "editor");
  }

  /** A blob's bytes, from the cache when this server has read it before. */
  async blob(sha256: string): Promise<Uint8Array> {
    let bytes = this.blobCache.get(sha256);
    if (!bytes) {
      bytes = await this.storage()!.blobs.get(sha256);
      this.remember(sha256, bytes);
    }
    return bytes;
  }

  private async skills(userId: string | null): Promise<Skill[]> {
    // A workspace skill hides an installed hub skill of the same name (e.g. its fork).
    const [hub, workspace] = await Promise.all([this.installed(userId), this.workspace(userId)]);
    return mergeSkills(this.builtins(), hub, workspace);
  }

  /** The hub skills installed in the workspace, at their pinned versions. */
  private async installed(userId: string | null): Promise<Skill[]> {
    const storage = this.storage();
    if (!storage || !userId || !(await storage.access.role(userId, null))) return [];
    const rows = await storage.sql<{ name: string; version: number; latest: number; files: HubFile[] }[]>`
      SELECT h.name, v.version, v.files,
             (SELECT max(version) FROM hub_skill_versions WHERE hub_skill_id = h.id) AS latest
      FROM skill_installs i
      JOIN hub_skills h ON h.id = i.hub_skill_id
      JOIN hub_skill_versions v ON v.id = i.version_id
      WHERE i.workspace_id = ${storage.workspaceId}
      ORDER BY h.name`;
    const skills = await Promise.all(
      rows.map(async (row) => {
        const files = await Promise.all(
          row.files.map(async (f) => ({ path: f.path, bytes: await this.blob(f.sha256) })),
        );
        const skill = skillFromFiles(row.name, files, "hub", null);
        return skill ? ({ ...skill, name: row.name, hub: { version: row.version, latest: row.latest } } as Skill) : null;
      }),
    );
    return skills.filter((s): s is Skill => s !== null);
  }

  /** skills/<name>/... at the workspace root, as far as the user may read it. */
  private async workspace(userId: string | null): Promise<Skill[]> {
    const storage = this.storage();
    if (!storage || !userId) return [];
    let files;
    try {
      files = await storage.session({ userId, actor: "agent" }).files(null);
    } catch {
      return []; // No access to the workspace root: no workspace skills.
    }
    const infos = (await files.list()).filter(
      (f) => f.path.startsWith("skills/") && f.size <= 1024 * 1024,
    );
    const read = await Promise.all(
      infos.map(async (info) => {
        let bytes = this.blobCache.get(info.sha256);
        if (!bytes) {
          bytes = (await files.read(info.path))?.bytes;
          if (!bytes) return null;
          this.remember(info.sha256, bytes);
        }
        return { path: info.path, bytes };
      }),
    );
    return workspaceSkills(read.filter((f): f is { path: string; bytes: Uint8Array } => f !== null));
  }

  private remember(sha256: string, bytes: Uint8Array) {
    if (this.blobCache.size >= 500) {
      this.blobCache.delete(this.blobCache.keys().next().value as string);
    }
    this.blobCache.set(sha256, bytes);
  }
}
