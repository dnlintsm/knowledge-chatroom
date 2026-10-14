import { strToU8, unzipSync, zipSync } from "fflate";

import { atLeast, type Principal, type Role } from "../storage/access";
import { sha256Hex } from "../storage/blobs";
import type { Storage } from "../storage";
import { InvalidPathError, mimeForPath, normalizePath } from "../storage/paths";
import {
  MAX_SKILL_BYTES,
  MAX_SKILL_FILE_BYTES,
  SKILL_NAME,
  skillFromFiles,
  type Skill,
  type SkillFile,
} from "./catalog";
import { scanSkill, LARGE_FILE_BYTES, type ScanFlag } from "./scan";
import { SkillForbiddenError, type HubFile, type SkillService } from "./service";

/**
 * The skill hub (issue #7, step 3), one per deployment. Owners of the
 * workspace publish its skills as immutable, numbered versions (files kept
 * as blobs, so a version never changes); editors install one pinned to a
 * version, update it, or fork it into the workspace's skills/ to change it.
 * Skills also move in and out as .zip files in the standard Agent Skills
 * layout (<name>/SKILL.md + files), so they work with Claude Code too.
 *
 * Trust (step 4): each version is scanned when it's published (scan.ts);
 * hub admins (HUB_ADMINS, or the local user without login) verify versions
 * and handle reports; a publisher can yank a version, which can then no
 * longer be installed, though installs of it keep working.
 *
 * Everything here is the user's own doing over HTTP: Claude has no tools for
 * the hub, so a document can't talk it into installing a skill.
 */

/** The request is wrong (bad zip, wrong kind of skill...). */
export class HubError extends Error {}
export class HubNotFoundError extends Error {}
/** Something is in the way (a skill folder of that name...). */
export class HubConflictError extends Error {}

export interface HubManifest {
  description: string;
  argumentHint: string | null;
  modelInvocable: boolean;
  userInvocable: boolean;
  needsExecution: boolean;
}

export interface HubListing extends HubManifest {
  name: string;
  /** Who first published it (their name or email). */
  publisher: string | null;
  /** Whether you published it, and so may publish new versions. */
  mine: boolean;
  /** The newest version that isn't yanked (the newest of all if every one is). */
  latest: number;
  /** About `latest`: an admin verified it; it's yanked; how many scan flags it has. */
  verified: boolean;
  yanked: boolean;
  flags: number;
  updatedAt: string;
  /** The version installed in this workspace, or null. */
  installed: number | null;
  /** Open reports, for hub admins and the publisher; null for everyone else. */
  reports: number | null;
}

export interface HubVersion {
  version: number;
  publishedAt: string;
  publishedBy: string | null;
  files: number;
  size: number;
  needsExecution: boolean;
  verified: boolean;
  yanked: boolean;
  yankReason: string | null;
  flags: ScanFlag[];
}

export interface HubReport {
  id: string;
  version: number | null;
  reason: string;
  reporter: string | null;
  createdAt: string;
}

export interface HubDetail extends HubListing {
  versions: HubVersion[];
  /** The version shown, and its SKILL.md. */
  version: number;
  skillMd: string;
  /** You may verify versions and dismiss reports (a hub admin). */
  canModerate: boolean;
  /** You may yank versions (its publisher or a hub admin). */
  canYank: boolean;
  /** Open reports, for hub admins and the publisher; null for everyone else. */
  openReports: HubReport[] | null;
}

export interface HubList {
  skills: HubListing[];
  canInstall: boolean;
  canPublish: boolean;
  /** You are a hub admin. */
  isAdmin: boolean;
}

export interface HubDiffFile {
  path: string;
  change: "added" | "removed" | "changed";
  /** The text on each side; null when there is no such side or it isn't text. */
  before: string | null;
  after: string | null;
  binary: boolean;
}

export interface HubDiff {
  name: string;
  from: number;
  to: number;
  files: HubDiffFile[];
  /** What the scan found in `to`. */
  flags: ScanFlag[];
}

/** Most files a skill (published or imported) may have. */
const MAX_FILES = 200;
/** Biggest .zip accepted for import. */
export const MAX_ZIP_BYTES = 10 * 1024 * 1024;

const manifestOf = (skill: Skill): HubManifest => ({
  description: skill.description,
  argumentHint: skill.argumentHint,
  modelInvocable: skill.modelInvocable,
  userInvocable: skill.userInvocable,
  needsExecution: skill.needsExecution,
});

interface ScannedRow {
  version_id: string;
  files: HubFile[];
  flags: ScanFlag[] | null;
}

interface ListingRow extends ScannedRow {
  id: string;
  name: string;
  owner_id: string;
  publisher: string | null;
  updated_at: Date;
  latest: number;
  verified: boolean;
  yanked: boolean;
  manifest: HubManifest;
  installed: number | null;
  reports: number;
}

/** HUB_ADMINS: emails or login subjects, separated by commas or spaces. */
function parseAdmins(value: string | undefined) {
  return new Set(
    (value ?? "")
      .split(/[\s,]+/)
      .map((v) => v.trim().toLowerCase())
      .filter(Boolean),
  );
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class SkillHub {
  private readonly admins: Set<string>;

  constructor(
    private readonly storage: () => Storage | null,
    private readonly skills: SkillService,
    options: { admins?: string } = {},
  ) {
    this.admins = parseAdmins(options.admins ?? process.env.HUB_ADMINS);
  }

  /** The hub's skills, newest first; `query` matches names and descriptions. */
  async list(userId: string | null, query = ""): Promise<HubList> {
    const { storage, role } = await this.open(userId, "viewer");
    const like = `%${query.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const rows = await this.listings(storage)`
      WHERE h.name ILIKE ${like} OR v.manifest->>'description' ILIKE ${like}
      ORDER BY h.updated_at DESC
      LIMIT 100`;
    await this.scanned(storage, rows);
    const admin = await this.isAdmin(storage, userId!);
    return {
      skills: rows.map((row) => this.listing(row, userId!, admin)),
      canInstall: atLeast(role, "editor"),
      canPublish: atLeast(role, "owner"),
      isAdmin: admin,
    };
  }

  /** One hub skill with its versions, showing `version` (default the latest). */
  async detail(userId: string | null, name: string, version?: number): Promise<HubDetail> {
    const { storage } = await this.open(userId, "viewer");
    const [row] = await this.listings(storage)`WHERE h.name = ${name}`;
    if (!row) throw new HubNotFoundError(`No skill named ${name} on the hub`);
    const versions = await storage.sql<
      (ScannedRow & {
        version: number;
        published_at: Date;
        published_by: string | null;
        manifest: HubManifest;
        verified: boolean;
        yanked: boolean;
        yank_reason: string | null;
      })[]
    >`
      SELECT v.id AS version_id, v.version, v.published_at, v.files, v.manifest, v.flags,
             v.verified_at IS NOT NULL AS verified, v.yanked_at IS NOT NULL AS yanked, v.yank_reason,
             coalesce(u.name, u.email) AS published_by
      FROM hub_skill_versions v LEFT JOIN users u ON u.id = v.published_by
      WHERE v.hub_skill_id = ${row.id}
      ORDER BY v.version DESC`;
    await this.scanned(storage, [row, ...versions]);
    const shown = versions.find((v) => v.version === (version ?? row.latest));
    if (!shown) throw new HubNotFoundError(`${name} has no version ${version}`);
    const main = shown.files.find((f) => f.path === "SKILL.md");
    const admin = await this.isAdmin(storage, userId!);
    const mine = row.owner_id === userId;
    let openReports: HubReport[] | null = null;
    if (admin || mine) {
      const reports = await storage.sql<
        { id: string; version: number | null; reason: string; reporter: string | null; created_at: Date }[]
      >`
        SELECT r.id, r.version, r.reason, r.created_at, coalesce(u.name, u.email) AS reporter
        FROM hub_skill_reports r LEFT JOIN users u ON u.id = r.reporter_id
        WHERE r.hub_skill_id = ${row.id} AND r.dismissed_at IS NULL
        ORDER BY r.created_at DESC`;
      openReports = reports.map((r) => ({
        id: r.id,
        version: r.version,
        reason: r.reason,
        reporter: r.reporter,
        createdAt: r.created_at.toISOString(),
      }));
    }
    return {
      ...this.listing(row, userId!, admin),
      versions: versions.map((v) => ({
        version: v.version,
        publishedAt: v.published_at.toISOString(),
        publishedBy: v.published_by,
        files: v.files.length,
        size: v.files.reduce((sum, f) => sum + f.size, 0),
        needsExecution: v.manifest.needsExecution,
        verified: v.verified,
        yanked: v.yanked,
        yankReason: v.yank_reason,
        flags: v.flags ?? [],
      })),
      version: shown.version,
      skillMd: main ? new TextDecoder().decode(await this.skills.blob(main.sha256)) : "",
      canModerate: admin,
      canYank: admin || mine,
      openReports,
    };
  }

  /** What changed between two versions, file by file (for reviewing an update). */
  async diff(userId: string | null, name: string, from: number, to: number): Promise<HubDiff> {
    const { storage } = await this.open(userId, "viewer");
    const rows = await storage.sql<(ScannedRow & { version: number })[]>`
      SELECT v.id AS version_id, v.version, v.files, v.flags
      FROM hub_skills h JOIN hub_skill_versions v ON v.hub_skill_id = h.id
      WHERE h.name = ${name} AND v.version IN ${storage.sql([from, to])}`;
    const before = rows.find((r) => r.version === from);
    const after = rows.find((r) => r.version === to);
    if (!before || !after) {
      throw new HubNotFoundError(`${name} has no version ${!before ? from : to} on the hub`);
    }
    await this.scanned(storage, [after]);
    const text = async (file: HubFile | undefined) => {
      if (!file || file.size > LARGE_FILE_BYTES) return null;
      const bytes = await this.skills.blob(file.sha256);
      if (bytes.includes(0)) return null;
      try {
        return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        return null;
      }
    };
    const old = new Map(before.files.map((f) => [f.path, f]));
    const now = new Map(after.files.map((f) => [f.path, f]));
    const files: HubDiffFile[] = [];
    for (const path of [...new Set([...old.keys(), ...now.keys()])].sort()) {
      const a = old.get(path);
      const b = now.get(path);
      if (a && b && a.sha256 === b.sha256) continue;
      const [beforeText, afterText] = await Promise.all([text(a), text(b)]);
      files.push({
        path,
        change: !a ? "added" : !b ? "removed" : "changed",
        before: beforeText,
        after: afterText,
        binary: (!!a && beforeText === null) || (!!b && afterText === null),
      });
    }
    return { name, from, to, files, flags: after.flags ?? [] };
  }

  /** Marks a version verified, or takes that back (hub admins). */
  async verify(userId: string | null, name: string, version: number, verified: boolean) {
    const { storage } = await this.open(userId, "viewer");
    if (!(await this.isAdmin(storage, userId!))) {
      throw new SkillForbiddenError("Only hub admins can verify skills");
    }
    return storage.sql.begin(async (tx) => {
      const updated = await tx`
        UPDATE hub_skill_versions v
        SET verified_at = ${verified ? tx`now()` : null}, verified_by = ${verified ? userId! : null}
        FROM hub_skills h
        WHERE v.hub_skill_id = h.id AND h.name = ${name} AND v.version = ${version}`;
      if (!updated.count) throw new HubNotFoundError(`${name} has no version ${version} on the hub`);
      await storage.access.audit(tx, { userId: userId!, actor: "user" }, verified ? "skill.verify" : "skill.unverify", {
        name,
        version,
      });
      return { name, version, verified };
    });
  }

  /**
   * Yanks a version (its publisher or a hub admin): it can no longer be
   * installed, and workspaces that have it see a warning. `yanked` false
   * restores it.
   */
  async yank(userId: string | null, name: string, version: number, yanked: boolean, reason?: string | null) {
    const { storage } = await this.open(userId, "viewer");
    const why = (reason ?? "").trim();
    if (why.length > 500) throw new HubError("Keep the reason under 500 characters");
    const [hub] = await storage.sql<{ owner_id: string }[]>`SELECT owner_id FROM hub_skills WHERE name = ${name}`;
    if (!hub) throw new HubNotFoundError(`No skill named ${name} on the hub`);
    if (hub.owner_id !== userId && !(await this.isAdmin(storage, userId!))) {
      throw new SkillForbiddenError("Only its publisher or a hub admin can yank a version");
    }
    return storage.sql.begin(async (tx) => {
      const updated = await tx`
        UPDATE hub_skill_versions v
        SET yanked_at = ${yanked ? tx`now()` : null}, yanked_by = ${yanked ? userId! : null},
            yank_reason = ${yanked && why ? why : null}
        FROM hub_skills h
        WHERE v.hub_skill_id = h.id AND h.name = ${name} AND v.version = ${version}`;
      if (!updated.count) throw new HubNotFoundError(`${name} has no version ${version} on the hub`);
      await storage.access.audit(tx, { userId: userId!, actor: "user" }, yanked ? "skill.yank" : "skill.unyank", {
        name,
        version,
        ...(yanked && why ? { reason: why } : {}),
      });
      return { name, version, yanked };
    });
  }

  /** Reports a hub skill to its publisher and the hub admins; reporting again replaces your open report. */
  async report(userId: string | null, name: string, reason: unknown, version?: number) {
    const { storage } = await this.open(userId, "viewer");
    const why = typeof reason === "string" ? reason.trim() : "";
    if (!why) throw new HubError("Say what's wrong with it");
    if (why.length > 2000) throw new HubError("Keep the report under 2000 characters");
    const [hub] = await storage.sql<{ id: string; has_version: boolean }[]>`
      SELECT id, EXISTS (
        SELECT 1 FROM hub_skill_versions WHERE hub_skill_id = hub_skills.id AND version = ${version ?? 0}
      ) AS has_version
      FROM hub_skills WHERE name = ${name}`;
    if (!hub) throw new HubNotFoundError(`No skill named ${name} on the hub`);
    if (version !== undefined && !hub.has_version) throw new HubNotFoundError(`${name} has no version ${version}`);
    return storage.sql.begin(async (tx) => {
      const [row] = await tx<{ id: string }[]>`
        INSERT INTO hub_skill_reports (hub_skill_id, version, reporter_id, reason)
        VALUES (${hub.id}, ${version ?? null}, ${userId!}, ${why})
        ON CONFLICT (hub_skill_id, reporter_id) WHERE dismissed_at IS NULL
        DO UPDATE SET reason = EXCLUDED.reason, version = EXCLUDED.version, created_at = now()
        RETURNING id`;
      await storage.access.audit(tx, { userId: userId!, actor: "user" }, "skill.report", { name, version: version ?? null });
      return { id: row.id };
    });
  }

  /** Closes a report (hub admins). */
  async dismissReport(userId: string | null, name: string, id: string) {
    const { storage } = await this.open(userId, "viewer");
    if (!(await this.isAdmin(storage, userId!))) {
      throw new SkillForbiddenError("Only hub admins can dismiss reports");
    }
    if (!UUID.test(id)) throw new HubNotFoundError("No such report");
    return storage.sql.begin(async (tx) => {
      const updated = await tx`
        UPDATE hub_skill_reports r SET dismissed_at = now(), dismissed_by = ${userId!}
        FROM hub_skills h
        WHERE r.hub_skill_id = h.id AND h.name = ${name} AND r.id = ${id} AND r.dismissed_at IS NULL`;
      if (!updated.count) throw new HubNotFoundError("No such open report");
      await storage.access.audit(tx, { userId: userId!, actor: "user" }, "skill.report.dismiss", { name, id });
      return { id, dismissed: true };
    });
  }

  /**
   * Publishes the workspace's skill as the next version of the hub skill of
   * that name (creating it, owned by this user, if it's new). Unchanged
   * files add no version.
   */
  async publish(userId: string | null, name: string): Promise<{ name: string; version: number; unchanged: boolean }> {
    const { storage } = await this.open(userId, "owner", "Only owners of the workspace can publish to the hub");
    const skill = await this.skills.find(userId, name);
    if (!skill) throw new HubNotFoundError(`No skill named ${name}`);
    if (skill.source !== "workspace") {
      throw new HubError(
        skill.source === "hub"
          ? `${name} comes from the hub; fork it into the workspace to publish your own version`
          : `${name} is built in; only the workspace's own skills can be published`,
      );
    }
    // The catalog leaves out files over the limits; refuse rather than publish part of the folder.
    const folder = skill.path!.slice(0, -"SKILL.md".length);
    const listed = (await (await storage.session({ userId: userId!, actor: "agent" }).files(null)).list()).filter((f) =>
      f.path.startsWith(folder),
    );
    const total = listed.reduce((sum, f) => sum + f.size, 0);
    if (listed.length > MAX_FILES || total > MAX_SKILL_BYTES || listed.some((f) => f.size > MAX_SKILL_FILE_BYTES)) {
      throw new HubError(
        `${name} is too big to publish: a skill may have at most ${MAX_FILES} files and ` +
          `${MAX_SKILL_BYTES / 1024 / 1024} MB, each file ${MAX_SKILL_FILE_BYTES / 1024 / 1024} MB`,
      );
    }
    const files: HubFile[] = [];
    for (const file of [...skill.files].sort((a, b) => a.path.localeCompare(b.path))) {
      const sha256 = sha256Hex(file.bytes);
      await storage.blobs.put(sha256, file.bytes, mimeForPath(file.path));
      files.push({ path: file.path, sha256, size: file.bytes.byteLength });
    }
    const fingerprint = sha256Hex(strToU8(files.map((f) => `${f.path}\0${f.sha256}`).join("\n")));
    const principal: Principal = { userId: userId!, actor: "user" };

    return storage.sql.begin(async (tx) => {
      await tx`
        INSERT INTO hub_skills (name, owner_id) VALUES (${name}, ${userId!})
        ON CONFLICT (name) DO NOTHING`;
      const [hub] = await tx<{ id: string; owner_id: string }[]>`
        SELECT id, owner_id FROM hub_skills WHERE name = ${name} FOR UPDATE`;
      if (hub.owner_id !== userId) {
        throw new SkillForbiddenError(`${name} on the hub was published by someone else`);
      }
      const [latest] = await tx<{ version: number; fingerprint: string }[]>`
        SELECT version, fingerprint FROM hub_skill_versions
        WHERE hub_skill_id = ${hub.id} ORDER BY version DESC LIMIT 1`;
      if (latest?.fingerprint === fingerprint) return { name, version: latest.version, unchanged: true };
      const version = (latest?.version ?? 0) + 1;
      await tx`
        INSERT INTO hub_skill_versions (hub_skill_id, version, manifest, files, fingerprint, published_by, flags)
        VALUES (${hub.id}, ${version}, ${tx.json(manifestOf(skill) as never)}, ${tx.json(files as never)},
                ${fingerprint}, ${userId!}, ${tx.json(scanSkill(skill.files) as never)})`;
      await tx`UPDATE hub_skills SET updated_at = now() WHERE id = ${hub.id}`;
      await storage.access.audit(tx, principal, "skill.publish", { name, version });
      return { name, version, unchanged: false };
    });
  }

  /** Installs (or moves the workspace's install to) a version, by default the newest that isn't yanked. */
  async install(userId: string | null, name: string, version?: number): Promise<{ name: string; version: number }> {
    const { storage } = await this.open(userId, "editor", "Installing skills needs editor access to the workspace");
    const [row] = await storage.sql<
      { hub_skill_id: string; version_id: string; version: number; yanked: boolean; yank_reason: string | null; current: string | null }[]
    >`
      SELECT h.id AS hub_skill_id, v.id AS version_id, v.version, v.yanked_at IS NOT NULL AS yanked, v.yank_reason,
             i.version_id AS current
      FROM hub_skills h JOIN hub_skill_versions v ON v.hub_skill_id = h.id
      LEFT JOIN skill_installs i ON i.hub_skill_id = h.id AND i.workspace_id = ${storage.workspaceId}
      WHERE h.name = ${name} ${version === undefined ? storage.sql`` : storage.sql`AND v.version = ${version}`}
      ORDER BY (v.yanked_at IS NULL) DESC, v.version DESC LIMIT 1`;
    if (!row) throw new HubNotFoundError(version === undefined ? `No skill named ${name} on the hub` : `${name} has no version ${version}`);
    if (row.yanked && row.current !== row.version_id) {
      throw new HubError(
        `${name} v${row.version} was yanked${row.yank_reason ? ` (${row.yank_reason})` : ""}, so it can't be installed`,
      );
    }
    // A workspace skill of that name would hide the install (forking is what replaces one with the other).
    if ((await this.skills.find(userId, name))?.source === "workspace") {
      throw new HubConflictError(`The workspace already has a skill named ${name}; rename or remove it to install this one`);
    }
    await storage.sql.begin(async (tx) => {
      await tx`
        INSERT INTO skill_installs (workspace_id, hub_skill_id, version_id, installed_by)
        VALUES (${storage.workspaceId}, ${row.hub_skill_id}, ${row.version_id}, ${userId!})
        ON CONFLICT (workspace_id, hub_skill_id)
        DO UPDATE SET version_id = EXCLUDED.version_id, installed_by = EXCLUDED.installed_by, installed_at = now()`;
      await storage.access.audit(tx, { userId: userId!, actor: "user" }, "skill.install", { name, version: row.version });
    });
    return { name, version: row.version };
  }

  async uninstall(userId: string | null, name: string): Promise<boolean> {
    const { storage } = await this.open(userId, "editor", "Removing skills needs editor access to the workspace");
    return storage.sql.begin(async (tx) => {
      const removed = await tx`
        DELETE FROM skill_installs i USING hub_skills h
        WHERE i.hub_skill_id = h.id AND h.name = ${name} AND i.workspace_id = ${storage.workspaceId}`;
      if (removed.count) await storage.access.audit(tx, { userId: userId!, actor: "user" }, "skill.uninstall", { name });
      return removed.count > 0;
    });
  }

  /**
   * Copies the installed version (else the latest) into the workspace as
   * skills/<name>/, to change it there, and removes the install it replaces.
   */
  async fork(userId: string | null, name: string): Promise<{ name: string; path: string }> {
    const { storage } = await this.open(userId, "editor", "Forking skills needs editor access to the workspace");
    const [row] = await storage.sql<{ files: HubFile[] }[]>`
      SELECT v.files
      FROM hub_skills h
      JOIN hub_skill_versions v ON v.hub_skill_id = h.id
      LEFT JOIN skill_installs i ON i.hub_skill_id = h.id AND i.workspace_id = ${storage.workspaceId}
      WHERE h.name = ${name}
      ORDER BY (v.id = i.version_id) DESC NULLS LAST, (v.yanked_at IS NULL) DESC, v.version DESC
      LIMIT 1`;
    if (!row) throw new HubNotFoundError(`No skill named ${name} on the hub`);
    const files = await Promise.all(
      row.files.map(async (f) => ({ path: f.path, bytes: await this.skills.blob(f.sha256) })),
    );
    await this.writeSkill(storage, userId!, name, files, false);
    await this.uninstall(userId, name);
    return { name, path: `skills/${name}/SKILL.md` };
  }

  /** A skill you can see (any source) as a .zip: <name>/SKILL.md and its files. */
  async exportZip(userId: string | null, name: string): Promise<Uint8Array> {
    const skill = await this.skills.find(userId, name);
    if (!skill) throw new HubNotFoundError(`No skill named ${name}`);
    return zipSync(Object.fromEntries(skill.files.map((f) => [`${name}/${f.path}`, f.bytes])));
  }

  /**
   * Adds a skill from a .zip to the workspace as skills/<name>/. Its
   * SKILL.md may be at the top of the zip or in one folder. With `replace`,
   * an existing skill folder of that name is replaced; otherwise that's a
   * conflict.
   */
  async importZip(
    userId: string | null,
    zip: Uint8Array,
    opts: { replace?: boolean; filename?: string } = {},
  ): Promise<{ name: string; path: string; files: number }> {
    const storage = this.storage();
    if (!storage || !userId) throw new HubError("Importing skills needs server storage");
    if (!atLeast(await this.skills.rootRole(userId), "editor")) {
      throw new SkillForbiddenError("Importing skills needs editor access to the workspace");
    }
    const entries = readZip(zip);
    const folders = new Set(entries.map((e) => e.path.split("/")[0]));
    let folder: string;
    let files: SkillFile[];
    if (entries.some((e) => e.path === "SKILL.md")) {
      folder = (opts.filename ?? "").replace(/\.zip$/i, "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
      files = entries;
    } else if (folders.size === 1 && entries.some((e) => e.path === `${[...folders][0]}/SKILL.md`)) {
      folder = [...folders][0];
      files = entries.map((e) => ({ path: e.path.slice(folder.length + 1), bytes: e.bytes }));
    } else {
      throw new HubError("The zip needs a SKILL.md, at its top or in a single folder");
    }
    const skill = skillFromFiles(SKILL_NAME.test(folder) ? folder : "imported-skill", files, "workspace", null);
    if (!skill) throw new HubError("SKILL.md has no usable name: give it `name:` in its front matter");
    await this.writeSkill(storage, userId, skill.name, files, opts.replace ?? false);
    return { name: skill.name, path: `skills/${skill.name}/SKILL.md`, files: files.length };
  }

  /**
   * Deletes the workspace skill called `name`: every file in its folder (which
   * may be named differently, as the name comes from SKILL.md), as the user
   * (editors). SKILL.md goes last, so a failure part way leaves the skill
   * listed to try again. A folder with read-only files is left alone.
   */
  async deleteSkill(userId: string | null, name: string): Promise<{ name: string; deleted: number }> {
    const { storage } = await this.open(userId, "editor", "Deleting skills needs editor access to the workspace");
    const skill = await this.skills.find(userId, name);
    if (skill?.source !== "workspace" || !skill.path) throw new HubNotFoundError(`The workspace has no skill named ${name}`);
    const session = await storage.session({ userId: userId!, actor: "user" }).files(null);
    const prefix = skill.path.slice(0, -"SKILL.md".length);
    const files = (await session.list()).filter((f) => f.path.startsWith(prefix));
    const locked = files.find((f) => f.readOnly);
    if (locked) throw new HubConflictError(`${locked.path} is read-only, so ${name} can't be deleted`);
    const main = `${prefix}SKILL.md`;
    files.sort((a, b) => Number(a.path === main) - Number(b.path === main));
    for (const file of files) await session.remove(file.path);
    return { name, deleted: files.length };
  }

  /** Writes a skill's files to skills/<name>/ as the user. */
  private async writeSkill(storage: Storage, userId: string, name: string, files: SkillFile[], replace: boolean) {
    const session = await storage.session({ userId, actor: "user" }).files(null);
    const prefix = `skills/${name}/`;
    const existing = (await session.list()).filter((f) => f.path.startsWith(prefix));
    if (existing.length && !replace) {
      throw new HubConflictError(`The workspace already has a skill folder ${prefix}`);
    }
    for (const file of files) await session.write(prefix + file.path, file.bytes);
    const kept = new Set(files.map((f) => prefix + f.path));
    for (const old of existing) if (!kept.has(old.path)) await session.remove(old.path);
  }

  /** Storage, and the user's role at the root, which must be at least `min`. */
  private async open(userId: string | null, min: Role, why?: string): Promise<{ storage: Storage; role: Role }> {
    const storage = this.storage();
    if (!storage || !userId) throw new HubNotFoundError("The skill hub needs server storage");
    const role = await storage.access.role(userId, null);
    if (!role || !atLeast(role, min)) {
      throw new SkillForbiddenError(why ?? "The hub needs access to the workspace");
    }
    return { storage, role };
  }

  /** Hub admins: HUB_ADMINS (emails or login subjects), and the local user when there is no login. */
  private async isAdmin(storage: Storage, userId: string): Promise<boolean> {
    const [user] = await storage.sql<{ subject: string; email: string | null }[]>`
      SELECT subject, email FROM users WHERE id = ${userId}`;
    if (!user) return false;
    return (
      user.subject === "local" ||
      this.admins.has(user.subject.toLowerCase()) ||
      (!!user.email && this.admins.has(user.email.toLowerCase()))
    );
  }

  /** Scans versions published before scanning existed (flags NULL), and keeps the result. */
  private async scanned(storage: Storage, rows: ScannedRow[]) {
    for (const row of rows) {
      if (row.flags) continue;
      const files = await Promise.all(
        row.files.map(async (f) => ({ path: f.path, bytes: await this.skills.blob(f.sha256) })),
      );
      row.flags = scanSkill(files);
      await storage.sql`
        UPDATE hub_skill_versions SET flags = ${storage.sql.json(row.flags as never)} WHERE id = ${row.version_id}`;
    }
  }

  /**
   * Hub skills with their newest version that isn't yanked (else the newest),
   * this workspace's install and the open reports; append the WHERE.
   */
  private listings(storage: Storage) {
    return (strings: TemplateStringsArray, ...values: unknown[]) =>
      storage.sql<ListingRow[]>`
        SELECT h.id, h.name, h.owner_id, h.updated_at, v.id AS version_id, v.version AS latest, v.manifest,
               v.files, v.flags, v.verified_at IS NOT NULL AS verified, v.yanked_at IS NOT NULL AS yanked,
               coalesce(u.name, u.email) AS publisher, iv.version AS installed,
               (SELECT count(*)::int FROM hub_skill_reports r
                WHERE r.hub_skill_id = h.id AND r.dismissed_at IS NULL) AS reports
        FROM hub_skills h
        JOIN LATERAL (
          SELECT id, version, manifest, files, flags, verified_at, yanked_at FROM hub_skill_versions
          WHERE hub_skill_id = h.id ORDER BY (yanked_at IS NULL) DESC, version DESC LIMIT 1
        ) v ON true
        LEFT JOIN users u ON u.id = h.owner_id
        LEFT JOIN skill_installs i ON i.hub_skill_id = h.id AND i.workspace_id = ${storage.workspaceId}
        LEFT JOIN hub_skill_versions iv ON iv.id = i.version_id
        ${storage.sql(strings, ...(values as never[]))}`;
  }

  private listing(row: ListingRow, userId: string, admin: boolean): HubListing {
    const mine = row.owner_id === userId;
    return {
      ...row.manifest,
      name: row.name,
      publisher: row.publisher,
      mine,
      latest: row.latest,
      verified: row.verified,
      yanked: row.yanked,
      flags: row.flags?.length ?? 0,
      updatedAt: row.updated_at.toISOString(),
      installed: row.installed,
      reports: admin || mine ? row.reports : null,
    };
  }
}

const IGNORED = /(^|\/)(__MACOSX\/|\.DS_Store$|Thumbs\.db$)/;

/** A zip's files, within the skill limits; directories and OS clutter left out. */
function readZip(zip: Uint8Array): SkillFile[] {
  let count = 0;
  let declared = 0;
  let unzipped: Record<string, Uint8Array>;
  try {
    unzipped = unzipSync(zip, {
      filter: (file) => {
        if (file.name.endsWith("/") || IGNORED.test(file.name)) return false;
        count += 1;
        declared += file.originalSize;
        if (count > MAX_FILES) throw new HubError(`A skill may have at most ${MAX_FILES} files`);
        if (file.originalSize > MAX_SKILL_FILE_BYTES || declared > MAX_SKILL_BYTES) {
          throw new HubError(`A skill may be at most ${MAX_SKILL_BYTES / 1024 / 1024} MB, each file ${MAX_SKILL_FILE_BYTES / 1024 / 1024} MB`);
        }
        return true;
      },
    });
  } catch (err) {
    if (err instanceof HubError) throw err;
    throw new HubError("That isn't a readable .zip file");
  }
  let total = 0;
  return Object.entries(unzipped).map(([name, bytes]) => {
    total += bytes.byteLength;
    if (bytes.byteLength > MAX_SKILL_FILE_BYTES || total > MAX_SKILL_BYTES) {
      throw new HubError(`A skill may be at most ${MAX_SKILL_BYTES / 1024 / 1024} MB`);
    }
    try {
      return { path: normalizePath(name), bytes };
    } catch (err) {
      if (err instanceof InvalidPathError) throw new HubError(`The zip has an invalid path: ${name}`);
      throw err;
    }
  });
}
