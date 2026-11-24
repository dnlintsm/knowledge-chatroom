import type { PlaceId } from "./server-files";
import { parsePersistedWorkspace, parseTabState, type PersistedWorkspace } from "./workspace-state";

export const INVALID_STORAGE_KEY = "knowledge-chatroom.workspace.v1.invalid";
export const STORAGE_KEY = "knowledge-chatroom.workspace.v1";
const SERVER_UI_KEY = "knowledge-chatroom.workspace.server-ui.v1";
export const PLACE_UI_KEY = "knowledge-chatroom.workspace.place-ui.v1";
export const NODE_KEY = "knowledge-chatroom.workspace.node.v1";
/** "1" when seeded, or a JSON list of paths to retry uploading on reload. */
export const SERVER_SEEDED_KEY = "knowledge-chatroom.workspace.server-seeded.v1";
/** Folders collapsed in the file tree, per place: { [place]: paths }. */
export const COLLAPSED_FOLDERS_KEY = "knowledge-chatroom.workspace.collapsed-folders.v1";

type BrowserStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/**
 * The keys whose state belongs to one workspace's content (its files, tabs,
 * places and folders). With workspaces each user keeps them per
 * workspace; the rest (layout, steps mode, tool chips) stay for the browser.
 */
const WORKSPACE_KEYS: ReadonlySet<string> = new Set([
  STORAGE_KEY,
  INVALID_STORAGE_KEY,
  SERVER_UI_KEY,
  PLACE_UI_KEY,
  NODE_KEY,
  SERVER_SEEDED_KEY,
  COLLAPSED_FOLDERS_KEY,
]);

/** Whose state in which workspace the page keeps; null without workspaces (the keys as before). */
export interface SavedStateScope {
  /** The signed-in user's login subject, or "local" without login. */
  user: string;
  /** The workspace's id. */
  workspace: string;
  /** The default workspace, which takes over the state saved before workspaces. */
  isDefault: boolean;
}

let scope: SavedStateScope | null = null;

/** A workspace key as kept for `s`, e.g. "knowledge-chatroom.workspace.node.v1@<user>/<workspace id>". */
export function scopedKey(key: string, s: SavedStateScope | null): string {
  return s && WORKSPACE_KEYS.has(key) ? `${key}@${encodeURIComponent(s.user)}/${s.workspace}` : key;
}

/** `storage` with the workspace keys kept per user and workspace (`s`, the page's by default). */
export function scopedStorage(storage: BrowserStorage, s: SavedStateScope | null = scope): BrowserStorage {
  if (!s) return storage;
  return {
    getItem: (key) => storage.getItem(scopedKey(key, s)),
    setItem: (key, value) => storage.setItem(scopedKey(key, s), value),
    removeItem: (key) => storage.removeItem(scopedKey(key, s)),
  };
}

/**
 * Moves what this browser saved before workspaces into the default workspace,
 * for the first user who opens it here (docs/workspaces.md, decision 5).
 * Moved, not copied, so it happens once; state already saved there wins.
 */
export function moveLegacyState(storage: BrowserStorage, s: SavedStateScope) {
  if (!s.isDefault) return;
  for (const key of WORKSPACE_KEYS) {
    const legacy = storage.getItem(key);
    if (legacy === null) continue;
    const target = scopedKey(key, s);
    if (storage.getItem(target) === null) storage.setItem(target, legacy);
    storage.removeItem(key);
  }
}

/** Keeps the page's saved state for `s` from now on (src/app/home.tsx, before the workspace mounts). */
export function setSavedStateScope(s: SavedStateScope | null) {
  scope = s;
  if (!s) return;
  try {
    moveLegacyState(window.localStorage, s);
  } catch {
    // Site storage blocked or full: nothing saved to move.
  }
}

/** Whose state in which workspace the page keeps now; null without workspaces. */
export function savedStateScope(): SavedStateScope | null {
  return scope;
}

/**
 * This browser's localStorage for the page's workspace: its workspace keys
 * kept per user and workspace. Throws, as localStorage does, when the browser
 * blocks site storage.
 */
export function savedState(): BrowserStorage {
  return scopedStorage(window.localStorage);
}
type PlaceUi = Record<string, Pick<PersistedWorkspace, "tabs" | "active">>;

/** Keep the original persisted format and legacy root-tabs fallback. */
export function readPlaceUi(storage: BrowserStorage): PlaceUi {
  try {
    const all = JSON.parse(storage.getItem(PLACE_UI_KEY) ?? "null") as PlaceUi | null;
    if (all && typeof all === "object" && !Array.isArray(all)) {
      return Object.fromEntries(Object.entries(all).flatMap(([place, saved]) => {
        const ui = parseTabState(saved);
        return ui ? [[place, ui]] : [];
      }));
    }
    const root = JSON.parse(storage.getItem(SERVER_UI_KEY) ?? "null");
    const ui = parseTabState(root);
    return ui ? { "": ui } : {};
  } catch {
    return {};
  }
}

export function restoreWorkspace(storage: BrowserStorage): PersistedWorkspace | null {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const restored = parsePersistedWorkspace(JSON.parse(raw));
    if (!restored) storage.setItem(INVALID_STORAGE_KEY, raw);
    return restored;
  } catch {
    return null;
  }
}

/** Server mode persists UI state only; the caller handles quota/access errors. */
export function persistWorkspace(
  storage: BrowserStorage,
  state: PersistedWorkspace,
  mode: "local" | "server",
  place: PlaceId,
) {
  if (mode === "local") {
    const raw = storage.getItem(STORAGE_KEY);
    if (raw) {
      let valid = false;
      try { valid = parsePersistedWorkspace(JSON.parse(raw)) !== null; }
      catch { /* Preserve unreadable data before replacing it. */ }
      if (!valid) storage.setItem(INVALID_STORAGE_KEY, raw);
    }
    storage.setItem(STORAGE_KEY, JSON.stringify(state));
    return;
  }
  const ui = readPlaceUi(storage);
  ui[place ?? ""] = { tabs: state.tabs, active: state.active };
  storage.setItem(PLACE_UI_KEY, JSON.stringify(ui));
  if (place) storage.setItem(NODE_KEY, place);
  else storage.removeItem(NODE_KEY);
}

function readAllCollapsed(storage: BrowserStorage): Record<string, string[]> {
  try {
    const all = JSON.parse(storage.getItem(COLLAPSED_FOLDERS_KEY) ?? "null");
    if (!all || typeof all !== "object" || Array.isArray(all)) return {};
    return Object.fromEntries(Object.entries(all).flatMap(([place, paths]) =>
      Array.isArray(paths) ? [[place, paths.filter((p): p is string => typeof p === "string")]] : []));
  } catch {
    return {};
  }
}

/** The folders collapsed in this place's file tree; everything else is open. */
export function readCollapsedFolders(storage: BrowserStorage, place: PlaceId): string[] {
  return readAllCollapsed(storage)[place ?? ""] ?? [];
}

/** Storage may be unavailable or full; the tree then only remembers until reload. */
export function persistCollapsedFolders(storage: BrowserStorage, place: PlaceId, paths: string[]) {
  try {
    const all = readAllCollapsed(storage);
    if (paths.length) all[place ?? ""] = [...paths].sort();
    else delete all[place ?? ""];
    storage.setItem(COLLAPSED_FOLDERS_KEY, JSON.stringify(all));
  } catch {
    // Keep the in-memory state.
  }
}
