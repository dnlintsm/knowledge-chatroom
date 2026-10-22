"use client";

import { useCallback, useEffect, useState } from "react";
import { Archive, ArchiveRestore, Check, Pencil, Trash2, X } from "lucide-react";
import { useCopilotChatConfiguration } from "@copilotkit/react-core/v2";
import { ago, cn } from "@/lib/utils";

/**
 * The user's past chats (issue #91), kept on the server per user: open one to
 * carry on where it left off, rename, archive or delete it. Reads the
 * runtime's thread routes, which this app answers from its own chat store
 * (src/lib/chat-routes.ts); they have the same shape with CopilotKit
 * Intelligence. CopilotKit's own threads drawer only lists threads with
 * Intelligence, so this takes its place.
 */

interface Thread {
  id: string;
  name: string | null;
  archived: boolean;
  updatedAt: string;
  lastRunAt?: string;
}

const RUNTIME = "/api/copilotkit";
const AGENT = "default";

async function call(path: string, init?: RequestInit) {
  const res = await fetch(`${RUNTIME}${path}`, {
    ...init,
    headers: init?.body ? { "Content-Type": "application/json" } : undefined,
  });
  if (!res.ok) throw new Error(`Chat history answered ${res.status}`);
  return res;
}

export function ChatHistory({ onOpen }: { onOpen: () => void }) {
  const config = useCopilotChatConfiguration();
  const activeId = config?.threadId;
  const [threads, setThreads] = useState<Thread[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const query = new URLSearchParams({ agentId: AGENT, limit: "200" });
      if (showArchived) query.set("includeArchived", "true");
      const { threads } = (await (await call(`/threads?${query}`)).json()) as { threads: Thread[] };
      setThreads(threads);
      setError(null);
    } catch {
      setError("Couldn't load your chats.");
    }
  }, [showArchived]);

  useEffect(() => {
    void load();
  }, [load]);

  const change = async (action: () => Promise<unknown>) => {
    try {
      await action();
    } catch {
      setError("That didn't work; try again.");
    }
    await load();
  };
  const rename = (id: string, name: string) =>
    change(() => call(`/threads/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ agentId: AGENT, name }) }));
  const setArchived = (id: string, archived: boolean) =>
    change(() => call(`/threads/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ agentId: AGENT, archived }) }));
  const remove = (thread: Thread) => {
    if (!window.confirm(`Delete the chat "${thread.name ?? "Untitled chat"}"? This can't be undone.`)) return;
    void change(async () => {
      await call(`/threads/${encodeURIComponent(thread.id)}`, { method: "DELETE", body: JSON.stringify({ agentId: AGENT }) });
      if (thread.id === activeId) config?.startNewThread();
    });
  };

  const iconButton =
    "flex size-6 shrink-0 items-center justify-center rounded text-[var(--muted-foreground)] hover:bg-[var(--secondary)] hover:text-[var(--foreground)] cursor-pointer";

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between px-3 py-2 text-xs text-[var(--muted-foreground)]">
        <span className="font-semibold uppercase tracking-wider">Your chats</span>
        <label className="flex cursor-pointer items-center gap-1.5">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(e) => setShowArchived(e.target.checked)}
            data-testid="chat-history-archived"
          />
          Show archived
        </label>
      </div>
      {error && <p className="px-3 pb-2 text-xs text-[var(--destructive)]">{error}</p>}
      {threads === null && !error && <p className="px-3 text-sm text-[var(--muted-foreground)]">Loading…</p>}
      {threads?.length === 0 && (
        <p className="px-3 text-sm text-[var(--muted-foreground)]">
          No chats yet. Your conversations are kept here, so you can come back to them later.
        </p>
      )}
      <ul role="listbox" aria-label="Your chats" className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
        {threads?.map((thread) => {
          const name = thread.name ?? "Untitled chat";
          const active = thread.id === activeId;
          if (renaming?.id === thread.id) {
            return (
              <li key={thread.id} className="flex items-center gap-1 rounded px-1.5 py-1">
                <form
                  className="flex min-w-0 flex-1 items-center gap-1"
                  onSubmit={(e) => {
                    e.preventDefault();
                    setRenaming(null);
                    void rename(thread.id, renaming.name);
                  }}
                >
                  <input
                    autoFocus
                    aria-label="Chat name"
                    value={renaming.name}
                    onChange={(e) => setRenaming({ id: thread.id, name: e.target.value })}
                    onKeyDown={(e) => e.key === "Escape" && setRenaming(null)}
                    className="min-w-0 flex-1 rounded border border-[var(--border)] bg-[var(--background)] px-1.5 py-0.5 text-sm"
                  />
                  <button type="submit" title="Save name" aria-label="Save name" className={iconButton}>
                    <Check className="size-3.5" />
                  </button>
                  <button type="button" title="Cancel" aria-label="Cancel" onClick={() => setRenaming(null)} className={iconButton}>
                    <X className="size-3.5" />
                  </button>
                </form>
              </li>
            );
          }
          return (
            <li
              key={thread.id}
              role="option"
              aria-selected={active}
              aria-label={name}
              tabIndex={0}
              data-testid="chat-history-item"
              onClick={() => {
                config?.setActiveThreadId(thread.id, { explicit: true });
                onOpen();
              }}
              onKeyDown={(e) => {
                if (e.target !== e.currentTarget || (e.key !== "Enter" && e.key !== " ")) return;
                e.preventDefault();
                config?.setActiveThreadId(thread.id, { explicit: true });
                onOpen();
              }}
              className={cn(
                "group flex cursor-pointer items-center gap-2 rounded px-1.5 py-1.5 hover:bg-[var(--secondary)]",
                active && "bg-[var(--secondary)]",
              )}
            >
              <span className="min-w-0 flex-1">
                <span className={cn("block truncate text-sm", thread.archived && "text-[var(--muted-foreground)]")}>
                  {name}
                </span>
                <span className="block text-[11px] text-[var(--muted-foreground)]">
                  {thread.archived ? "Archived · " : ""}
                  {ago(thread.lastRunAt ?? thread.updatedAt)}
                </span>
              </span>
              <span
                className="flex gap-0.5 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
                onClick={(e) => e.stopPropagation()}
              >
                <button type="button" title="Rename" aria-label={`Rename ${name}`} onClick={() => setRenaming({ id: thread.id, name: thread.name ?? "" })} className={iconButton}>
                  <Pencil className="size-3.5" />
                </button>
                <button
                  type="button"
                  title={thread.archived ? "Unarchive" : "Archive"}
                  aria-label={`${thread.archived ? "Unarchive" : "Archive"} ${name}`}
                  onClick={() => void setArchived(thread.id, !thread.archived)}
                  className={iconButton}
                >
                  {thread.archived ? <ArchiveRestore className="size-3.5" /> : <Archive className="size-3.5" />}
                </button>
                <button type="button" title="Delete" aria-label={`Delete ${name}`} onClick={() => remove(thread)} className={iconButton}>
                  <Trash2 className="size-3.5" />
                </button>
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
