import type { LineRange } from "./file-refs";
import type { TabId } from "./types";

/** Lines the middle pane scrolls to and highlights, from open(path, lines). */
export interface Reveal { path: string; lines: LineRange }
export interface FileFocus { selection: string; openCount: number; reveal: Reveal | null }
export const INITIAL_FILE_FOCUS: FileFocus = { selection: "", openCount: 0, reveal: null };
export type FocusAction =
  | { type: "selection"; text: string }
  | { type: "activate" }
  | { type: "open"; tab: TabId; lines?: LineRange }
  | { type: "edit"; path: string }
  | { type: "reset" };

/** Selection belongs to the active file; line citations become stale after edits. */
export function reduceFileFocus(state: FileFocus, action: FocusAction): FileFocus {
  switch (action.type) {
    case "selection": return { ...state, selection: action.text };
    case "activate": return { ...state, selection: "" };
    case "open": return {
      selection: "", openCount: state.openCount + 1,
      reveal: action.lines ? { path: action.tab, lines: action.lines } : null,
    };
    case "edit": return state.reveal?.path === action.path ? { ...state, reveal: null } : state;
    case "reset": return { ...state, selection: "", reveal: null };
  }
}
