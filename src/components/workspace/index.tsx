"use client";

import { useEffect, useRef, useState } from "react";
import { FolderTree, MessagesSquare, Moon, PanelLeft, PanelRight, PanelsTopLeft, Sun } from "lucide-react";
import { useTheme } from "@/hooks/use-theme";
import { cn } from "@/lib/utils";
import { useWorkspaceAgent } from "./agent-bridge";
import { ChatPane } from "./chat-pane";
import { EditorPane } from "./editor-pane";
import { ActivityBar, SidePanel, type SidebarView } from "./sidebar";
import { Splitter } from "./splitter";
import { useHydrated, useWorkspace, WorkspaceProvider } from "./store";

export { WorkspaceProvider, useWorkspace };

const LAYOUT_KEY = "knowledge-chatroom.layout.v1";
const DEFAULTS = { sideWidth: 260, chatWidth: 420, sideOpen: true, chatOpen: true };
const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

type MobilePane = "files" | "editor" | "chat";

/**
 * IDE-style workspace: icon rail + side panel (files, skills, uploads,
 * artifacts, chats) | editor/preview | Claude chat. Side and chat panes resize
 * by dragging and collapse via the rail / the editor's chat toggle; sizes are
 * remembered. Below 1024px one pane shows at a time with a bottom switcher.
 */
export function Workspace() {
  useWorkspaceAgent();
  const { openCount } = useWorkspace();
  const [view, setView] = useState<SidebarView>("files");
  const [layout, setLayout] = useState(DEFAULTS);
  const [mobilePane, setMobilePane] = useState<MobilePane>("editor");
  const dragStart = useRef(0);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(LAYOUT_KEY);
      if (raw) setLayout({ ...DEFAULTS, ...JSON.parse(raw) });
    } catch {}
  }, []);
  const hydrated = useHydrated();
  useEffect(() => {
    if (!hydrated) return;
    try {
      window.localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
    } catch {}
  }, [layout, hydrated]);

  // On phones, opening a file (even the one already open) should show it.
  useEffect(() => {
    if (openCount > 0) setMobilePane("editor");
  }, [openCount]);

  const selectView = (next: SidebarView) => {
    setLayout((l) => ({ ...l, sideOpen: !(l.sideOpen && view === next) }));
    setView(next);
  };

  return (
    <div className="flex h-dvh w-full flex-col overflow-hidden bg-[var(--background)] text-[var(--foreground)]">
      <TitleBar
        sideOpen={layout.sideOpen}
        chatOpen={layout.chatOpen}
        onToggleSide={() => setLayout((l) => ({ ...l, sideOpen: !l.sideOpen }))}
        onToggleChat={() => setLayout((l) => ({ ...l, chatOpen: !l.chatOpen }))}
      />
      <div className="flex min-h-0 flex-1">
        <div
          className={cn(
            "flex shrink-0",
            mobilePane === "files" ? "max-lg:flex-1" : "max-lg:hidden",
          )}
        >
          <ActivityBar view={view} panelOpen={layout.sideOpen} onSelect={selectView} />
          {/* Always shown on phones, where this is the whole Files pane. */}
          <div
            style={{ width: layout.sideWidth }}
            className={cn("min-w-0 max-lg:!w-auto max-lg:flex-1", !layout.sideOpen && "lg:hidden")}
          >
            <SidePanel view={view} />
          </div>
        </div>
        {layout.sideOpen && (
          <Splitter
            label="Resize sidebar"
            onDragStart={() => (dragStart.current = layout.sideWidth)}
            onDrag={(dx) => setLayout((l) => ({ ...l, sideWidth: clamp(dragStart.current + dx, 180, 480) }))}
            onReset={() => setLayout((l) => ({ ...l, sideWidth: DEFAULTS.sideWidth }))}
          />
        )}

        <div className={cn("min-w-0 flex-1", mobilePane !== "editor" && "max-lg:hidden")}>
          <EditorPane />
        </div>

        {/* Kept mounted when hidden so the conversation and its tools survive toggling. */}
        {layout.chatOpen && (
          <Splitter
            label="Resize chat"
            onDragStart={() => (dragStart.current = layout.chatWidth)}
            onDrag={(dx) => setLayout((l) => ({ ...l, chatWidth: clamp(dragStart.current - dx, 320, 760) }))}
            onReset={() => setLayout((l) => ({ ...l, chatWidth: DEFAULTS.chatWidth }))}
          />
        )}
        <div
          style={{ width: layout.chatWidth }}
          className={cn(
            "min-w-0 shrink-0",
            !layout.chatOpen && "lg:hidden",
            mobilePane === "chat" ? "max-lg:!w-auto max-lg:flex-1" : "max-lg:hidden",
          )}
        >
          <ChatPane />
        </div>
      </div>
      <MobileSwitcher pane={mobilePane} onChange={setMobilePane} />
    </div>
  );
}

function TitleBar({
  sideOpen,
  chatOpen,
  onToggleSide,
  onToggleChat,
}: {
  sideOpen: boolean;
  chatOpen: boolean;
  onToggleSide: () => void;
  onToggleChat: () => void;
}) {
  const { setTheme } = useTheme();
  const button =
    "flex size-7 items-center justify-center rounded text-[var(--muted-foreground)] hover:bg-[var(--secondary)] hover:text-[var(--foreground)] cursor-pointer";
  return (
    // Right padding leaves room for the CopilotKit inspector button pinned top-right.
    <header className="flex h-10 shrink-0 items-center gap-2 border-b border-[var(--border)] pl-4 pr-24">
      <span className="size-2.5 rounded-full bg-[image:var(--cpk-ambient-gradient)]" />
      <span className="text-sm font-bold tracking-tight">Knowledge Chatroom</span>
      <div className="ml-auto flex items-center gap-0.5">
        <button
          type="button"
          aria-label={sideOpen ? "Hide sidebar" : "Show sidebar"}
          title={sideOpen ? "Hide sidebar" : "Show sidebar"}
          aria-pressed={sideOpen}
          onClick={onToggleSide}
          className={cn(button, "max-lg:hidden")}
        >
          <PanelLeft className="size-4" />
        </button>
        <button
          type="button"
          aria-label={chatOpen ? "Hide chat" : "Show chat"}
          title={chatOpen ? "Hide chat" : "Show chat"}
          aria-pressed={chatOpen}
          onClick={onToggleChat}
          className={cn(button, "max-lg:hidden")}
        >
          <PanelRight className="size-4" />
        </button>
        <button
          type="button"
          aria-label="Toggle theme"
          title="Toggle theme"
          onClick={() =>
            setTheme(document.documentElement.classList.contains("dark") ? "light" : "dark")
          }
          className={button}
        >
          <Sun className="size-4 dark:hidden" />
          <Moon className="hidden size-4 dark:block" />
        </button>
      </div>
    </header>
  );
}

function MobileSwitcher({ pane, onChange }: { pane: MobilePane; onChange: (p: MobilePane) => void }) {
  const items = [
    { id: "files" as const, label: "Files", icon: FolderTree },
    { id: "editor" as const, label: "Editor", icon: PanelsTopLeft },
    { id: "chat" as const, label: "Chat", icon: MessagesSquare },
  ];
  return (
    <nav aria-label="Panes" className="flex shrink-0 border-t border-[var(--border)] bg-[var(--secondary)] lg:hidden">
      {items.map(({ id, label, icon: Icon }) => (
        <button
          key={id}
          type="button"
          aria-pressed={pane === id}
          onClick={() => onChange(id)}
          className={cn(
            "flex flex-1 flex-col items-center gap-0.5 py-2 text-[11px] cursor-pointer",
            pane === id ? "text-[var(--foreground)]" : "text-[var(--muted-foreground)]",
          )}
        >
          <Icon className="size-5" />
          {label}
        </button>
      ))}
    </nav>
  );
}
