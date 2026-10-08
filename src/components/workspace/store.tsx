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
  createServerNode,
  deleteServerFile,
  deleteServerNode,
  listNodes,
  listServerFiles,
  loadServerFile,
  putServerFile,
  renameServerNode,
  WATCH_URL,
  type KnowledgeNode,
  type NodeId,
  type NodeType,
  type ServerEvent,
  type ServerFile,
} from "./server-files";
import {
  kindForPath,
  mimeForPath,
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
 *
 * With server storage the workspace also has a knowledge tree (tech › module ›
 * loop › process). The user is always in one place, the workspace root or a
 * node, and `files` holds that place's files; enterNode() moves elsewhere.
 * Each place keeps its own tabs.
 */

const STORAGE_KEY = "knowledge-chatroom.workspace.v1";
/** Tabs at the workspace root, from before the knowledge tree. */
const SERVER_UI_KEY = "knowledge-chatroom.workspace.server-ui.v1";
/** Tabs per place: {"": root, "<node id>": that node}. */
const PLACE_UI_KEY = "knowledge-chatroom.workspace.place-ui.v1";
/** The node the user was last in, so a reload returns there. */
const NODE_KEY = "knowledge-chatroom.workspace.node.v1";
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
  /** Creates the file when it does not exist. */
  write: (
    path: string,
    content: string,
    opts?: { mime?: string; author?: WorkspaceFile["author"] },
  ) => WorkspaceFile;
  remove: (path: string) => void;
  setSelection: (text: string) => void;
  /** Where files are kept; see the comment at the top of this file. */
  storageMode: StorageMode;
  /** The last failed save, cleared by the next successful one. */
  syncError: string | null;
  /** Where the user is: a knowledge node, or null for the workspace root. */
  node: NodeId;
  /** The current node and its ancestors, top level first; empty at the root. */
  lineage: KnowledgeNode[];
  /** The knowledge tree (server storage only). */
  nodes: KnowledgeNode[];
  nodeTypes: NodeType[];
  /** Moves to a node (null = root) and loads its files; false if it's gone. */
  enterNode: (id: NodeId) => Promise<boolean>;
  /** These throw with a message for the user, e.g. a duplicate name. */
  createNode: (parentId: NodeId, name: string) => Promise<KnowledgeNode>;
  renameNode: (id: string, name: string) => Promise<void>;
  deleteNode: (id: string) => Promise<void>;
}

type PlaceUi = Record<string, Pick<Persisted, "tabs" | "active">>;

function readPlaceUi(): PlaceUi {
  try {
    const all = JSON.parse(window.localStorage.getItem(PLACE_UI_KEY) ?? "null") as PlaceUi | null;
    if (all) return all;
    const root = JSON.parse(window.localStorage.getItem(SERVER_UI_KEY) ?? "null");
    return root ? { "": root } : {};
  } catch {
    return {};
  }
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
  const [node, setNode] = useState<NodeId>(null);
  const nodeRef = useRef<NodeId>(null);
  const [tree, setTree] = useState<{ types: NodeType[]; nodes: KnowledgeNode[] }>({
    types: [],
    nodes: [],
  });
  // Server sync bookkeeping, per place and path: the content hash we last saw
  // on the server, edits waiting to save, and saves on the wire. Change events
  // for a file with local edits pending are ignored, so they can't overwrite
  // typing.
  const knownSha = useRef(new Map<string, string>());
  const pending = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const inflight = useRef(new Map<string, number>());
  const key = (path: string, at: NodeId = nodeRef.current) => `${at ?? ""}\n${path}`;
  const busy = (path: string, at: NodeId = nodeRef.current) =>
    pending.current.has(key(path, at)) || (inflight.current.get(key(path, at)) ?? 0) > 0;

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
        const ui = readPlaceUi();
        ui[node ?? ""] = { tabs: state.tabs, active: state.active };
        window.localStorage.setItem(PLACE_UI_KEY, JSON.stringify(ui));
        if (node) window.localStorage.setItem(NODE_KEY, node);
        else window.localStorage.removeItem(NODE_KEY);
      }
    } catch {
      // Quota exceeded (large uploads): the session still works in memory.
    }
  }, [state, hydrated, storageMode, node]);

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

  const save = useCallback(async (path: string, at: NodeId): Promise<void> => {
    const k = key(path, at);
    // Edits made while storage is still being picked wait for the decision.
    if (mode.current === "loading") {
      pending.current.set(k, setTimeout(() => void save(path, at), SAVE_DELAY_MS));
      return;
    }
    pending.current.delete(k);
    if (mode.current === "local") return; // localStorage already has it.
    // Leaving a place flushes its saves first, so its files are still loaded here.
    if (at !== nodeRef.current) return;
    const file = files.current.find((f) => f.path === path);
    if (!file) return;
    inflight.current.set(k, (inflight.current.get(k) ?? 0) + 1);
    try {
      const info = await putServerFile(file, at);
      knownSha.current.set(k, info.sha256);
      setSyncError(null);
    } catch (err) {
      console.error("[workspace] save failed:", err);
      setSyncError(`Couldn't save ${path}`);
    } finally {
      inflight.current.set(k, (inflight.current.get(k) ?? 1) - 1);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const scheduleSave = useCallback(
    (path: string) => {
      const at = nodeRef.current;
      clearTimeout(pending.current.get(key(path, at)));
      pending.current.set(key(path, at), setTimeout(() => void save(path, at), SAVE_DELAY_MS));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [save],
  );

  /** Sends every edit still waiting to save, now. */
  const flushSaves = useCallback(() => {
    for (const [k, timer] of [...pending.current]) {
      clearTimeout(timer);
      const split = k.indexOf("\n");
      void save(k.slice(split + 1), k.slice(0, split) || null);
    }
  }, [save]);

  // Brings local files in line with the server's list: fetches what changed,
  // drops what was deleted, and leaves files with unsaved edits alone, also
  // when the user starts editing while the fetches are in flight. `keep` names
  // files that aren't on the server but must stay (failed first uploads).
  const resync = useCallback(async (list: ServerFile[], keep = new Set<string>()) => {
    const at = nodeRef.current;
    const local = new Map(files.current.map((f) => [f.path, f]));
    const next = await Promise.all(
      list.map(async (info) => {
        const mine = local.get(info.path);
        if (mine && (busy(info.path) || knownSha.current.get(key(info.path)) === info.sha256)) {
          return mine;
        }
        const file = await loadServerFile(info, at);
        knownSha.current.set(key(info.path, at), info.sha256);
        return file;
      }),
    );
    // The user moved elsewhere meanwhile; that move loads its own files.
    if (nodeRef.current !== at) return;
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

  const refreshTree = useCallback(async () => {
    const next = await listNodes();
    if (next) setTree(next);
    return next?.nodes ?? null;
  }, []);

  // Counts the latest move, so an older one that finishes late does nothing.
  const moves = useRef(0);
  const enterNode = useCallback(
    async (id: NodeId): Promise<boolean> => {
      if (mode.current !== "server") return false;
      if (id === nodeRef.current) return true;
      const move = ++moves.current;
      const list = await listServerFiles(id);
      if (move !== moves.current || !Array.isArray(list)) return false;
      flushSaves();
      nodeRef.current = id;
      setNode(id);
      const ui = readPlaceUi()[id ?? ""] ?? { tabs: [], active: null };
      files.current = [];
      setState({ files: [], tabs: ui.tabs, active: ui.active });
      setSelection("");
      setReveal(null);
      await resync(list);
      return true;
    },
    [flushSaves, resync],
  );

  // Pick server or local storage once, after the local restore above.
  useEffect(() => {
    let events: EventSource | null = null;
    let cancelled = false;
    let treeTimer: ReturnType<typeof setTimeout> | undefined;

    const onEvent = async (event: ServerEvent) => {
      if (event.op === "node") {
        const nodes = await refreshTree();
        // Deleted, or under a deleted node: go back to the root.
        if (nodes && nodeRef.current && !nodes.some((n) => n.id === nodeRef.current)) {
          void enterNode(null);
        }
        return;
      }
      // File counts on the tree.
      clearTimeout(treeTimer);
      treeTimer = setTimeout(() => void refreshTree(), 300);

      const { path, node: at } = event;
      if (at !== nodeRef.current) {
        // Claude wrote somewhere else: follow it there.
        if (event.op === "write" && event.author === "agent") {
          if (await enterNode(at)) open(path);
        }
        return;
      }
      if (busy(path)) return;
      if (event.op === "delete") {
        knownSha.current.delete(key(path));
        removeLocal(path);
        return;
      }
      if (knownSha.current.get(key(path)) === event.sha256) return; // Our own save.
      const list = await listServerFiles(at);
      const info = Array.isArray(list) ? list.find((f) => f.path === path) : undefined;
      if (!info || busy(path) || nodeRef.current !== at) return;
      const file = await loadServerFile(info, at);
      // The user may have started editing this file, or moved, while it loaded.
      if (busy(path) || nodeRef.current !== at) return;
      knownSha.current.set(key(path), info.sha256);
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

      // Return to the node this browser was last in, if it still exists.
      const lastNode = window.localStorage.getItem(NODE_KEY);
      const there = lastNode ? await listServerFiles(lastNode) : null;
      if (cancelled) return;
      if (lastNode && Array.isArray(there)) {
        nodeRef.current = lastNode;
        setNode(lastNode);
        list = there;
      }
      const ui = readPlaceUi()[nodeRef.current ?? ""];
      if (ui) setState((s) => ({ ...s, tabs: ui.tabs, active: ui.active }));

      await resync(list, nodeRef.current === null ? new Set(failed) : new Set());
      if (cancelled) return;
      mode.current = "server";
      setStorageMode("server");
      void refreshTree();

      events = new EventSource(WATCH_URL);
      events.onmessage = (e) => void onEvent(JSON.parse(e.data) as ServerEvent).catch(() => {});
      // The browser reconnects by itself; catch up on anything missed meanwhile.
      let dropped = false;
      events.onerror = () => (dropped = true);
      events.onopen = () => {
        if (!dropped) return;
        dropped = false;
        void refreshTree();
        const at = nodeRef.current;
        void listServerFiles(at).then((l) => {
          if (Array.isArray(l) && nodeRef.current === at) void resync(l);
          else if (l === null && at) void enterNode(null); // The node was deleted.
        });
      };
    })().catch((err) => {
      console.error("[workspace] server storage failed to load:", err);
      useLocal();
    });

    return () => {
      cancelled = true;
      clearTimeout(treeTimer);
      events?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Don't lose an edit still waiting to save when the tab closes.
  useEffect(() => {
    window.addEventListener("pagehide", flushSaves);
    return () => window.removeEventListener("pagehide", flushSaves);
  }, [flushSaves]);

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

  const remove = useCallback(
    (path: string) => {
      removeLocal(path);
      if (mode.current !== "server") return;
      const k = key(path);
      clearTimeout(pending.current.get(k));
      pending.current.delete(k);
      knownSha.current.delete(k);
      deleteServerFile(path, nodeRef.current).catch((err) => {
        console.error("[workspace] delete failed:", err);
        setSyncError(`Couldn't delete ${path}`);
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [removeLocal],
  );

  const createNode = useCallback(
    async (parentId: NodeId, name: string) => {
      const created = await createServerNode(parentId, name);
      await refreshTree();
      return created;
    },
    [refreshTree],
  );
  const renameNode = useCallback(
    async (id: string, name: string) => {
      await renameServerNode(id, name);
      await refreshTree();
    },
    [refreshTree],
  );
  const deleteNode = useCallback(
    async (id: string) => {
      const inside = nodeRef.current !== null && lineageOf(tree.nodes, nodeRef.current).some((n) => n.id === id);
      if (inside) await enterNode(null);
      await deleteServerNode(id);
      await refreshTree();
    },
    [refreshTree, enterNode, tree.nodes],
  );

  const lineage = useMemo(() => (node ? lineageOf(tree.nodes, node) : []), [tree.nodes, node]);

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
      remove,
      setSelection,
      storageMode,
      syncError,
      node,
      lineage,
      nodes: tree.nodes,
      nodeTypes: tree.types,
      enterNode,
      createNode,
      renameNode,
      deleteNode,
    };
  }, [
    state, selection, openCount, reveal, getFile, open, close, write, remove, storageMode,
    syncError, node, lineage, tree, enterNode, createNode, renameNode, deleteNode,
  ]);

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

/** `id` and its ancestors, top level first. */
export function lineageOf(nodes: KnowledgeNode[], id: string): KnowledgeNode[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const chain: KnowledgeNode[] = [];
  for (let n = byId.get(id); n; n = n.parentId ? byId.get(n.parentId) : undefined) {
    chain.unshift(n);
  }
  return chain;
}

export function useWorkspace() {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) throw new Error("useWorkspace must be used inside <WorkspaceProvider>");
  return ctx;
}
