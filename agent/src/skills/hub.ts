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
import { SkillForbiddenError, type HubFile, type SkillService } from "./service";

/**
 * The skill hub (issue #7, step 3), one per deployment. Owners of the
 * workspace publish its skills as immutable, numbered versions (files kept
 * as blobs, so a version never changes); editors install one pinned to a
 * version, update it, or fork it into the workspace's skills/ to change it.
 * Skills also move in and out as .zip files in the standard Agent Skills
 * layout (<name>/SKILL.md + files), so they work with Claude Code too.
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
  latest: number;
  updatedAt: string;
  /** The version installed in this workspace, or null. */
  installed: number | null;
}

export interface HubVersion {
  version: number;
  publishedAt: string;
  publishedBy: string | null;
  files: number;
  size: number;
  needsExecution: boolean;
}

export interface HubDetail extends HubListing {
  versions: HubVersion[];
  /** The version shown, and its SKILL.md. */
  version: number;
  skillMd: string;
}

export interface HubList {
  skills: HubListing[];
  canInstall: boolean;
  canPublish: boolean;
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

interface ListingRow {
  id: string;
  name: string;
  owner_id: string;
  publisher: string | null;
  updated_at: Date;
  latest: number;
  manifest: HubManifest;
  installed: number | null;
}

export class SkillHub {
  constructor(
    private readonly storage: () => Storage | null,
    private readonly skills: SkillService,
  ) {}

  /** The hub's skills, newest first; `query` matches names and descriptions. */
  async list(userId: string | null, query = ""): Promise<HubList> {
    const { storage, role } = await this.open(userId, "viewer");
    const like = `%${query.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const rows = await this.listings(storage)`
      WHERE h.name ILIKE ${like} OR v.manifest->>'description' ILIKE ${like}
      ORDER BY h.updated_at DESC
      LIMIT 100`;
    return {
      skills: rows.map((row) => this.listing(row, userId!)),
      canInstall: atLeast(role, "editor"),
      canPublish: atLeast(role, "owner"),
    };
  }

  /** One hub skill with its versions, showing `version` (default the latest). */
  async detail(userId: string | null, name: string, version?: number): Promise<HubDetail> {
    const { storage } = await this.open(userId, "viewer");
    const [row] = await this.listings(storage)`WHERE h.name = ${name}`;
    if (!row) throw new HubNotFoundError(`No skill named ${name} on the hub`);
    const versions = await storage.sql<
      { version: number; published_at: Date; published_by: string | null; files: HubFile[]; manifest: HubManifest }[]
    >`
      SELECT v.version, v.published_at, v.files, v.manifest, coalesce(u.name, u.email) AS published_by
      FROM hub_skill_versions v LEFT JOIN users u ON u.id = v.published_by
      WHERE v.hub_skill_id = ${row.id}
      ORDER BY v.version DESC`;
    const shown = versions.find((v) => v.version === (version ?? row.latest));
    if (!shown) throw new HubNotFoundError(`${name} has no version ${version}`);
    const main = shown.files.find((f) => f.path === "SKILL.md");
    return {
      ...this.listing(row, userId!),
      versions: versions.map((v) => ({
        version: v.version,
        publishedAt: v.published_at.toISOString(),
        publishedBy: v.published_by,
        files: v.files.length,
        size: v.files.reduce((sum, f) => sum + f.size, 0),
        needsExecution: v.manifest.needsExecution,
      })),
      version: shown.version,
      skillMd: main ? new TextDecoder().decode(await this.skills.blob(main.sha256)) : "",
    };
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
        INSERT INTO hub_skill_versions (hub_skill_id, version, manifest, files, fingerprint, published_by)
        VALUES (${hub.id}, ${version}, ${tx.json(manifestOf(skill) as never)}, ${tx.json(files as never)},
                ${fingerprint}, ${userId!})`;
      await tx`UPDATE hub_skills SET updated_at = now() WHERE id = ${hub.id}`;
      await storage.access.audit(tx, principal, "skill.publish", { name, version });
      return { name, version, unchanged: false };
    });
  }

  /** Installs (or moves the workspace's install to) a version, the latest by default. */
  async install(userId: string | null, name: string, version?: number): Promise<{ name: string; version: number }> {
    const { storage } = await this.open(userId, "editor", "Installing skills needs editor access to the workspace");
    const [row] = await storage.sql<{ hub_skill_id: string; version_id: string; version: number }[]>`
      SELECT h.id AS hub_skill_id, v.id AS version_id, v.version
      FROM hub_skills h JOIN hub_skill_versions v ON v.hub_skill_id = h.id
      WHERE h.name = ${name} ${version === undefined ? storage.sql`` : storage.sql`AND v.version = ${version}`}
      ORDER BY v.version DESC LIMIT 1`;
    if (!row) throw new HubNotFoundError(version === undefined ? `No skill named ${name} on the hub` : `${name} has no version ${version}`);
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
      ORDER BY (v.id = i.version_id) DESC NULLS LAST, v.version DESC
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

  /** Hub skills with their latest version and this workspace's install; append the WHERE. */
  private listings(storage: Storage) {
    return (strings: TemplateStringsArray, ...values: unknown[]) =>
      storage.sql<ListingRow[]>`
        SELECT h.id, h.name, h.owner_id, h.updated_at, v.version AS latest, v.manifest,
               coalesce(u.name, u.email) AS publisher, iv.version AS installed
        FROM hub_skills h
        JOIN LATERAL (
          SELECT version, manifest FROM hub_skill_versions
          WHERE hub_skill_id = h.id ORDER BY version DESC LIMIT 1
        ) v ON true
        LEFT JOIN users u ON u.id = h.owner_id
        LEFT JOIN skill_installs i ON i.hub_skill_id = h.id AND i.workspace_id = ${storage.workspaceId}
        LEFT JOIN hub_skill_versions iv ON iv.id = i.version_id
        ${storage.sql(strings, ...(values as never[]))}`;
  }

  private listing(row: ListingRow, userId: string): HubListing {
    return {
      ...row.manifest,
      name: row.name,
      publisher: row.publisher,
      mine: row.owner_id === userId,
      latest: row.latest,
      updatedAt: row.updated_at.toISOString(),
      installed: row.installed,
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
