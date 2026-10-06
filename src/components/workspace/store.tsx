"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { DEFAULT_OPEN, SEED_FILES } from "./seed";
import {
  kindForPath,
  mimeForPath,
  TASKS_TAB,
  type TabId,
  type WorkspaceFile,
} from "./types";

/**
 * Browser-side workspace state: files, open tabs, the active tab, and the
 * user's current text selection (shared with the agent as context).
 *
 * Files and tabs persist to localStorage so a reload keeps your work. This is a
 * stand-in until files live with the agent backend.
 */

const STORAGE_KEY = "knowledge-chatroom.workspace.v1";

interface Persisted {
  files: WorkspaceFile[];
  tabs: TabId[];
  active: TabId | null;
}

interface WorkspaceValue {
  files: WorkspaceFile[];
  tabs: TabId[];
  active: TabId | null;
  activeFile: WorkspaceFile | null;
  selection: string;
  /** Bumps on every open(), even of the already-active tab. */
  openCount: number;
  getFile: (path: string) => WorkspaceFile | undefined;
  open: (tab: TabId) => void;
  close: (tab: TabId) => void;
  /** Creates the file when it does not exist. */
  write: (
    path: string,
    content: string,
    opts?: { mime?: string; author?: WorkspaceFile["author"] },
  ) => WorkspaceFile;
  remove: (path: string) => void;
  setSelection: (text: string) => void;
}

const WorkspaceContext = createContext<WorkspaceValue | null>(null);

export function normalizePath(path: string) {
  return path.trim().replace(/^\/+/, "").replace(/\/+/g, "/");
}

/** False on the first render, true from the next commit on. */
export function useHydrated() {
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  return hydrated;
}

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<Persisted>({
    files: SEED_FILES,
    tabs: [DEFAULT_OPEN],
    active: DEFAULT_OPEN,
  });
  const [selection, setSelection] = useState("");
  const [openCount, setOpenCount] = useState(0);
  const hydrated = useHydrated();

  // Restore after mount so server and client render the same seed first.
  // Saving waits for `hydrated` (set in the same commit as the restore), so the
  // seed is never written over saved work, even when Strict Mode replays effects.
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw) setState(JSON.parse(raw) as Persisted);
    } catch {
      // Private mode or corrupt data: keep the seed.
    }
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      // Quota exceeded (large uploads): the session still works in memory.
    }
  }, [state, hydrated]);

  const getFile = useCallback(
    (path: string) => state.files.find((f) => f.path === normalizePath(path)),
    [state.files],
  );

  // A selection belongs to the file it was made in; drop it whenever the active
  // tab changes (open, close, or delete), so it never pairs with another file.
  useEffect(() => setSelection(""), [state.active]);

  const open = useCallback((tab: TabId) => {
    // Also when reopening the active file, e.g. after Claude rewrote it.
    setSelection("");
    setOpenCount((n) => n + 1);
    setState((s) => ({
      ...s,
      tabs: s.tabs.includes(tab) ? s.tabs : [...s.tabs, tab],
      active: tab,
    }));
  }, []);

  const close = useCallback((tab: TabId) => {
    setState((s) => {
      const index = s.tabs.indexOf(tab);
      const tabs = s.tabs.filter((t) => t !== tab);
      const active =
        s.active === tab ? (tabs[Math.min(index, tabs.length - 1)] ?? null) : s.active;
      return { ...s, tabs, active };
    });
  }, []);

  const write = useCallback<WorkspaceValue["write"]>((rawPath, content, opts) => {
    const path = normalizePath(rawPath);
    const file: WorkspaceFile = {
      path,
      content,
      kind: kindForPath(path),
      mime: opts?.mime ?? mimeForPath(path),
      author: opts?.author ?? "user",
      updatedAt: Date.now(),
    };
    setState((s) => {
      const exists = s.files.some((f) => f.path === path);
      return {
        ...s,
        files: exists
          ? s.files.map((f) => (f.path === path ? { ...f, ...file, mime: opts?.mime ?? f.mime } : f))
          : [...s.files, file],
      };
    });
    return file;
  }, []);

  const remove = useCallback((path: string) => {
    setState((s) => {
      const tabs = s.tabs.filter((t) => t !== path);
      return {
        files: s.files.filter((f) => f.path !== path),
        tabs,
        active: s.active === path ? (tabs[tabs.length - 1] ?? null) : s.active,
      };
    });
  }, []);

  const value = useMemo<WorkspaceValue>(() => {
    const activeFile =
      state.active && state.active !== TASKS_TAB
        ? (state.files.find((f) => f.path === state.active) ?? null)
        : null;
    return {
      ...state,
      activeFile,
      selection,
      openCount,
      getFile,
      open,
      close,
      write,
      remove,
      setSelection,
    };
  }, [state, selection, openCount, getFile, open, close, write, remove]);

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace() {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) throw new Error("useWorkspace must be used inside <WorkspaceProvider>");
  return ctx;
}
