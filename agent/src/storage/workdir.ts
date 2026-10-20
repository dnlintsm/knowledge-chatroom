/**
 * The run's working folder (issue #77). The Claude Agent SDK's built-in tools
 * (Read, Glob, Grep, Bash) work on real files under the run's `cwd`, but the
 * workspace lives in Postgres + the blob store. So each user's run folder
 * (./skills/run.ts) gets `workspace/`, a mirror of every file that user can
 * read:
 *
 *   workspace/root/...                         the workspace root
 *   workspace/nodes/<Tech>/<Module>/...        each knowledge node's files,
 *                                              child nodes as subfolders
 *   workspace/experiments/<title> (<id>)/...   each experiment they can see
 *   workspace/.places.json                     folder → node / experiment id
 *
 * It is filled through the user's own session (the same checks and row
 * security as the file tools), so it never holds a file they can't open.
 * Synced at the start of each run: only files whose content changed are
 * downloaded, files that went away are removed. It is a snapshot; changes
 * made during a run show up on the next one.
 *
 * Claude reads it with Read/Glob/Grep, confined to the run folder
 * (confineTools); changes still go through write_file / save_file.
 */

import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, readdir, realpath, rename, rm, rmdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { HookCallbackMatcher } from "@anthropic-ai/claude-agent-sdk";

import type { FilesSession, Session } from "./session";

export const WORKSPACE_DIR = "workspace";
/** Kept in the run folder, outside workspace/: path → sha256 of what was written. */
export const MANIFEST = ".workspace-manifest.json";
const PLACES = ".places.json";

/** On by default with storage; AGENT_WORKDIR=off turns it off. */
export const workdirEnabled = () => process.env.AGENT_WORKDIR !== "off";

export interface WorkdirLimits {
  /** Most bytes the mirror holds; files past it are left out. */
  maxBytes: number;
  /** Larger files are left out. */
  maxFileBytes: number;
}

const MB = 1024 * 1024;

export function workdirLimitsFromEnv(env = process.env): WorkdirLimits {
  const mb = (value: string | undefined, fallback: number) => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n * MB : fallback * MB;
  };
  return {
    maxBytes: mb(env.AGENT_WORKDIR_MAX_MB, 500),
    maxFileBytes: mb(env.AGENT_WORKDIR_MAX_FILE_MB, 25),
  };
}

export interface Place {
  folder: string;
  root?: true;
  node?: string;
  experiment?: string;
  /** What the user may do there: editor/owner/writer can change files (through the tools). */
  role: string;
}

export interface WorkdirSummary {
  /** Absolute path of workspace/. */
  dir: string;
  places: Place[];
  files: number;
  bytes: number;
  /** Files left out (too large, over the total, or a name taken by a child node). */
  skipped: { path: string; reason: string }[];
}

interface Wanted {
  rel: string;
  sha256: string;
  size: number;
  files: FilesSession;
  path: string;
}

/** A folder name for a node or experiment: no slashes, no leading dot, not empty. */
export function folderName(name: string): string {
  const clean = name
    // eslint-disable-next-line no-control-regex
    .replace(/[/\\\u0000-\u001f]/g, "-")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 120);
  return clean || "untitled";
}

/** Syncs per folder, one after another, so two runs starting together don't race. */
const syncing = new Map<string, Promise<unknown>>();

/** Brings `<cwd>/workspace/` up to date with what `session`'s user can read. */
export async function syncWorkdir(
  session: Session,
  cwd: string,
  limits: WorkdirLimits = workdirLimitsFromEnv(),
): Promise<WorkdirSummary> {
  const previous = syncing.get(cwd) ?? Promise.resolve();
  const done = previous.catch(() => {}).then(() => sync(session, cwd, limits));
  syncing.set(cwd, done);
  try {
    return await done;
  } finally {
    if (syncing.get(cwd) === done) syncing.delete(cwd);
  }
}

async function sync(session: Session, cwd: string, limits: WorkdirLimits): Promise<WorkdirSummary> {
  const dir = path.join(cwd, WORKSPACE_DIR);
  const places: Place[] = [];
  const skipped: WorkdirSummary["skipped"] = [];
  const wanted = new Map<string, Wanted>();

  const { rootRole, nodes } = await session.tree();

  // Folder of each node: its ancestors' names, with siblings of the same name told apart by id.
  const folders = new Map<string, string>();
  const byParent = new Map<string | null, typeof nodes>();
  for (const node of nodes) {
    const siblings = byParent.get(node.parentId) ?? [];
    siblings.push(node);
    byParent.set(node.parentId, siblings);
  }
  const childNames = new Map<string, Set<string>>();
  const walk = (parentId: string | null, parentFolder: string) => {
    const siblings = byParent.get(parentId) ?? [];
    const counts = new Map<string, number>();
    for (const node of siblings) {
      const name = folderName(node.name).toLowerCase();
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    const names = new Set<string>();
    for (const node of siblings) {
      let name = folderName(node.name);
      if ((counts.get(name.toLowerCase()) ?? 0) > 1) name = `${name} (${node.id.slice(0, 8)})`;
      names.add(name);
      const folder = `${parentFolder}/${name}`;
      folders.set(node.id, folder);
      walk(node.id, folder);
    }
    if (parentId) childNames.set(parentId, names);
  };
  walk(null, "nodes");

  const collect = async (files: FilesSession, folder: string, children?: Set<string>) => {
    for (const info of await files.list()) {
      if (children?.has(info.path.split("/")[0])) {
        skipped.push({ path: `${folder}/${info.path}`, reason: "a child node has this name" });
        continue;
      }
      const rel = `${folder}/${info.path}`;
      wanted.set(rel, { rel, sha256: info.sha256, size: info.size, files, path: info.path });
    }
  };

  if (rootRole) {
    places.push({ folder: `${WORKSPACE_DIR}/root`, root: true, role: rootRole });
    await collect(await session.files(null), "root");
  }
  for (const node of nodes) {
    const folder = folders.get(node.id)!;
    if (!node.role) continue;
    places.push({ folder: `${WORKSPACE_DIR}/${folder}`, node: node.id, role: node.role });
    await collect(await session.files(node.id), folder, childNames.get(node.id));
  }
  for (const experiment of await session.experiments()) {
    const folder = `experiments/${folderName(experiment.title)} (${experiment.id.slice(0, 8)})`;
    places.push({ folder: `${WORKSPACE_DIR}/${folder}`, experiment: experiment.id, role: experiment.access });
    await collect(await session.experimentFiles(experiment.id), folder);
  }

  // Newest-first would need dates; smallest-first keeps the most files under the cap.
  let bytes = 0;
  const keep = new Map<string, Wanted>();
  for (const file of [...wanted.values()].sort((a, b) => a.size - b.size || a.rel.localeCompare(b.rel))) {
    if (file.size > limits.maxFileBytes) {
      skipped.push({ path: file.rel, reason: `larger than ${limits.maxFileBytes / MB} MB` });
    } else if (bytes + file.size > limits.maxBytes) {
      skipped.push({ path: file.rel, reason: `the folder is full (${limits.maxBytes / MB} MB)` });
    } else {
      keep.set(file.rel, file);
      bytes += file.size;
    }
  }

  const manifestPath = path.join(cwd, MANIFEST);
  const manifest: Record<string, string> = JSON.parse(
    (await readFile(manifestPath, "utf8").catch(() => null)) ?? "{}",
  );
  await mkdir(dir, { recursive: true });

  // Remove what is no longer wanted (or wasn't written by us), then empty folders.
  const present = new Set<string>();
  const removeStale = async (folder: string, relFolder: string): Promise<boolean> => {
    let empty = true;
    for (const entry of await readdir(folder, { withFileTypes: true }).catch(() => [])) {
      const full = path.join(folder, entry.name);
      const rel = relFolder ? `${relFolder}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (await removeStale(full, rel)) await rmdir(full).catch(() => {});
        else empty = false;
      } else if (rel !== PLACES && (!keep.has(rel) || keep.get(rel)!.sha256 !== manifest[rel])) {
        await rm(full, { force: true });
        delete manifest[rel];
      } else {
        present.add(rel);
        empty = false;
      }
    }
    return empty;
  };
  await removeStale(dir, "");

  const missing = [...keep.values()].filter((f) => !present.has(f.rel) || manifest[f.rel] !== f.sha256);
  let failed = 0;
  await pool(missing, 8, async (file) => {
    const target = path.join(dir, ...file.rel.split("/"));
    try {
      const got = await file.files.read(file.path);
      if (!got) return;
      await mkdir(path.dirname(target), { recursive: true });
      const tmp = `${target}.${process.pid}.tmp`;
      await writeFile(tmp, got.bytes);
      // Read-only: changes go through the file tools, which check access and keep versions.
      await chmod(tmp, 0o444);
      await rename(tmp, target);
      manifest[file.rel] = got.info.sha256 || createHash("sha256").update(got.bytes).digest("hex");
    } catch (err) {
      failed++;
      skipped.push({ path: file.rel, reason: "couldn't be copied" });
      if (failed <= 3) console.error(`[workdir] couldn't copy ${file.rel}: ${err instanceof Error ? err.message : err}`);
    }
  });

  await writeFile(manifestPath, JSON.stringify(manifest));
  const placesPath = path.join(dir, PLACES);
  await rm(placesPath, { force: true });
  await writeFile(placesPath, JSON.stringify({ places, skipped }, null, 1));
  await chmod(placesPath, 0o444);

  return { dir, places, files: keep.size - failed, bytes, skipped };
}

async function pool<T>(items: T[], size: number, fn: (item: T) => Promise<void>) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) await fn(items[next++]);
    }),
  );
}

/** Whether `target` (after following links) is `root` or inside it. */
export async function isInside(root: string, target: string): Promise<boolean> {
  const realRoot = await realpath(root).catch(() => path.resolve(root));
  // A path that doesn't exist yet: check its nearest existing parent.
  let probe = path.resolve(root, target);
  let rest = "";
  for (;;) {
    try {
      const real = path.join(await realpath(probe), rest);
      return real === realRoot || real.startsWith(realRoot + path.sep);
    } catch {
      const parent = path.dirname(probe);
      if (parent === probe) return false;
      rest = path.join(path.basename(probe), rest);
      probe = parent;
    }
  }
}

/** Read, Glob and Grep, which run outside the sandbox, may only look inside the run folder. */
export const CONFINED_TOOLS = ["Read", "Glob", "Grep"];

export function confineTools(cwd: string): HookCallbackMatcher {
  const deny = (reason: string) => ({
    hookSpecificOutput: {
      hookEventName: "PreToolUse" as const,
      permissionDecision: "deny" as const,
      permissionDecisionReason: reason,
    },
  });
  return {
    matcher: CONFINED_TOOLS.join("|"),
    hooks: [
      async (input) => {
        const { tool_name: name, tool_input: args } = input as {
          tool_name?: string;
          tool_input?: Record<string, unknown>;
        };
        const paths: string[] = [];
        if (name === "Read") paths.push(String(args?.file_path ?? ""));
        else {
          if (typeof args?.path === "string" && args.path) paths.push(args.path);
          // Glob patterns can name folders too ("/etc/*", "../**").
          for (const key of ["pattern", "glob"]) {
            const value = args?.[key];
            if (typeof value !== "string" || (name === "Grep" && key === "pattern")) continue;
            if (value.split(/[/\\]/).includes("..")) return deny("Patterns can't leave the working folder.");
            if (path.isAbsolute(value)) paths.push(value.replace(/[*?[{].*$/, "") || "/");
          }
        }
        for (const p of paths) {
          if (!p || !(await isInside(cwd, p))) {
            return deny(`Only files in the working folder (${cwd}) can be read; use the workspace file tools for anything else.`);
          }
        }
        return {};
      },
    ],
  };
}

/** What Claude is told about the folder in a run that has one. */
export function workdirPrompt(summary: WorkdirSummary, scripts: boolean): string {
  const lines = [
    "",
    "Working folder: the current directory holds workspace/, a read-only copy of every workspace",
    "file the user can read, taken when this message started: workspace/root/ (the workspace root),",
    "workspace/nodes/<node>/<child>/ (knowledge nodes by name) and workspace/experiments/<title> (<id>)/.",
    "workspace/.places.json maps each folder to its node or experiment id and the user's role there.",
    `It has ${summary.files} files; files too large to copy are listed under "skipped" there.`,
    "Use Glob and Grep to find things in it and Read to read them (paths relative to the current",
    "directory, e.g. workspace/root/notes/welcome.md). To change a file, use write_file with that",
    "place's node or experiment id; never assume a change to the copy is saved.",
  ];
  if (scripts) {
    lines.push(
      "Skill scripts run in Bash in this folder and can read workspace/ but not change it. Files a",
      "script makes elsewhere in this folder (e.g. out/plot.png) are not saved until you call save_file.",
    );
  }
  return lines.join("\n");
}
