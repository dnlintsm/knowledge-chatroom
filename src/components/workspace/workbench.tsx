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
} from "./layout";
import { useHydrated, useWorkspace } from "./store";
import type { TabId } from "./types";

/**
 * The workbench contract: the one typed API that moves panes, opens files,
 * drives the chat and shows notices. Title bar buttons, the icon rail, the
 * phone pane switcher, file references in answers, actions and Claude all go
 * through it; nothing else changes pane layout state (see layout.ts).
 */
export interface Workbench {
  /** Current layout, read-only; change it through the commands below. */
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

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(LAYOUT_KEY);
      if (raw) apply({ type: "restore", saved: JSON.parse(raw) });
    } catch {
      // Storage may be unavailable; retain the in-memory layout.
    }
  }, [apply]);
  const hydrated = useHydrated();
  const saved = JSON.stringify(persistedLayout(layout));
  useEffect(() => {
    if (!hydrated) return;
    try {
      window.localStorage.setItem(LAYOUT_KEY, saved);
    } catch {
      // Storage may be unavailable; retain the in-memory layout.
    }
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

  const { open } = ws;
  const startNewThread = chatConfig?.startNewThread;
  const focusChat = useCallback(() => {
    apply({ type: "show", pane: "chat" });
    // After the pane renders, also when it was hidden until now.
    requestAnimationFrame(() =>
      document.querySelector<HTMLTextAreaElement>(CHAT_INPUT_SELECTOR)?.focus(),
    );
  }, [apply]);

  const value = useMemo<Workbench>(
    () => ({
      layout,
      panes: {
        isOpen: (pane) => isPaneOpen(layout, pane),
        show: (pane) => apply({ type: "show", pane }),
        hide: (pane) => apply({ type: "hide", pane }),
        toggle: (pane) => apply({ type: "toggle", pane }),
        resize: (pane, width) => apply({ type: "resize", pane, width }),
        resetSize: (pane) => apply({ type: "resetSize", pane }),
      },
      sidebar: {
        view: layout.view,
        select: (view) => apply({ type: "selectView", view }),
        show: (view) => apply({ type: "showView", view }),
      },
      editor: { open },
      chat: {
        newThread: () => {
          startNewThread?.();
          focusChat();
        },
        focus: focusChat,
      },
      notify,
    }),
    [layout, apply, open, startNewThread, focusChat, notify],
  );

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
