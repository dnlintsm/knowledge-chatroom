/**
 * Choosing a workspace (issue #226, docs/workspaces.md, "Screens"): the
 * switcher's lists, the workspaces this browser opened last, and a new
 * workspace's address. Client-safe and without React, so the unit tests can
 * call it directly.
 */

import type { WorkspaceInfo } from "./workspace-request";

/** A workspace's page. */
export const workspacePath = (slug: string) => `/w/${encodeURIComponent(slug)}`;

/** The most a slug can be, as the API server takes it (services/api-py/api_py/workspaces.py). */
export const SLUG_MAX = 48;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Whether `value` is an address someone can ask for: lower-case letters and digits in dash-separated runs. */
export function isSlug(value: string): boolean {
  return value.length <= SLUG_MAX && SLUG.test(value);
}

/**
 * The address made from a workspace's name, as the API server makes it when
 * none is asked for: accents dropped, everything else not a letter or digit a
 * dash. Empty when nothing is left (the server then says "workspace").
 */
export function slugify(name: string): string {
  const ascii = name.normalize("NFKD").replace(/[\u0080-\uffff]/g, "");
  return ascii
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX)
    .replace(/-+$/, "");
}

/** The knowledge levels a new workspace can start with. */
export const STARTING_LEVELS = {
  standard: ["tech", "module", "loop", "process"],
  empty: [],
} as const satisfies Record<string, readonly string[]>;
export type StartingLevels = keyof typeof STARTING_LEVELS;

// --- The workspaces this browser opened last, per user ---------------------

/** Per user: the ids of the workspaces opened in this browser, the last first. */
export const RECENT_KEY = "knowledge-chatroom.workspaces.recent.v1";
const KEPT = 8;

type BrowserStorage = Pick<Storage, "getItem" | "setItem">;

const recentKey = (user: string) => `${RECENT_KEY}@${encodeURIComponent(user)}`;

/** The ids of the workspaces `user` opened in this browser, the last first. */
export function readRecent(storage: BrowserStorage, user: string): string[] {
  try {
    const list: unknown = JSON.parse(storage.getItem(recentKey(user)) ?? "[]");
    return Array.isArray(list) ? list.filter((id): id is string => typeof id === "string").slice(0, KEPT) : [];
  } catch {
    return [];
  }
}

/** Notes that `user` opened workspace `id` just now. */
export function recordVisit(storage: BrowserStorage, user: string, id: string): void {
  const list = [id, ...readRecent(storage, user).filter((other) => other !== id)].slice(0, KEPT);
  storage.setItem(recentKey(user), JSON.stringify(list));
}

/**
 * What the switcher lists: up to three workspaces opened lately, other than
 * the current one and only those the user still belongs to; then all of
 * them, in the server's order (the default first, then by name).
 */
export function switcherSections(
  all: WorkspaceInfo[],
  recentIds: string[],
  currentId: string | null,
): { recent: WorkspaceInfo[]; all: WorkspaceInfo[] } {
  const byId = new Map(all.map((w) => [w.id, w]));
  const recent = recentIds
    .filter((id) => id !== currentId)
    .flatMap((id) => byId.get(id) ?? [])
    .slice(0, 3);
  // A short list needs no second look at the same names.
  return { recent: all.length > 5 ? recent : [], all };
}

/** What a workspace role is called on screen. */
export const MEMBER_ROLE_LABEL: Record<WorkspaceInfo["role"], string> = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
};
