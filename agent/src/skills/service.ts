import type { Storage } from "../storage";
import {
  builtinSkills,
  describe,
  effectiveMode,
  mergeSkills,
  SKILL_MODES,
  workspaceSkills,
  type Skill,
  type SkillInfo,
  type SkillMode,
  type SkillSource,
} from "./catalog";

/** A skill with the mode that applies to this user. */
export interface UserSkill {
  skill: Skill;
  mode: SkillMode;
}

export class UnknownSkillError extends Error {}
export class InvalidModeError extends Error {}

export type SkillTrigger = "slash" | "model";

/**
 * Skills per user: which exist for them (built-in + the workspace's skills
 * they can read) and the mode each is in. With storage, modes and usage live
 * in Postgres (009_skills.sql); without it there is only the local user, whose
 * modes are kept in memory and whose skills are the built-in ones.
 */
export class SkillService {
  private readonly localModes = new Map<string, SkillMode>();
  /** Skill file bytes by content hash, so runs don't fetch unchanged files again. */
  private readonly blobCache = new Map<string, Uint8Array>();

  constructor(
    private readonly storage: () => Storage | null,
    private readonly builtins: () => Skill[] = builtinSkills,
  ) {}

  /** Every skill the user can see, with its mode. */
  async list(userId: string | null): Promise<SkillInfo[]> {
    const [skills, modes] = await Promise.all([this.skills(userId), this.modes(userId)]);
    return skills.map((skill) => describe(skill, modes.get(skill.name)));
  }

  /** The skills a run for this user gets: everything not off, with its mode. */
  async forRun(userId: string | null): Promise<UserSkill[]> {
    const [skills, modes] = await Promise.all([this.skills(userId), this.modes(userId)]);
    return skills
      .map((skill) => ({ skill, mode: effectiveMode(skill, modes.get(skill.name)) }))
      .filter(({ mode }) => mode !== "off");
  }

  async setMode(userId: string | null, name: string, mode: unknown): Promise<SkillInfo> {
    if (typeof mode !== "string" || !SKILL_MODES.includes(mode as SkillMode)) {
      throw new InvalidModeError(`mode must be one of ${SKILL_MODES.join(", ")}`);
    }
    const skill = (await this.skills(userId)).find((s) => s.name === name);
    if (!skill) throw new UnknownSkillError(`No skill named ${name}`);
    const storage = this.storage();
    if (storage && userId) {
      await storage.sql`
        INSERT INTO skill_settings (workspace_id, user_id, skill, mode)
        VALUES (${storage.workspaceId}, ${userId}, ${name}, ${mode})
        ON CONFLICT (workspace_id, user_id, skill)
        DO UPDATE SET mode = EXCLUDED.mode, updated_at = now()`;
    } else {
      this.localModes.set(name, mode as SkillMode);
    }
    return describe(skill, mode as SkillMode);
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

  private async modes(userId: string | null): Promise<Map<string, SkillMode>> {
    const storage = this.storage();
    if (!storage || !userId) return this.localModes;
    const rows = await storage.sql<{ skill: string; mode: SkillMode }[]>`
      SELECT skill, mode FROM skill_settings
      WHERE workspace_id = ${storage.workspaceId} AND user_id = ${userId}`;
    return new Map(rows.map((r) => [r.skill, r.mode]));
  }

  private async skills(userId: string | null): Promise<Skill[]> {
    return mergeSkills(this.builtins(), await this.workspace(userId));
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
