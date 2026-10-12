import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { Options } from "@anthropic-ai/claude-agent-sdk";

import type { SkillSource } from "./catalog";
import type { KeyRoute } from "./keyproxy";
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
 *   no shell        `!` commands in a SKILL.md are never run, and the run
 *                   has no shell tool, unless scripts are on (below).
 *
 * Scripts (step 5): with SKILL_SCRIPTS=on, a run that has a skill shipping
 * scripts also gets Bash, always inside the SDK's sandbox (bubblewrap on
 * Linux; the run fails rather than run commands unsandboxed): no network,
 * writes only in the run folder (not its skills), the server's own files,
 * its home and other users' folders unreadable, and an environment holding
 * nothing but what the SDK needs, with a stand-in for the API key
 * (./keyproxy.ts).
 *
 * The folder stays the same per user so resumed chat sessions (stored by the
 * SDK per working directory) still find their history.
 */

export interface RunSkills {
  /** Working directory whose .claude/skills/ holds this run's skills. */
  cwd: string;
  skills: UserSkill[];
  /** How the run reaches Anthropic when its scripts are on (./keyproxy.ts). */
  keys?: KeyRoute;
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

/** Skill scripts run only when the deployment turns them on. */
export const scriptsEnabled = () => process.env.SKILL_SCRIPTS === "on";

/**
 * What a script run keeps of the server's environment: nothing secret, since
 * its commands see all of it. (Proxy settings can hold passwords, and the run
 * only talks to the key proxy on 127.0.0.1.)
 */
const RUN_ENV =
  /^(PATH|HOME|USER|LOGNAME|SHELL|LANG|LANGUAGE|LC_[A-Z]+|TZ|TERM|TMPDIR|ANTHROPIC_(MODEL|SMALL_FAST_MODEL|DEFAULT_[A-Z]+_MODEL))$/;

/**
 * SDK options that let this run use Bash for its skills' scripts, in the
 * sandbox; null when scripts are off or none of its skills has any.
 * `appRoot` is the server's own folder (code, .env), which scripts can't read.
 * Needs `run.keys`, so the run never holds the real API key.
 */
export function scriptOptions(run: RunSkills, appRoot: string, root = ROOT): Partial<Options> | null {
  if (!scriptsEnabled() || !run.keys || !run.skills.some((s) => s.skill.needsExecution)) return null;
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && RUN_ENV.test(key)) env[key] = value;
  }
  env.ANTHROPIC_BASE_URL = run.keys.baseUrl;
  env.ANTHROPIC_API_KEY = run.keys.apiKey;
  env.NO_PROXY = env.no_proxy = "127.0.0.1,localhost";
  return {
    env,
    tools: ["Skill", "Bash"],
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: false,
      network: { allowedDomains: [] },
      filesystem: {
        denyWrite: [path.join(run.cwd, ".claude")],
        // Other users' run folders, the server's files and its home stay out of reach.
        denyRead: [path.resolve(appRoot), path.resolve(root), os.homedir()],
        allowRead: [run.cwd],
      },
    },
  };
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
