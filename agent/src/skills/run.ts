import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { Options } from "@anthropic-ai/claude-agent-sdk";

import type { SkillSource } from "./catalog";
import type { SkillTrigger, UserSkill } from "./service";

/**
 * How one run gets its skills. The Claude Agent SDK loads skills from
 * <cwd>/.claude/skills/, so each user gets a folder of their own holding
 * exactly the skills that are on for them (written again only when that set
 * changes), and the run starts there with:
 *
 *   skills          the ones it may use (others, e.g. the SDK's bundled
 *                   skills, are hidden from Claude and refused);
 *   skillOverrides  auto → "on", manual → "user-invocable-only" (/name only);
 *   no shell        skills here are instructions only (`!` commands in a
 *                   SKILL.md are not run), and the run has no shell tools.
 *
 * The folder stays the same per user so resumed chat sessions (stored by the
 * SDK per working directory) still find their history.
 */

export interface RunSkills {
  /** Working directory whose .claude/skills/ holds this run's skills. */
  cwd: string;
  skills: UserSkill[];
}

export interface SkillUse {
  skill: string;
  source: SkillSource;
  trigger: SkillTrigger;
}

const ROOT = process.env.SKILLS_RUN_DIR || path.join(os.tmpdir(), "knowledge-chatroom-skills");

/** Writes per run folder, one after another, so two runs starting together don't race. */
const writing = new Map<string, Promise<unknown>>();

/** Writes the user's skills to their run folder (if they changed) and returns it. */
export async function materialize(
  userKey: string,
  skills: UserSkill[],
  root = ROOT,
): Promise<RunSkills> {
  const cwd = path.join(root, createHash("sha256").update(userKey).digest("hex").slice(0, 16));
  const previous = writing.get(cwd) ?? Promise.resolve();
  const done = previous.catch(() => {}).then(() => write(cwd, skills));
  writing.set(cwd, done);
  try {
    return await done;
  } finally {
    if (writing.get(cwd) === done) writing.delete(cwd);
  }
}

async function write(cwd: string, skills: UserSkill[]): Promise<RunSkills> {
  const dir = path.join(cwd, ".claude", "skills");
  const fingerprint = createHash("sha256");
  for (const { skill } of skills) {
    fingerprint.update(`${skill.name}\0`);
    for (const file of skill.files) {
      fingerprint.update(`${file.path}\0`).update(createHash("sha256").update(file.bytes).digest());
    }
  }
  const hash = fingerprint.digest("hex");
  const marker = path.join(dir, ".fingerprint");
  if ((await readFile(marker, "utf8").catch(() => null)) === hash) return { cwd, skills };

  // Build the new set beside the old one, then swap it in.
  const next = path.join(cwd, ".claude", `skills.${randomUUID()}`);
  for (const { skill } of skills) {
    for (const file of skill.files) {
      const target = path.resolve(next, skill.name, file.path);
      // Paths come from storage, which already refuses "..", but stay inside regardless.
      if (!target.startsWith(path.resolve(next, skill.name) + path.sep)) continue;
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, file.bytes);
    }
  }
  await mkdir(next, { recursive: true });
  await writeFile(path.join(next, ".fingerprint"), hash);
  const old = path.join(cwd, ".claude", `skills.old.${randomUUID()}`);
  await rename(dir, old).catch(() => {});
  await rename(next, dir);
  await rm(old, { recursive: true, force: true });
  return { cwd, skills };
}

/** SDK options for a run with these skills; `onUse` hears each one used. */
export function skillOptions(run: RunSkills, onUse: (use: SkillUse) => void): Partial<Options> {
  const byName = new Map(run.skills.map((s) => [s.skill.name, s]));
  const used = (name: unknown, trigger: SkillTrigger) => {
    const entry = typeof name === "string" ? byName.get(name) : undefined;
    if (entry) onUse({ skill: entry.skill.name, source: entry.skill.source, trigger });
  };
  return {
    cwd: run.cwd,
    // Only the run folder's .claude/: never the server's own ~/.claude settings or skills.
    settingSources: ["project"],
    skills: run.skills.map((s) => s.skill.name),
    settings: {
      skillOverrides: Object.fromEntries(
        run.skills.map((s) => [s.skill.name, s.mode === "auto" ? "on" : "user-invocable-only"]),
      ),
      disableSkillShellExecution: true,
    },
    hooks: {
      PreToolUse: [
        {
          matcher: "Skill",
          hooks: [
            async (input) => {
              const args = (input as { tool_input?: { skill?: unknown } }).tool_input;
              used(args?.skill, "model");
              return {};
            },
          ],
        },
      ],
      UserPromptExpansion: [
        {
          hooks: [
            async (input) => {
              used((input as { command_name?: unknown }).command_name, "slash");
              return {};
            },
          ],
        },
      ],
    },
  };
}

/**
 * The SDK treats a prompt starting with "/" as a command: one of the run's
 * skills, but also its own commands (/clear, /compact, bundled skills...).
 * Only `/name` for a skill this run has stays a command; anything else is sent
 * as plain text (a leading space keeps the SDK from reading it as a command).
 */
export function guardSlashCommand(prompt: string, run: RunSkills | null): string {
  const match = /^\/([^\s/]+)/.exec(prompt);
  if (!match) return prompt;
  const allowed = run?.skills.some((s) => s.skill.name === match[1] && s.skill.userInvocable);
  return allowed ? prompt : ` ${prompt}`;
}
