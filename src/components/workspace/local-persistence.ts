import type { PlaceId } from "./server-files";
import type { PersistedWorkspace } from "./workspace-state";

export const STORAGE_KEY = "knowledge-chatroom.workspace.v1";
const SERVER_UI_KEY = "knowledge-chatroom.workspace.server-ui.v1";
export const PLACE_UI_KEY = "knowledge-chatroom.workspace.place-ui.v1";
export const NODE_KEY = "knowledge-chatroom.workspace.node.v1";
/** "1" when seeded, or a JSON list of paths to retry uploading on reload. */
export const SERVER_SEEDED_KEY = "knowledge-chatroom.workspace.server-seeded.v1";

type BrowserStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
type PlaceUi = Record<string, Pick<PersistedWorkspace, "tabs" | "active">>;

/** Keep the original persisted format and legacy root-tabs fallback. */
export function readPlaceUi(storage: BrowserStorage): PlaceUi {
  try {
    const all = JSON.parse(storage.getItem(PLACE_UI_KEY) ?? "null") as PlaceUi | null;
    if (all) return all;
    const root = JSON.parse(storage.getItem(SERVER_UI_KEY) ?? "null");
    return root ? { "": root } : {};
  } catch {
    return {};
  }
}

export function restoreWorkspace(storage: BrowserStorage): PersistedWorkspace | null {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) as PersistedWorkspace : null;
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
    storage.setItem(STORAGE_KEY, JSON.stringify(state));
    return;
  }
  const ui = readPlaceUi(storage);
  ui[place ?? ""] = { tabs: state.tabs, active: state.active };
  storage.setItem(PLACE_UI_KEY, JSON.stringify(ui));
  if (place) storage.setItem(NODE_KEY, place);
  else storage.removeItem(NODE_KEY);
}
