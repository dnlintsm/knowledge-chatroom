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
import { parseWorkspaceEvent } from "../../../shared/storage-contract";
import { normalizePath } from "../../../shared/files";
export { normalizePath } from "../../../shared/files";
import type { LineRange } from "./file-refs";
import type { Reveal } from "./file-focus";
export type { Reveal } from "./file-focus";
import { useFileFocus } from "./use-file-focus";
import { experimentFromSearch } from "./runs";
import { usePlaceNavigation } from "./use-place-navigation";
import { useWorkspaceCatalog } from "./use-workspace-catalog";
import { lineageOf, resolvePlaceContext } from "./workspace-context";
export { lineageOf } from "./workspace-context";
import { SaveScheduler, type StorageMode } from "./save-scheduler";
import { DEFAULT_OPEN, SEED_FILES } from "./seed";
import { reduceWorkspace, type PersistedWorkspace as Persisted } from "./workspace-state";
import { NODE_KEY, SERVER_SEEDED_KEY, readPlaceUi, restoreWorkspace, persistWorkspace } from "./local-persistence";
import {
  createServerExperiment,
  createServerNode,
  decideProposal as decideServerProposal,
  deleteServerExperiment,
  deleteServerFile,
  deleteServerNode,
  eventPlace,
  experimentOf,
  experimentPlace,
  getAccount,
  listServerFiles,
  loadServerFile,
  promoteExperiment,
  putServerFile,
  renameServerFile,
  renameServerNode,
  serverExperimentFromFolder,
  updateServerExperiment,
  WATCH_URL,
  type Account,
  type Experiment,
  type ExperimentChange,
  type KnowledgeNode,
  type NodeId,
  type NodeType,
  type PlaceId,
  type Proposal,
  type Role,
  type ServerEvent,
  type ServerFile,
} from "./server-files";
import {
  FileExistsError,
  isBuiltInTab,
  kindForPath,
  mimeForPath,
  ReadOnlyFileError,
  REVIEW_TAB,
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
 * loop › process), and experiments on its nodes. The user is always in one
 * place, the workspace root, a node or an experiment, and `files` holds that
 * place's files; enterNode() and enterExperiment() move elsewhere. Each place
 * keeps its own tabs.
 *
 * With login on, what the user may do in each place comes from their role
 * there (`placeRole`); `canEdit` says whether this place's files can change.
 *
 * `proposals` are the open proposed versions the user can see: Claude's edits
 * to a node, and experiments promoted to theirs, waiting for an editor to
 * accept or reject them (the Review tab). When Claude proposes a change for
 * this user, the workspace goes there and opens the Review tab.
 */

/** How long to wait for storage that is still starting before using the browser. */
const STARTUP_RETRY_MS = 2_000;
const STARTUP_RETRIES = 30;

export type { StorageMode } from "./save-scheduler";

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
  /**
   * Moves a file to a new path in the same place, keeping its history and
   * open tab. Throws FileExistsError when the path is taken, ReadOnlyFileError
   * for a read-only file, and with a message for other failures.
   */
  rename: (from: string, to: string) => Promise<WorkspaceFile>;
  setSelection: (text: string) => void;
  /** Where files are kept; see the comment at the top of this file. */
  storageMode: StorageMode;
  /** A failed save, retained until all failed files have saved successfully. */
  syncError: string | null;
  /**
   * Where the user is: a knowledge node (also when in one of its experiments),
   * or null for the workspace root.
   */
  node: NodeId;
  /** The experiment the user is in, if any; `node` is then the node it belongs to. */
  experiment: Experiment | null;
  /** The current node and its ancestors, top level first; empty at the root. */
  lineage: KnowledgeNode[];
  /** The knowledge tree (server storage only). */
  nodes: KnowledgeNode[];
  nodeTypes: NodeType[];
  /** Experiments you can see, newest first. */
  experiments: Experiment[];
  /** Your role at the workspace root; each node carries its own. */
  rootRole: Role | null;
  /** Your role in the current place (owner without server storage). */
  placeRole: Role | null;
  /** Whether you can add, change and delete files here. */
  canEdit: boolean;
  /** Whether login is on, and who is signed in. */
  account: Account;
  /** Moves to a node (null = root) and loads its files; false if it's gone. */
  enterNode: (id: NodeId) => Promise<boolean>;
  /** Moves into an experiment; false if it's gone. */
  enterExperiment: (id: string) => Promise<boolean>;
  /**
   * Starts a new experiment of yours on a node (a fork of its files) or at
   * the root (null, empty) and moves into it. These throw with a message too.
   */
  createExperiment: (nodeId: NodeId, title: string) => Promise<Experiment>;
  /** Moves a folder here into a new experiment of yours and moves into it. */
  experimentFromFolder: (folder: string) => Promise<Experiment>;
  updateExperiment: (id: string, change: ExperimentChange) => Promise<Experiment>;
  deleteExperiment: (id: string) => Promise<void>;
  /** Open proposals you can see, anywhere, newest first. */
  proposals: Proposal[];
  /** Accept, reject or withdraw a proposal; throws with a message. */
  decideProposal: (id: string, decision: "accept" | "reject" | "withdraw") => Promise<Proposal>;
  /** Proposes an experiment's changed files (all, or `paths`) to its node; throws with a message. */
  promote: (experimentId: string, paths?: string[], note?: string) => Promise<Proposal[]>;
  /** These throw with a message for the user, e.g. a duplicate name. */
  createNode: (parentId: NodeId, name: string) => Promise<KnowledgeNode>;
  renameNode: (id: string, name: string) => Promise<void>;
  deleteNode: (id: string) => Promise<void>;
}

const WorkspaceContext = createContext<WorkspaceValue | null>(null);

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
  const {
    selection, openCount, reveal, setSelection,
    open: openFocus, edit: editFocus, reset: resetFocus,
  } = useFileFocus(state.active);
  const hydrated = useHydrated();

  const [storageMode, setStorageMode] = useState<StorageMode>("loading");
  const [syncError, setSyncError] = useState<string | null>(null);
  const mode = useRef<StorageMode>("loading");
  const files = useRef(state.files);
  files.current = state.files;
  const placeRef = useRef<PlaceId>(null);
  const {
    tree, experiments, proposals, account, setExperiments, setProposals, setAccount,
    refreshTree, refreshExperiments, refreshProposals,
  } = useWorkspaceCatalog();
  const [sync] = useState(() => new SaveScheduler({
    getMode: () => mode.current,
    getPlace: () => placeRef.current,
    getFile: (path) => files.current.find((file) => file.path === path),
    put: putServerFile,
    onError: setSyncError,
  }));
  const { busy, schedule: scheduleSave, flush: flushSaves, settle: settleSaves } = sync;

  // Restore after mount so server and client render the same seed first.
  // Saving waits for `hydrated` (set in the same commit as the restore), so the
  // seed is never written over saved work, even when Strict Mode replays effects.
  useEffect(() => {
    try {
      const restored = restoreWorkspace(window.localStorage);
      if (restored) setState(restored);
    } catch {
      // Private mode or corrupt data: keep the seed.
    }
  }, []);

  const upsert = useCallback((file: WorkspaceFile) => {
    setState((s) => reduceWorkspace(s, { type: "upsert", file }));
  }, []);

  const removeLocal = useCallback((path: string) => {
    setState((s) => reduceWorkspace(s, { type: "remove", path }));
  }, []);

  // Brings local files in line with the server's list: fetches what changed,
  // drops what was deleted, and leaves files with unsaved edits alone, also
  // when the user starts editing while the fetches are in flight. `keep` names
  // files that aren't on the server but must stay (failed first uploads).
  const resync = useCallback(async (list: ServerFile[], keep = new Set<string>()) => {
    const at = placeRef.current;
    const local = new Map(files.current.map((f) => [f.path, f]));
    const next = await Promise.all(
      list.map(async (info) => {
        const mine = local.get(info.path);
        if (mine && (busy(info.path) || sync.hash(info.path) === info.sha256)) {
          return mine;
        }
        const file = await loadServerFile(info, at);
        sync.remember(info.path, info.sha256, at);
        return file;
      }),
    );
    // The user moved elsewhere meanwhile; that move loads its own files.
    if (placeRef.current !== at) return;
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
      const tabs = s.tabs.filter((t) => isBuiltInTab(t) || exists.has(t));
      const active = s.active && tabs.includes(s.active) ? s.active : (tabs[0] ?? null);
      return { files: all, tabs, active };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const { place, setPlace, enterNode, enterExperiment } = usePlaceNavigation({
    mode, placeRef, files, setState, flushSaves, resync, resetFocus,
  });

  useEffect(() => {
    if (!hydrated || storageMode === "loading") return;
    try {
      persistWorkspace(window.localStorage, state, storageMode, place);
    } catch {
      // Quota exceeded (large uploads): the session still works in memory.
    }
  }, [state, hydrated, storageMode, place]);

  // Pick server or local storage once, after the local restore above.
  useEffect(() => {
    let events: EventSource | null = null;
    let cancelled = false;
    let treeTimer: ReturnType<typeof setTimeout> | undefined;

    const onEvent = async (event: ServerEvent) => {
      if (event.op === "proposal") {
        const list = await refreshProposals();
        // Claude proposed a change for you: show it where it would land.
        const mine = list?.find((p) => p.id === event.id && p.mine && p.author === "agent");
        if (mine && (event.change === "create" || event.change === "update")) {
          if (mine.node === placeRef.current || (await enterNode(mine.node))) open(REVIEW_TAB);
        }
        return;
      }
      if (event.op === "node") {
        void refreshProposals();
        const now = await refreshTree();
        // Deleted, or under a deleted node: go back to the root.
        const here = placeRef.current;
        const gone =
          now &&
          here &&
          (experimentOf(here)
            ? !now.experiments.some((e) => e.id === experimentOf(here))
            : !now.nodes.some((n) => n.id === here));
        if (gone) void enterNode(null);
        return;
      }
      if (event.op === "experiment") {
        const list = await refreshExperiments();
        // Deleted, or no longer shared with you: back to its node.
        const here = experimentOf(placeRef.current);
        if (list && here === event.id && !list.some((e) => e.id === here)) {
          if (!(await enterNode(event.node))) void enterNode(null);
        }
        return;
      }
      // File counts on the tree.
      clearTimeout(treeTimer);
      treeTimer = setTimeout(() => void refreshTree(), 300);

      const { path } = event;
      const at = eventPlace(event);
      if (at !== placeRef.current) {
        // Claude wrote somewhere else: follow it there.
        if (event.op === "write" && event.author === "agent") {
          if (await enterNode(at)) open(path);
        }
        return;
      }
      if (busy(path)) return;
      if (event.op === "delete") {
        sync.forget(path);
        removeLocal(path);
        return;
      }
      if (sync.hash(path) === event.sha256) return; // Our own save.
      const list = await listServerFiles(at);
      const info = Array.isArray(list) ? list.find((f) => f.path === path) : undefined;
      if (!info || busy(path) || placeRef.current !== at) return;
      const file = await loadServerFile(info, at);
      // The user may have started editing this file, or moved, while it loaded.
      if (busy(path) || placeRef.current !== at) return;
      sync.remember(path, info.sha256);
      upsert(file);
      if (info.author === "agent") open(path);
    };

    const activateLocalStorage = () => {
      mode.current = "local";
      setStorageMode("local");
    };

    (async () => {
      const who = await getAccount();
      if (cancelled) return;
      setAccount(who);
      // Storage answers 503 while it migrates on startup; give it a moment.
      let list = await listServerFiles();
      for (let i = 0; list === "starting" && i < STARTUP_RETRIES; i++) {
        await new Promise((r) => setTimeout(r, STARTUP_RETRY_MS));
        if (cancelled) return;
        list = await listServerFiles();
      }
      if (cancelled) return;
      if (!Array.isArray(list)) return activateLocalStorage();

      // First visit to an empty server: bring over this browser's files (or
      // the samples), so nothing made before storage existed is lost. Uploads
      // that fail stay visible, are reported, and are retried on the next load.
      // Not with login: a shared workspace that looks empty to you may just
      // not be shared with you, and it isn't yours to fill.
      const seeded = who.login ? "1" : window.localStorage.getItem(SERVER_SEEDED_KEY);
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

      // Open the run a link names (?experiment=), else return to the place
      // this browser was last in, if it still exists.
      const linked = experimentFromSearch(window.location.search);
      const lastNode = linked ? experimentPlace(linked) : window.localStorage.getItem(NODE_KEY);
      const there = lastNode ? await listServerFiles(lastNode) : null;
      if (cancelled) return;
      if (lastNode && Array.isArray(there)) {
        placeRef.current = lastNode;
        setPlace(lastNode);
        list = there;
      }
      const ui = readPlaceUi(window.localStorage)[placeRef.current ?? ""];
      if (ui) setState((s) => ({ ...s, tabs: ui.tabs, active: ui.active }));

      await resync(list, placeRef.current === null ? new Set(failed) : new Set());
      // Roles come with the tree; load it first so edit controls are right from the start.
      await Promise.all([refreshTree(), refreshProposals()]);
      if (cancelled) return;
      mode.current = "server";
      setStorageMode("server");

      events = new EventSource(WATCH_URL);
      events.onmessage = (e) => {
        try { void onEvent(parseWorkspaceEvent(JSON.parse(e.data))).catch(() => {}); }
        catch { /* Invalid stream messages cannot enter state; reconnect resyncs. */ }
      };
      // The browser reconnects by itself; catch up on anything missed meanwhile.
      let dropped = false;
      events.onerror = () => (dropped = true);
      events.onopen = () => {
        if (!dropped) return;
        dropped = false;
        void refreshTree();
        void refreshProposals();
        const at = placeRef.current;
        void listServerFiles(at).then((l) => {
          if (Array.isArray(l) && placeRef.current === at) void resync(l);
          else if (l === null && at) void enterNode(null); // The node was deleted.
        });
      };
    })().catch((err) => {
      console.error("[workspace] server storage failed to load:", err);
      activateLocalStorage();
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

  const open = useCallback((tab: TabId, lines?: LineRange) => {
    openFocus(tab, lines);
    setState((s) => reduceWorkspace(s, { type: "open", tab }));
  }, [openFocus]);

  const close = useCallback((tab: TabId) => {
    setState((s) => reduceWorkspace(s, { type: "close", tab }));
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
      editFocus(path);
      return file;
    },
    [upsert, scheduleSave, editFocus],
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
        const at = placeRef.current;
        // Counted as in flight, so the change event for this write is ignored.
        sync.beginWrite(path, at);
        let lost = false;
        try {
          const info = await putServerFile(file, at, { createOnly: true, readOnly: opts?.readOnly });
          sync.remember(path, info.sha256, at);
        } catch (err) {
          if (!(err instanceof FileExistsError)) throw err;
          lost = true;
        } finally {
          sync.endWrite(path, at);
        }
        if (lost) {
          // Another tab or browser won. Its change event was ignored while this
          // write was in flight, so load its file now, before callers open it.
          const list = await listServerFiles(at);
          if (Array.isArray(list) && placeRef.current === at) await resync(list);
          throw new FileExistsError(path);
        }
        // The user moved to another place meanwhile; the file is saved there.
        if (placeRef.current !== at) return file;
      }
      // A resync may have brought the new file in meanwhile; this is the same file.
      files.current = [...files.current.filter((f) => f.path !== path), file];
      upsert(file);
      return file;
    },
    [upsert, resync, sync],
  );

  const remove = useCallback(
    (path: string) => {
      if (files.current.find((f) => f.path === path)?.readOnly) throw new ReadOnlyFileError(path);
      removeLocal(path);
      if (mode.current !== "server") return;
      sync.cancel(path);
      deleteServerFile(path, placeRef.current).catch((err) => {
        console.error("[workspace] delete failed:", err);
        setSyncError(`Couldn't delete ${path}`);
      });
    },
    [removeLocal, sync],
  );

  const rename = useCallback<WorkspaceValue["rename"]>(
    async (from, rawTo) => {
      const to = normalizePath(rawTo);
      const existing = files.current.find((f) => f.path === from);
      if (!existing) throw new Error(`${from} is gone`);
      if (existing.readOnly) throw new ReadOnlyFileError(from);
      if (to === from) return existing;
      if (files.current.some((f) => f.path === to)) throw new FileExistsError(to);
      // A type picked from the old name follows the new one; one set on upload stays.
      const mime = existing.mime === mimeForPath(from) ? mimeForPath(to) : existing.mime;
      let file: WorkspaceFile = { ...existing, path: to, kind: kindForPath(to), mime };
      if (mode.current === "loading") throw new Error("Files are still loading");
      if (mode.current === "server") {
        const at = placeRef.current;
        // The server must have the latest edits before they move with the file.
        await sync.settle(at);
        const latest = files.current.find((f) => f.path === from) ?? existing;
        file = { ...latest, path: to, kind: kindForPath(to), mime };
        // Locked while it moves, so no edit lands on the old path meanwhile.
        const lock = (f: WorkspaceFile) => {
          if (placeRef.current !== at) return; // Those files are no longer loaded.
          files.current = files.current.map((x) => (x.path === from ? f : x));
          upsert(f);
        };
        lock({ ...latest, readOnly: true });
        // Counted as in flight, so this rename's own change events are ignored.
        sync.beginWrite(from, at);
        sync.beginWrite(to, at);
        let failure: unknown = null;
        try {
          const info = await renameServerFile(from, to, at);
          sync.forget(from, at);
          sync.remember(to, info.sha256, at);
          file = { ...file, kind: info.kind, mime: info.mime, updatedAt: Date.parse(info.updatedAt) };
        } catch (err) {
          failure = err;
        } finally {
          sync.endWrite(from, at);
          sync.endWrite(to, at);
        }
        if (failure) {
          lock(latest);
          // Another browser may have taken the name or moved the file; the
          // events saying so were ignored while this was in flight.
          const list = await listServerFiles(at).catch(() => null);
          if (Array.isArray(list) && placeRef.current === at) await resync(list);
          throw failure;
        }
        if (placeRef.current !== at) return file;
      }
      files.current = [...files.current.filter((f) => f.path !== from && f.path !== to), file];
      setState((s) => reduceWorkspace(s, { type: "rename", from, file }));
      return file;
    },
    [sync, upsert, resync],
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
      const at = placeRef.current;
      const nodeHere = experimentOf(at)
        ? experiments.find((e) => e.id === experimentOf(at))?.nodeId
        : at;
      const inside = nodeHere && lineageOf(tree.nodes, nodeHere).some((n) => n.id === id);
      if (inside) await enterNode(null);
      await deleteServerNode(id);
      await refreshTree();
    },
    [refreshTree, enterNode, tree.nodes, experiments],
  );

  const createExperiment = useCallback(
    async (nodeId: NodeId, title: string) => {
      // The fork copies what the server has, so recent edits go first.
      if (placeRef.current === nodeId) await settleSaves(nodeId);
      const created = await createServerExperiment(nodeId, title);
      await refreshExperiments();
      await enterExperiment(created.id);
      return created;
    },
    [refreshExperiments, enterExperiment, settleSaves],
  );
  const experimentFromFolder = useCallback(
    async (folder: string) => {
      const at = placeRef.current;
      if (experimentOf(at)) throw new Error("This is already an experiment; go to its node to turn a folder into a run");
      // The move takes what the server has, so recent edits go first.
      await settleSaves(at);
      const created = await serverExperimentFromFolder(at, folder);
      await refreshExperiments();
      await enterExperiment(created.id);
      return created;
    },
    [refreshExperiments, enterExperiment, settleSaves],
  );
  const updateExperiment = useCallback(
    async (id: string, change: ExperimentChange) => {
      // Archived is read only, so edits still on their way would be refused.
      const here = experimentPlace(id);
      if (change.status === "archived" && placeRef.current === here) await settleSaves(here);
      const updated = await updateServerExperiment(id, change);
      setExperiments((list) => list.map((e) => (e.id === id ? updated : e)));
      return updated;
    },
    [settleSaves, setExperiments],
  );
  const deleteExperiment = useCallback(
    async (id: string) => {
      const doomed = experiments.find((e) => e.id === id);
      if (doomed && experimentOf(placeRef.current) === id) await enterNode(doomed.nodeId);
      await deleteServerExperiment(id);
      await refreshExperiments();
    },
    [experiments, enterNode, refreshExperiments],
  );

  const decideProposal = useCallback(
    async (id: string, decision: "accept" | "reject" | "withdraw") => {
      const decided = await decideServerProposal(id, decision);
      setProposals((list) => list.filter((p) => p.id !== id));
      void refreshProposals();
      return decided;
    },
    [refreshProposals, setProposals],
  );
  const promote = useCallback(
    async (experimentId: string, paths?: string[], note?: string) => {
      // Proposals take what the server has, so recent edits go first.
      const here = experimentPlace(experimentId);
      if (placeRef.current === here) await settleSaves(here);
      const made = await promoteExperiment(experimentId, paths, note);
      await refreshProposals();
      return made;
    },
    [settleSaves, refreshProposals],
  );

  const { experiment, node, lineage, placeRole, canEdit } = useMemo(
    () => resolvePlaceContext(storageMode, place, tree, experiments),
    [storageMode, place, tree, experiments],
  );

  const value = useMemo<WorkspaceValue>(() => {
    const activeFile =
      state.active && !isBuiltInTab(state.active)
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
      rename,
      setSelection,
      storageMode,
      syncError,
      node,
      experiment,
      lineage,
      nodes: tree.nodes,
      nodeTypes: tree.types,
      experiments,
      rootRole: tree.rootRole,
      placeRole,
      canEdit,
      account,
      enterNode,
      enterExperiment,
      createNode,
      renameNode,
      deleteNode,
      createExperiment,
      experimentFromFolder,
      updateExperiment,
      deleteExperiment,
      proposals,
      decideProposal,
      promote,
    };
  }, [
    state, selection, openCount, reveal, setSelection, getFile, open, close, write, create, remove, rename, storageMode,
    syncError, node, experiment, lineage, tree, experiments, placeRole, canEdit, account,
    enterNode, enterExperiment, createNode, renameNode, deleteNode, createExperiment, experimentFromFolder,
    updateExperiment, deleteExperiment, proposals, decideProposal, promote,
  ]);

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace() {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) throw new Error("useWorkspace must be used inside <WorkspaceProvider>");
  return ctx;
}
