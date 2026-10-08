"use client";

import { useRef } from "react";
import {
  CloudAlert,
  CloudCheck,
  FolderTree,
  HardDrive,
  MessagesSquare,
  Moon,
  PanelLeft,
  PanelRight,
  PanelsTopLeft,
  Sun,
} from "lucide-react";
import { useTheme } from "@/hooks/use-theme";
import { cn } from "@/lib/utils";
import { useWorkspaceAgent } from "./agent-bridge";
import { ChatPane } from "./chat-pane";
import { EditorPane } from "./editor-pane";
import { ActivityBar, SidePanel } from "./sidebar";
import { Splitter } from "./splitter";
import { useWorkspace, WorkspaceProvider } from "./store";
import { useWorkbench, WorkbenchProvider } from "./workbench";

export { WorkspaceProvider, useWorkspace };
export { useWorkbench, type Workbench } from "./workbench";

/**
 * IDE-style workspace: icon rail + side panel (files, skills, uploads,
 * artifacts, chats) | editor/preview | Claude chat. Side and chat panes resize
 * by dragging and collapse via the rail / the title bar; sizes are remembered.
 * Below 1024px one pane shows at a time with a bottom switcher. All of it is
 * driven through the workbench contract (workbench.tsx).
 */
export function Workspace() {
  return (
    <WorkbenchProvider>
      <WorkspaceLayout />
    </WorkbenchProvider>
  );
}

function WorkspaceLayout() {
  useWorkspaceAgent();
  const { layout, panes, sidebar } = useWorkbench();
  const dragStart = useRef(0);
  const { mobilePane } = layout;

  return (
    <div className="flex h-dvh w-full flex-col overflow-hidden bg-[var(--background)] text-[var(--foreground)]">
      <TitleBar />
      <div className="flex min-h-0 flex-1">
        <div
          data-pane="explorer"
          className={cn(
            "flex shrink-0",
            mobilePane === "explorer" ? "max-lg:flex-1" : "max-lg:hidden",
          )}
        >
          <ActivityBar view={sidebar.view} panelOpen={layout.sideOpen} onSelect={sidebar.select} />
          {/* Always shown on phones, where this is the whole Files pane. */}
          <div
            style={{ width: layout.sideWidth }}
            className={cn("min-w-0 max-lg:!w-auto max-lg:flex-1", !layout.sideOpen && "lg:hidden")}
          >
            <SidePanel view={sidebar.view} />
          </div>
        </div>
        {layout.sideOpen && (
          <Splitter
            label="Resize sidebar"
            onDragStart={() => (dragStart.current = layout.sideWidth)}
            onDrag={(dx) => panes.resize("explorer", dragStart.current + dx)}
            onReset={() => panes.resetSize("explorer")}
          />
        )}

        <div data-pane="editor" className={cn("min-w-0 flex-1", mobilePane !== "editor" && "max-lg:hidden")}>
          <EditorPane />
        </div>

        {/* Kept mounted when hidden so the conversation and its tools survive toggling. */}
        {layout.chatOpen && (
          <Splitter
            label="Resize chat"
            onDragStart={() => (dragStart.current = layout.chatWidth)}
            onDrag={(dx) => panes.resize("chat", dragStart.current - dx)}
            onReset={() => panes.resetSize("chat")}
          />
        )}
        <div
          data-pane="chat"
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
      <MobileSwitcher />
    </div>
  );
}

function TitleBar() {
  const { setTheme } = useTheme();
  const { panes } = useWorkbench();
  const sideOpen = panes.isOpen("explorer");
  const chatOpen = panes.isOpen("chat");
  const button =
    "flex size-7 items-center justify-center rounded text-[var(--muted-foreground)] hover:bg-[var(--secondary)] hover:text-[var(--foreground)] cursor-pointer";
  return (
    // Right padding leaves room for the CopilotKit inspector button pinned top-right.
    <header className="flex h-10 shrink-0 items-center gap-2 border-b border-[var(--border)] pl-4 pr-24">
      <span className="size-2.5 rounded-full bg-[image:var(--cpk-ambient-gradient)]" />
      <span className="text-sm font-bold tracking-tight">Knowledge Chatroom</span>
      <StorageStatus />
      <div className="ml-auto flex items-center gap-0.5">
        <button
          type="button"
          aria-label={sideOpen ? "Hide sidebar" : "Show sidebar"}
          title={sideOpen ? "Hide sidebar" : "Show sidebar"}
          aria-pressed={sideOpen}
          onClick={() => panes.toggle("explorer")}
          className={cn(button, "max-lg:hidden")}
        >
          <PanelLeft className="size-4" />
        </button>
        <button
          type="button"
          aria-label={chatOpen ? "Hide chat" : "Show chat"}
          title={chatOpen ? "Hide chat" : "Show chat"}
          aria-pressed={chatOpen}
          onClick={() => panes.toggle("chat")}
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

/** Where files are saved, and whether the last save failed. */
function StorageStatus() {
  const { storageMode, syncError } = useWorkspace();
  if (storageMode === "loading") return null;
  const [Icon, label, title] = syncError
    ? [CloudAlert, "Not saved", syncError]
    : storageMode === "server"
      ? [CloudCheck, "Saved", "Files are saved on the server, with every version kept."]
      : [HardDrive, "This browser", "No storage server, so files are kept in this browser only."];
  return (
    <span
      title={title}
      role="status"
      className={cn(
        "ml-2 flex items-center gap-1 text-xs",
        syncError ? "text-red-500" : "text-[var(--muted-foreground)]",
      )}
    >
      <Icon className="size-3.5" />
      <span className="max-sm:hidden">{label}</span>
    </span>
  );
}

function MobileSwitcher() {
  const { layout, panes } = useWorkbench();
  const pane = layout.mobilePane;
  const items = [
    { id: "explorer" as const, label: "Files", icon: FolderTree },
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
          onClick={() => panes.show(id)}
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
