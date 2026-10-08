"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { LineRange } from "./file-refs";
import { DEFAULT_OPEN, SEED_FILES } from "./seed";
import {
  deleteServerFile,
  listServerFiles,
  loadServerFile,
  putServerFile,
  WATCH_URL,
  type ServerFile,
  type ServerFileEvent,
} from "./server-files";
import {
  FileExistsError,
  kindForPath,
  mimeForPath,
  ReadOnlyFileError,
  TASKS_TAB,
  type TabId,
  type WorkspaceFile,
} from "./types";

/**
 * Workspace state: files, open tabs, the active tab, and the user's current
 * text selection (shared with the agent as context).
 *
 * Files live in one of two places, picked on load:
 * - "server": the storage API answers (DATABASE_URL set on the agent). Files
 *   load from it, edits save to it (debounced, so typing doesn't create a
 *   version per keystroke), and its change stream brings in writes from Claude
 *   or other tabs. Files Claude writes open automatically.
 * - "local": no storage server, so files persist to localStorage as before.
 * Open tabs always stay in localStorage; they are per-browser UI state.
 */

const STORAGE_KEY = "knowledge-chatroom.workspace.v1";
const SERVER_UI_KEY = "knowledge-chatroom.workspace.server-ui.v1";
/**
 * "1" once this browser has filled an empty server workspace, or a JSON list of
 * paths whose upload failed and is retried on the next load.
 */
const SERVER_SEEDED_KEY = "knowledge-chatroom.workspace.server-seeded.v1";
const SAVE_DELAY_MS = 600;
/** How long to wait for storage that is still starting before using the browser. */
const STARTUP_RETRY_MS = 2_000;
const STARTUP_RETRIES = 30;

export type StorageMode = "loading" | "server" | "local";

interface Persisted {
  files: WorkspaceFile[];
  tabs: TabId[];
  active: TabId | null;
}

/** Lines the middle pane scrolls to and highlights, from open(path, lines). */
export interface Reveal {
  path: string;
  lines: LineRange;
}

interface WorkspaceValue {
  files: WorkspaceFile[];
  tabs: TabId[];
  active: TabId | null;
  activeFile: WorkspaceFile | null;
  selection: string;
  /** Bumps on every open(), even of the already-active tab. */
  openCount: number;
  /** Set by the last open() that named lines; cleared by any other open or an edit to that file. */
  reveal: Reveal | null;
  getFile: (path: string) => WorkspaceFile | undefined;
  /** Opens a tab; with `lines`, the middle pane also brings those lines into view. */
  open: (tab: TabId, lines?: LineRange) => void;
  close: (tab: TabId) => void;
  /** Creates the file when it does not exist. Throws ReadOnlyFileError for a read-only file. */
  write: (
    path: string,
    content: string,
    opts?: { mime?: string; author?: WorkspaceFile["author"] },
  ) => WorkspaceFile;
  /**
   * Creates a new file, saved right away (not debounced). Throws
   * FileExistsError when the path is taken, here or on the server, which
   * decides when two tabs race. `readOnly` files can never change afterwards.
   */
  create: (
    path: string,
    content: string,
    opts?: { mime?: string; author?: WorkspaceFile["author"]; readOnly?: boolean },
  ) => Promise<WorkspaceFile>;
  /** Throws ReadOnlyFileError for a read-only file. */
  remove: (path: string) => void;
  setSelection: (text: string) => void;
  /** Where files are kept; see the comment at the top of this file. */
  storageMode: StorageMode;
  /** The last failed save, cleared by the next successful one. */
  syncError: string | null;
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
  const [reveal, setReveal] = useState<Reveal | null>(null);
  const hydrated = useHydrated();

  const [storageMode, setStorageMode] = useState<StorageMode>("loading");
  const [syncError, setSyncError] = useState<string | null>(null);
  const mode = useRef<StorageMode>("loading");
  const files = useRef(state.files);
  files.current = state.files;
  // Server sync bookkeeping, per path: the content hash we last saw on the
  // server, edits waiting to save, and saves on the wire. Change events for a
  // path with local edits pending are ignored, so they can't overwrite typing.
  const knownSha = useRef(new Map<string, string>());
  const pending = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const inflight = useRef(new Map<string, number>());
  const busy = (path: string) =>
    pending.current.has(path) || (inflight.current.get(path) ?? 0) > 0;

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
    if (!hydrated || storageMode === "loading") return;
    try {
      if (storageMode === "local") {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      } else {
        window.localStorage.setItem(
          SERVER_UI_KEY,
          JSON.stringify({ tabs: state.tabs, active: state.active }),
        );
      }
    } catch {
      // Quota exceeded (large uploads): the session still works in memory.
    }
  }, [state, hydrated, storageMode]);

  const upsert = useCallback((file: WorkspaceFile) => {
    setState((s) => ({
      ...s,
      files: s.files.some((f) => f.path === file.path)
        ? s.files.map((f) => (f.path === file.path ? file : f))
        : [...s.files, file],
    }));
  }, []);

  const removeLocal = useCallback((path: string) => {
    setState((s) => {
      const tabs = s.tabs.filter((t) => t !== path);
      return {
        files: s.files.filter((f) => f.path !== path),
        tabs,
        active: s.active === path ? (tabs[tabs.length - 1] ?? null) : s.active,
      };
    });
  }, []);

  const save = useCallback(async (path: string): Promise<void> => {
    // Edits made while storage is still being picked wait for the decision.
    if (mode.current === "loading") {
      pending.current.set(path, setTimeout(() => void save(path), SAVE_DELAY_MS));
      return;
    }
    pending.current.delete(path);
    if (mode.current === "local") return; // localStorage already has it.
    const file = files.current.find((f) => f.path === path);
    if (!file) return;
    inflight.current.set(path, (inflight.current.get(path) ?? 0) + 1);
    try {
      const info = await putServerFile(file);
      knownSha.current.set(path, info.sha256);
      setSyncError(null);
    } catch (err) {
      console.error("[workspace] save failed:", err);
      setSyncError(`Couldn't save ${path}`);
    } finally {
      inflight.current.set(path, (inflight.current.get(path) ?? 1) - 1);
    }
  }, []);

  const scheduleSave = useCallback(
    (path: string) => {
      clearTimeout(pending.current.get(path));
      pending.current.set(path, setTimeout(() => void save(path), SAVE_DELAY_MS));
    },
    [save],
  );

  // Brings local files in line with the server's list: fetches what changed,
  // drops what was deleted, and leaves files with unsaved edits alone, also
  // when the user starts editing while the fetches are in flight. `keep` names
  // files that aren't on the server but must stay (failed first uploads).
  const resync = useCallback(async (list: ServerFile[], keep = new Set<string>()) => {
    const local = new Map(files.current.map((f) => [f.path, f]));
    const next = await Promise.all(
      list.map(async (info) => {
        const mine = local.get(info.path);
        if (mine && (busy(info.path) || knownSha.current.get(info.path) === info.sha256)) {
          return mine;
        }
        knownSha.current.set(info.path, info.sha256);
        return loadServerFile(info);
      }),
    );
    const listed = new Set(list.map((f) => f.path));
    const latest = new Map(files.current.map((f) => [f.path, f]));
    const unsaved = files.current.filter(
      (f) => !listed.has(f.path) && (busy(f.path) || keep.has(f.path)),
    );
    setState((s) => {
      const all = [
        ...next.map((f) => (busy(f.path) ? (latest.get(f.path) ?? f) : f)),
        ...unsaved,
      ];
      const exists = new Set(all.map((f) => f.path));
      const tabs = s.tabs.filter((t) => t === TASKS_TAB || exists.has(t));
      const active = s.active && tabs.includes(s.active) ? s.active : (tabs[0] ?? null);
      return { files: all, tabs, active };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Pick server or local storage once, after the local restore above.
  useEffect(() => {
    let events: EventSource | null = null;
    let cancelled = false;

    const onEvent = async (event: ServerFileEvent) => {
      const { path } = event;
      if (busy(path)) return;
      if (event.op === "delete") {
        knownSha.current.delete(path);
        removeLocal(path);
        return;
      }
      if (knownSha.current.get(path) === event.sha256) return; // Our own save.
      const list = await listServerFiles();
      const info = Array.isArray(list) ? list.find((f) => f.path === path) : undefined;
      if (!info || busy(path)) return;
      const file = await loadServerFile(info);
      // The user may have started editing this file while it loaded.
      if (busy(path)) return;
      knownSha.current.set(path, info.sha256);
      upsert(file);
      if (info.author === "agent") open(path);
    };

    const useLocal = () => {
      mode.current = "local";
      setStorageMode("local");
    };

    (async () => {
      // Storage answers 503 while it migrates on startup; give it a moment.
      let list = await listServerFiles();
      for (let i = 0; list === "starting" && i < STARTUP_RETRIES; i++) {
        await new Promise((r) => setTimeout(r, STARTUP_RETRY_MS));
        if (cancelled) return;
        list = await listServerFiles();
      }
      if (cancelled) return;
      if (!Array.isArray(list)) return useLocal();

      // First visit to an empty server: bring over this browser's files (or
      // the samples), so nothing made before storage existed is lost. Uploads
      // that fail stay visible, are reported, and are retried on the next load.
      const seeded = window.localStorage.getItem(SERVER_SEEDED_KEY);
      const retry: string[] = seeded && seeded !== "1" ? JSON.parse(seeded) : [];
      const toUpload =
        seeded === null && list.length === 0
          ? files.current
          : files.current.filter((f) => retry.includes(f.path));
      let failed: string[] = [];
      if (toUpload.length) {
        failed = (
          await Promise.all(toUpload.map((f) => putServerFile(f).then(() => null, () => f.path)))
        ).filter((p): p is string => p !== null);
        const again = await listServerFiles();
        if (Array.isArray(again)) list = again;
        if (failed.length) setSyncError(`Couldn't upload ${failed.join(", ")}; retrying on reload`);
      }
      if (seeded === null || toUpload.length) {
        window.localStorage.setItem(SERVER_SEEDED_KEY, failed.length ? JSON.stringify(failed) : "1");
      }
      try {
        const ui = JSON.parse(window.localStorage.getItem(SERVER_UI_KEY) ?? "null");
        if (ui) setState((s) => ({ ...s, tabs: ui.tabs, active: ui.active }));
      } catch {}

      await resync(list, new Set(failed));
      if (cancelled) return;
      mode.current = "server";
      setStorageMode("server");

      events = new EventSource(WATCH_URL);
      events.onmessage = (e) => void onEvent(JSON.parse(e.data) as ServerFileEvent).catch(() => {});
      // The browser reconnects by itself; catch up on anything missed meanwhile.
      let dropped = false;
      events.onerror = () => (dropped = true);
      events.onopen = () => {
        if (!dropped) return;
        dropped = false;
        void listServerFiles().then((l) => {
          if (Array.isArray(l)) void resync(l);
        });
      };
    })().catch((err) => {
      console.error("[workspace] server storage failed to load:", err);
      useLocal();
    });

    return () => {
      cancelled = true;
      events?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Don't lose an edit still waiting to save when the tab closes.
  useEffect(() => {
    const flush = () => {
      for (const path of [...pending.current.keys()]) {
        clearTimeout(pending.current.get(path));
        void save(path);
      }
    };
    window.addEventListener("pagehide", flush);
    return () => window.removeEventListener("pagehide", flush);
  }, [save]);

  const getFile = useCallback(
    (path: string) => state.files.find((f) => f.path === normalizePath(path)),
    [state.files],
  );

  // A selection belongs to the file it was made in; drop it whenever the active
  // tab changes (open, close, or delete), so it never pairs with another file.
  useEffect(() => setSelection(""), [state.active]);

  const open = useCallback((tab: TabId, lines?: LineRange) => {
    // Also when reopening the active file, e.g. after Claude rewrote it.
    setSelection("");
    setOpenCount((n) => n + 1);
    // A new object every time, so citing the same lines again scrolls back to them.
    setReveal(lines ? { path: tab, lines } : null);
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

  const write = useCallback<WorkspaceValue["write"]>(
    (rawPath, content, opts) => {
      const path = normalizePath(rawPath);
      const existing = files.current.find((f) => f.path === path);
      if (existing?.readOnly) throw new ReadOnlyFileError(path);
      const file: WorkspaceFile = {
        path,
        content,
        kind: kindForPath(path),
        mime: opts?.mime ?? existing?.mime ?? mimeForPath(path),
        author: opts?.author ?? "user",
        updatedAt: Date.now(),
      };
      // Keep the ref current too, so a save scheduled now sends this content.
      files.current = existing
        ? files.current.map((f) => (f.path === path ? file : f))
        : [...files.current, file];
      upsert(file);
      if (mode.current !== "local") scheduleSave(path);
      // Line numbers may now point at different text.
      setReveal((r) => (r?.path === path ? null : r));
      return file;
    },
    [upsert, scheduleSave],
  );

  const create = useCallback<WorkspaceValue["create"]>(
    async (rawPath, content, opts) => {
      const path = normalizePath(rawPath);
      if (mode.current === "loading") throw new Error("Files are still loading");
      if (files.current.some((f) => f.path === path)) throw new FileExistsError(path);
      const file: WorkspaceFile = {
        path,
        content,
        kind: kindForPath(path),
        mime: opts?.mime ?? mimeForPath(path),
        author: opts?.author ?? "user",
        updatedAt: Date.now(),
        ...(opts?.readOnly ? { readOnly: true } : {}),
      };
      if (mode.current === "server") {
        // Counted as in flight, so the change event for this write is ignored.
        inflight.current.set(path, (inflight.current.get(path) ?? 0) + 1);
        let lost = false;
        try {
          const info = await putServerFile(file, { createOnly: true, readOnly: opts?.readOnly });
          knownSha.current.set(path, info.sha256);
        } catch (err) {
          if (!(err instanceof FileExistsError)) throw err;
          lost = true;
        } finally {
          inflight.current.set(path, (inflight.current.get(path) ?? 1) - 1);
        }
        if (lost) {
          // Another tab or browser won. Its change event was ignored while this
          // write was in flight, so load its file now, before callers open it.
          const list = await listServerFiles();
          if (Array.isArray(list)) await resync(list);
          throw new FileExistsError(path);
        }
      }
      // A resync may have brought the new file in meanwhile; this is the same file.
      files.current = [...files.current.filter((f) => f.path !== path), file];
      upsert(file);
      return file;
    },
    [upsert, resync],
  );

  const remove = useCallback(
    (path: string) => {
      if (files.current.find((f) => f.path === path)?.readOnly) throw new ReadOnlyFileError(path);
      removeLocal(path);
      if (mode.current !== "server") return;
      clearTimeout(pending.current.get(path));
      pending.current.delete(path);
      knownSha.current.delete(path);
      deleteServerFile(path).catch((err) => {
        console.error("[workspace] delete failed:", err);
        setSyncError(`Couldn't delete ${path}`);
      });
    },
    [removeLocal],
  );

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
      reveal,
      getFile,
      open,
      close,
      write,
      create,
      remove,
      setSelection,
      storageMode,
      syncError,
    };
  }, [state, selection, openCount, reveal, getFile, open, close, write, create, remove, storageMode, syncError]);

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace() {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) throw new Error("useWorkspace must be used inside <WorkspaceProvider>");
  return ctx;
}
