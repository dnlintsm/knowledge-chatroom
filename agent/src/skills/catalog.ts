import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Skills Claude can use (issue #7): SKILL.md folders in the Claude Code /
 * Agent Skills layout, from two sources for now: built-in ones shipped with
 * the agent (agent/skills/) and the workspace's own skills/<name>/ files.
 * Each has a mode the user picks (settings.ts):
 *
 *   auto    Claude may use it on its own, and /name runs it
 *   manual  only /name runs it; Claude doesn't see it otherwise
 *   off     not available at all
 */

export type SkillMode = "auto" | "manual" | "off";
export const SKILL_MODES: readonly SkillMode[] = ["auto", "manual", "off"];
export type SkillSource = "builtin" | "workspace";

export interface SkillFile {
  /** Path inside the skill's folder, e.g. "SKILL.md" or "reference/style.md". */
  path: string;
  bytes: Uint8Array;
}

export interface Skill {
  name: string;
  description: string;
  /** Shown after /name in the slash menu, e.g. "[file]". */
  argumentHint: string | null;
  source: SkillSource;
  /** The workspace path of its SKILL.md; null for built-in skills. */
  path: string | null;
  /** False when its front matter says disable-model-invocation: then it is never auto. */
  modelInvocable: boolean;
  /** False when its front matter says user-invocable: false: no /name for it. */
  userInvocable: boolean;
  /** It ships scripts or asks for a shell, which skills here can't run (yet). */
  needsExecution: boolean;
  files: SkillFile[];
}

/** What the API and the UI see: a skill without its files, plus its modes. */
export interface SkillInfo extends Omit<Skill, "files"> {
  mode: SkillMode;
  defaultMode: SkillMode;
}

export const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Caps what a run copies to disk; bigger files and skills are left out. */
export const MAX_SKILL_FILE_BYTES = 1024 * 1024;
const MAX_SKILL_BYTES = 5 * 1024 * 1024;

/** Reads the simple `key: value` front matter of a SKILL.md. */
export function parseFrontMatter(text: string): Record<string, string> {
  const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match) return {};
  const fields: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const field = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!field) continue;
    let value = field[2].trim();
    if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1);
    fields[field[1].toLowerCase()] = value;
  }
  return fields;
}

const SCRIPT_FILE = /(^|\/)scripts\/|\.(py|sh|bash|js|mjs|cjs|ts|rb|pl|ps1)$/i;
const isFalse = (value: string | undefined) => value?.toLowerCase() === "false";
const isTrue = (value: string | undefined) => value?.toLowerCase() === "true";

/**
 * A skill from its folder's files, or null when there is no usable SKILL.md.
 * The name comes from the front matter (as Claude Code does), else the folder.
 */
export function skillFromFiles(
  folder: string,
  files: SkillFile[],
  source: SkillSource,
  skillPath: string | null,
): Skill | null {
  const main = files.find((f) => f.path === "SKILL.md");
  if (!main) return null;
  const text = new TextDecoder().decode(main.bytes);
  const meta = parseFrontMatter(text);
  const name = SKILL_NAME.test(meta.name ?? "") ? meta.name : folder;
  if (!SKILL_NAME.test(name)) return null;
  const firstLine = text
    .replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "")
    .split(/\r?\n/)
    .map((line) => line.replace(/^#+\s*/, "").trim())
    .find(Boolean);
  let total = 0;
  const kept = files.filter((f) => {
    if (f.bytes.byteLength > MAX_SKILL_FILE_BYTES) return false;
    total += f.bytes.byteLength;
    return total <= MAX_SKILL_BYTES || f === main;
  });
  return {
    name,
    description: meta.description || firstLine || "",
    argumentHint: meta["argument-hint"] || null,
    source,
    path: skillPath,
    modelInvocable: !isTrue(meta["disable-model-invocation"]),
    userInvocable: !isFalse(meta["user-invocable"]),
    needsExecution:
      files.some((f) => SCRIPT_FILE.test(f.path)) || /\bBash\b/.test(meta["allowed-tools"] ?? ""),
    files: kept,
  };
}

/** Workspace skills from the files at the workspace root: skills/<folder>/... */
export function workspaceSkills(files: { path: string; bytes: Uint8Array }[]): Skill[] {
  const folders = new Map<string, SkillFile[]>();
  for (const file of files) {
    const match = /^skills\/([^/]+)\/(.+)$/.exec(file.path);
    if (!match) continue;
    const list = folders.get(match[1]) ?? [];
    list.push({ path: match[2], bytes: file.bytes });
    folders.set(match[1], list);
  }
  const skills: Skill[] = [];
  for (const [folder, list] of [...folders].sort(([a], [b]) => a.localeCompare(b))) {
    const skill = skillFromFiles(folder, list, "workspace", `skills/${folder}/SKILL.md`);
    // Two folders claiming one name: the first (by folder) wins.
    if (skill && !skills.some((s) => s.name === skill.name)) skills.push(skill);
  }
  return skills;
}

const BUILTIN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../skills");

function readTree(dir: string, prefix = ""): SkillFile[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return readTree(full, rel);
    if (!entry.isFile() || statSync(full).size > MAX_SKILL_FILE_BYTES) return [];
    return [{ path: rel, bytes: new Uint8Array(readFileSync(full)) }];
  });
}

let builtins: Skill[] | null = null;

/** The skills shipped in agent/skills/, read once. */
export function builtinSkills(dir = BUILTIN_DIR): Skill[] {
  if (dir !== BUILTIN_DIR) return loadBuiltins(dir);
  builtins ??= loadBuiltins(dir);
  return builtins;
}

function loadBuiltins(dir: string): Skill[] {
  let folders: string[];
  try {
    folders = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
  return folders
    .map((folder) => skillFromFiles(folder, readTree(path.join(dir, folder)), "builtin", null))
    .filter((s): s is Skill => s !== null);
}

/** All skills by name; a workspace skill replaces a built-in one of the same name. */
export function mergeSkills(builtin: Skill[], workspace: Skill[]): Skill[] {
  const byName = new Map<string, Skill>();
  for (const skill of [...builtin, ...workspace]) byName.set(skill.name, skill);
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** A skill's mode before the user changes it: auto, unless it can't be. */
export function defaultMode(skill: Skill): SkillMode {
  return skill.modelInvocable ? "auto" : "manual";
}

/**
 * The mode that applies: the user's choice, else the default. A skill Claude
 * may not invoke is never auto, and one without /name is never manual.
 */
export function effectiveMode(skill: Skill, chosen: SkillMode | undefined): SkillMode {
  let mode = chosen ?? defaultMode(skill);
  if (mode === "auto" && !skill.modelInvocable) mode = "manual";
  if (mode === "manual" && !skill.userInvocable) mode = "off";
  return mode;
}

export function describe(skill: Skill, chosen: SkillMode | undefined): SkillInfo {
  return {
    name: skill.name,
    description: skill.description,
    argumentHint: skill.argumentHint,
    source: skill.source,
    path: skill.path,
    modelInvocable: skill.modelInvocable,
    userInvocable: skill.userInvocable,
    needsExecution: skill.needsExecution,
    mode: effectiveMode(skill, chosen),
    defaultMode: defaultMode(skill),
  };
}
