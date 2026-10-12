import type { TabId, WorkspaceFile } from "./types";

export interface PersistedWorkspace {
  files: WorkspaceFile[];
  tabs: TabId[];
  active: TabId | null;
}

export type WorkspaceAction =
  | { type: "upsert"; file: WorkspaceFile }
  | { type: "remove"; path: string }
  | { type: "open"; tab: TabId }
  | { type: "close"; tab: TabId };

/** File/tab transitions, independent of storage, network and React effects. */
export function reduceWorkspace(state: PersistedWorkspace, action: WorkspaceAction): PersistedWorkspace {
  switch (action.type) {
    case "upsert":
      return {
        ...state,
        files: state.files.some((file) => file.path === action.file.path)
          ? state.files.map((file) => file.path === action.file.path ? action.file : file)
          : [...state.files, action.file],
      };
    case "remove": {
      const tabs = state.tabs.filter((tab) => tab !== action.path);
      return {
        files: state.files.filter((file) => file.path !== action.path),
        tabs,
        active: state.active === action.path ? (tabs[tabs.length - 1] ?? null) : state.active,
      };
    }
    case "open":
      return {
        ...state,
        tabs: state.tabs.includes(action.tab) ? state.tabs : [...state.tabs, action.tab],
        active: action.tab,
      };
    case "close": {
      const index = state.tabs.indexOf(action.tab);
      const tabs = state.tabs.filter((tab) => tab !== action.tab);
      return {
        ...state,
        tabs,
        active: state.active === action.tab
          ? (tabs[Math.min(index, tabs.length - 1)] ?? null)
          : state.active,
      };
    }
  }
}
