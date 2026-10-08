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
import { CircleAlert, CircleCheck, Info, X } from "lucide-react";
import { useCopilotChatConfiguration } from "@copilotkit/react-core/v2";
import { cn } from "@/lib/utils";
import type { LineRange } from "./file-refs";
import {
  DEFAULT_LAYOUT,
  isPaneOpen,
  persistedLayout,
  reduceLayout,
  type Layout,
  type LayoutCommand,
  type PaneId,
  type ResizablePane,
  type SidebarView,
  touchesChat,
  withoutChat,
} from "./layout";
import { findRunDirs, isInRun, normalizeRunDir, RUN_REPORT, runFromSearch, searchWithRun, type RunDir } from "./runs";
import { useHydrated, useWorkspace } from "./store";
import type { TabId } from "./types";

/**
 * The workbench contract: the one typed API that moves panes, opens files,
 * drives the chat and shows notices. Title bar buttons, the icon rail, the
 * phone pane switcher, file references in answers, actions and Claude all go
 * through it; nothing else changes pane layout state (see layout.ts).
 */
export interface Workbench {
  /**
   * Focus: the panes work on one run (RUN_DIR). Traverse: no run is picked,
   * the Traverse view lists them, and there is no chat pane.
   */
  mode: "focus" | "traverse";
  runDir: string | null;
  /** Every run in the workspace (see runs.ts). */
  runs: RunDir[];
  run: {
    /** Focuses a run and puts it in the URL (a new history entry). */
    focus(runDir: string): void;
    /** Back to Traverse mode. */
    leave(): void;
  };
  /** Current layout as shown, read-only; change it through the commands below. */
  layout: Layout;
  panes: {
    isOpen(pane: PaneId): boolean;
    /** Opens the pane; on phones also switches to it. */
    show(pane: PaneId): void;
    hide(pane: PaneId): void;
    toggle(pane: PaneId): void;
    resize(pane: ResizablePane, width: number): void;
    resetSize(pane: ResizablePane): void;
  };
  sidebar: {
    view: SidebarView;
    /** An icon rail click: picking the view already shown collapses the pane. */
    select(view: SidebarView): void;
    show(view: SidebarView): void;
  };
  editor: {
    /** Opens a file (or the task board) in the middle pane, at `lines` if given. */
    open(tab: TabId, lines?: LineRange): void;
  };
  /** Only in Focus mode; in Traverse mode these do nothing. */
  chat: {
    /** Starts a new, empty conversation and shows the chat. */
    newThread(): void;
    /** Shows the chat and puts the cursor in its input. */
    focus(): void;
  };
  notify(message: string, level?: NoticeLevel): void;
}

export type NoticeLevel = "info" | "success" | "warning" | "error";

interface Notice {
  id: number;
  message: string;
  level: NoticeLevel;
}

const LAYOUT_KEY = "knowledge-chatroom.layout.v1";
const NOTICE_MS = 5_000;
export const CHAT_INPUT_SELECTOR = '[data-pane="chat"] textarea';

const WorkbenchContext = createContext<Workbench | null>(null);

export function WorkbenchProvider({ children }: { children: ReactNode }) {
  const ws = useWorkspace();
  const chatConfig = useCopilotChatConfiguration();
  const [layout, setLayout] = useState(DEFAULT_LAYOUT);
  const apply = useCallback(
    (command: LayoutCommand) => setLayout((l) => reduceLayout(l, command)),
    [],
  );

  // The run comes from the URL (?run=<path>), so links and back/forward work.
  // undefined until the URL has been read after mount.
  const [runDir, setRunDir] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    const sync = () => setRunDir(runFromSearch(window.location.search));
    sync();
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, []);
  const navigate = useCallback((dir: string | null, how: "push" | "replace" = "push") => {
    const { pathname, search, hash } = window.location;
    const url = pathname + searchWithRun(search, dir) + hash;
    if (how === "push") window.history.pushState(null, "", url);
    else window.history.replaceState(null, "", url);
    setRunDir(dir);
  }, []);
  const mode = runDir ? "focus" : "traverse";
  const runs = useMemo(() => findRunDirs(ws.files.map((f) => f.path)), [ws.files]);

  // Entering Traverse shows the run list; entering a run shows its files.
  const shownRun = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (runDir === undefined || shownRun.current === runDir) return;
    shownRun.current = runDir;
    apply(runDir ? { type: "setView", view: "files" } : { type: "showView", view: "runs" });
  }, [runDir, apply]);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(LAYOUT_KEY);
      if (raw) apply({ type: "restore", saved: JSON.parse(raw) });
    } catch {}
  }, [apply]);
  const hydrated = useHydrated();
  const saved = JSON.stringify(persistedLayout(layout));
  useEffect(() => {
    if (!hydrated) return;
    try {
      window.localStorage.setItem(LAYOUT_KEY, saved);
    } catch {}
  }, [saved, hydrated]);

  // Opening a file from anywhere (even the one already open, or one Claude
  // wrote) shows the editor on phones. This happens during render, not in an
  // effect, so the editor is already visible when it scrolls to cited lines.
  const [shownOpens, setShownOpens] = useState(ws.openCount);
  if (ws.openCount !== shownOpens) {
    setShownOpens(ws.openCount);
    apply({ type: "show", pane: "editor" });
  }

  const [notices, setNotices] = useState<Notice[]>([]);
  const nextNotice = useRef(0);
  const dismiss = useCallback((id: number) => setNotices((n) => n.filter((x) => x.id !== id)), []);
  const notify = useCallback(
    (message: string, level: NoticeLevel = "info") => {
      const id = ++nextNotice.current;
      setNotices((n) => [...n.filter((x) => x.message !== message), { id, message, level }]);
      setTimeout(() => dismiss(id), NOTICE_MS);
    },
    [dismiss],
  );

  // A link to a run that isn't there (or a run deleted meanwhile) falls back
  // to Traverse, once the files have loaded.
  useEffect(() => {
    if (!runDir || ws.storageMode === "loading") return;
    if (runs.some((r) => r.path === runDir)) return;
    notify(`There is no run at ${runDir}.`, "warning");
    navigate(null, "replace");
  }, [runDir, runs, ws.storageMode, notify, navigate]);

  const { open, getFile } = ws;
  const focusRun = useCallback(
    (dir: string) => {
      const next = normalizeRunDir(dir);
      if (next && next !== runDir) navigate(next);
    },
    [runDir, navigate],
  );

  // However a run gets focused (a pick, a link, back/forward), the middle pane
  // shows that run: its report opens unless a file of the run is already open,
  // so the editor never shows another run's report beside this run's context.
  // Waits for the files, as a linked run's report may not have loaded yet.
  const shownReportFor = useRef<string | null>(null);
  const { active } = ws;
  useEffect(() => {
    if (!runDir) {
      shownReportFor.current = null;
      return;
    }
    if (ws.storageMode === "loading" || shownReportFor.current === runDir) return;
    shownReportFor.current = runDir;
    const report = `${runDir}/${RUN_REPORT}`;
    if (!(active && isInRun(active, runDir)) && getFile(report)) open(report);
  }, [runDir, ws.storageMode, active, getFile, open]);

  const startNewThread = chatConfig?.startNewThread;
  const chatAvailable = mode === "focus";
  const focusChat = useCallback(() => {
    if (!chatAvailable) return;
    apply({ type: "show", pane: "chat" });
    // After the pane renders, also when it was hidden until now.
    requestAnimationFrame(() =>
      document.querySelector<HTMLTextAreaElement>(CHAT_INPUT_SELECTOR)?.focus(),
    );
  }, [apply, chatAvailable]);

  const value = useMemo<Workbench>(() => {
    const shown = chatAvailable ? layout : withoutChat(layout);
    // Traverse mode has no chat pane, so nothing may show or size it there.
    const command = (c: LayoutCommand) => {
      if (!chatAvailable && touchesChat(c)) return;
      apply(c);
    };
    return {
      mode,
      runDir: runDir ?? null,
      runs,
      run: { focus: focusRun, leave: () => runDir && navigate(null) },
      layout: shown,
      panes: {
        isOpen: (pane) => isPaneOpen(shown, pane),
        show: (pane) => command({ type: "show", pane }),
        hide: (pane) => command({ type: "hide", pane }),
        toggle: (pane) => command({ type: "toggle", pane }),
        resize: (pane, width) => command({ type: "resize", pane, width }),
        resetSize: (pane) => command({ type: "resetSize", pane }),
      },
      sidebar: {
        view: shown.view,
        select: (view) => apply({ type: "selectView", view }),
        show: (view) => apply({ type: "showView", view }),
      },
      editor: { open },
      chat: {
        newThread: () => {
          if (!chatAvailable) return;
          startNewThread?.();
          focusChat();
        },
        focus: focusChat,
      },
      notify,
    };
  }, [mode, runDir, runs, focusRun, navigate, layout, apply, open, chatAvailable, startNewThread, focusChat, notify]);

  return (
    <WorkbenchContext.Provider value={value}>
      {children}
      <Notices notices={notices} onDismiss={dismiss} />
    </WorkbenchContext.Provider>
  );
}

export function useWorkbench() {
  const ctx = useContext(WorkbenchContext);
  if (!ctx) throw new Error("useWorkbench must be used inside <WorkbenchProvider>");
  return ctx;
}

const NOTICE_ICONS = { info: Info, success: CircleCheck, warning: CircleAlert, error: CircleAlert };

function Notices({ notices, onDismiss }: { notices: Notice[]; onDismiss: (id: number) => void }) {
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="notices"
      className="pointer-events-none fixed right-4 bottom-4 z-50 flex w-[min(360px,calc(100vw-2rem))] flex-col gap-2 max-lg:bottom-20"
    >
      {notices.map(({ id, message, level }) => {
        const Icon = NOTICE_ICONS[level];
        return (
          <div
            key={id}
            data-level={level}
            className="pointer-events-auto flex items-start gap-2 rounded-md border border-[var(--border)] bg-[var(--card)] px-3 py-2 text-[13px] text-[var(--foreground)] shadow-md"
          >
            <Icon
              className={cn(
                "mt-0.5 size-4 shrink-0",
                level === "error" && "text-[var(--destructive)]",
                level === "warning" && "text-amber-500",
                level === "success" && "text-emerald-500",
                level === "info" && "text-[var(--muted-foreground)]",
              )}
            />
            <span className="min-w-0 flex-1">{message}</span>
            <button
              type="button"
              aria-label="Dismiss"
              onClick={() => onDismiss(id)}
              className="flex size-5 shrink-0 items-center justify-center rounded text-[var(--muted-foreground)] hover:text-[var(--foreground)] cursor-pointer"
            >
              <X className="size-3.5" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
