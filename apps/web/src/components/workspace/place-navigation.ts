import type { PlaceId, ServerFile } from "./server-files";
import type { StorageMode } from "./save-scheduler";

interface Navigation {
  getMode: () => StorageMode;
  getPlace: () => PlaceId;
  list: (place: PlaceId) => Promise<ServerFile[] | "starting" | null>;
  apply: (place: PlaceId, files: ServerFile[]) => Promise<void>;
}

/** Only the newest requested move may commit its fetched file list. */
export function createPlaceNavigator(options: Navigation) {
  let moves = 0;
  return async (place: PlaceId): Promise<boolean> => {
    if (options.getMode() !== "server") return false;
    if (place === options.getPlace()) return true;
    const move = ++moves;
    const files = await options.list(place);
    if (move !== moves || !Array.isArray(files)) return false;
    await options.apply(place, files);
    return true;
  };
}
