"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { Archive, Bot, Brain, Check, Download, EyeOff, History, Inbox, Plus, RotateCcw, Trash2, Undo2, X } from "lucide-react";
import { useAgent, useCopilotChatConfiguration } from "@copilotkit/react-core/v2";
import { cn } from "@/lib/utils";
import { SharedNoteEditor, SharedSection, ShareCopy } from "./shared-memory";
import { useWorkspace } from "./store";
import { MEMORY_TAB } from "./types";
import { useWorkbench } from "./workbench";

/**
 * Personalized memory (issue #93): notes Claude keeps about you across chats,
 * that only you can see.
 * - the Memory view of the side panel lists your notes, sets memory on, ask
 *   first or off for you, and exports them; it also holds the inbox (changes
 *   Claude proposed, to accept or reject) and Claude's recent changes, with
 *   Undo; a note opens in the middle pane to edit, with its versions;
 * - under the chat input, a line says which notes Claude read or changed in
 *   the current turn (the agent sends a "memory" event for each), with Undo
 *   for its changes, and makes the chat incognito: no memory read or saved.
 * The agent server keeps the notes (/api/memory); it needs MEMORY=on and
 * server storage, and without them memory doesn't show at all.
 */

export type MemoryType = "preference" | "profile" | "project" | "reference" | "feedback";

export interface MemorySummary {
  name: string;
  description: string;
  type: MemoryType;
  version: number;
  createdBy: "user" | "agent";
  updatedBy: "user" | "agent";
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
}

export interface MemoryNote extends MemorySummary {
  body: string;
}

export interface MemoryVersion {
  version: number;
  description: string;
  type: MemoryType;
  body: string;
  changedBy: "user" | "agent";
  createdAt: string;
}

/** A change Claude proposed, waiting for you. */
export interface InboxItem {
  id: string;
  op: "add" | "update" | "delete";
  name: string;
  description: string | null;
  type: MemoryType | null;
  body: string | null;
  source: "chat" | "learn";
  reason: string | null;
  createdAt: string;
}

/** One of Claude's changes, in the activity list. */
export interface MemoryActivity {
  id: string;
  name: string;
  kind: "create" | "update" | "archive";
  source: "chat" | "learn" | "inbox";
  at: string;
  undone: boolean;
  /** Still the note's latest change, so it can be undone. */
  undoable: boolean;
}

/** A note Claude read, changed or proposed a change to in this turn (the agent's "memory" event). */
export interface MemoryEvent {
  id: string;
  name: string;
  description: string;
  kind: "read" | "create" | "update" | "archive" | "propose";
  version: number;
  /** A shared note's: which one, and where it lives. */
  shared?: { id: string; label: string };
  /** Set here once the user undid it. */
  undone?: boolean;
}

export type SharedScope = "workspace" | "node" | "group";
export type SharedMode = "auto" | "manual" | "off";

/** Where a shared note lives. */
export interface SharedPlace {
  scope: SharedScope;
  nodeId: string | null;
  groupId: string | null;
  label: string;
}

/** A note shared with you: by your workspace, a knowledge node or a group. */
export interface SharedSummary {
  id: string;
  name: string;
  description: string;
  type: MemoryType;
  version: number;
  place: SharedPlace;
  canEdit: boolean;
  /** What applies to you: yours, else everyone's. */
  mode: SharedMode;
  myMode: SharedMode | null;
  everyoneMode: SharedMode;
  updatedAt: string;
}

export interface SharedNote extends SharedSummary {
  body: string;
}

export interface SharedVersion {
  version: number;
  description: string;
  type: MemoryType;
  body: string;
  changedBy: string | null;
  changedAs: "user" | "agent";
  createdAt: string;
}

/** A change to shared memory waiting for its editors. */
export interface SharedProposal {
  id: string;
  op: "add" | "update" | "delete";
  place: SharedPlace;
  memoryId: string | null;
  name: string;
  description: string | null;
  type: MemoryType | null;
  body: string | null;
  author: string | null;
  authorType: "user" | "agent";
  mine: boolean;
  canDecide: boolean;
  reason: string | null;
  createdAt: string;
}

/** A place you can share a copy of a note to. */
export interface SharedTarget extends SharedPlace {
  canEdit: boolean;
}

/** In the editor, a shared note is `shared:<id>`. */
export const sharedSelection = (id: string) => `shared:${id}`;

export interface MemoryInput {
  description: string;
  type: MemoryType;
  body: string;
}

export const TYPES: { type: MemoryType; label: string; hint: string }[] = [
  { type: "preference", label: "Preference", hint: "How you like to work" },
  { type: "profile", label: "Profile", hint: "Who you are, your role" },
  { type: "project", label: "Project", hint: "Ongoing work and its decisions" },
  { type: "feedback", label: "Feedback", hint: "Corrections you gave Claude" },
  { type: "reference", label: "Reference", hint: "Where things are" },
];

/** In the editor, a note not saved yet. */
export const NEW_NOTE = "";

interface Turn {
  running: boolean;
  events: MemoryEvent[];
}

export type MemoryMode = "on" | "ask" | "off";

interface Memory {
  status: "loading" | "ready" | "unavailable";
  /** For you, in all chats: on (Claude changes notes, with Undo), ask (changes wait in the inbox) or off. */
  mode: MemoryMode;
  /** This chat is incognito: Claude neither reads nor saves memory in it. */
  incognito: boolean;
  notes: MemorySummary[];
  /** Changes Claude proposed, waiting for you. */
  inbox: InboxItem[];
  accept: (id: string) => Promise<void>;
  reject: (id: string) => Promise<void>;
  /** Claude's recent changes; loads them. */
  activity: () => Promise<MemoryActivity[]>;
  /** Undoes one of Claude's changes, by its id. */
  undoChange: (id: string) => Promise<void>;
  /** The note open in the editor; NEW_NOTE for a new one; null for none. */
  selected: string | null;
  /** Opens a note (or a new one) in the middle pane. */
  openNote: (name: string) => void;
  reload: () => Promise<void>;
  setMode: (mode: MemoryMode) => Promise<void>;
  setIncognito: (incognito: boolean) => Promise<void>;
  detail: (name: string) => Promise<{ note: MemoryNote; versions: MemoryVersion[] }>;
  save: (name: string, input: MemoryInput, create?: boolean) => Promise<MemoryNote>;
  remove: (name: string) => Promise<void>;
  archive: (name: string, archived: boolean) => Promise<void>;
  restore: (name: string, version: number) => Promise<void>;
  /** Undoes one of Claude's changes in this turn. */
  undo: (event: MemoryEvent) => Promise<void>;
  turn: Turn;
  /** Shared memory (step 3): notes you read, proposals, where you can share. */
  shared: SharedSummary[];
  sharedProposals: SharedProposal[];
  targets: SharedTarget[];
  sharedDetail: (id: string) => Promise<{ note: SharedNote; versions: SharedVersion[] }>;
  /** Shares a copy; a proposal when you can't edit the place. */
  shareCopy: (
    target: Pick<SharedPlace, "scope" | "nodeId" | "groupId">,
    name: string,
    input: MemoryInput,
  ) => Promise<{ note: SharedNote | null; proposal: SharedProposal | null }>;
  updateShared: (id: string, input: MemoryInput, version: number) => Promise<SharedNote>;
  removeShared: (id: string) => Promise<void>;
  /** null clears yours, back to everyone's; `everyone` sets theirs (editors). */
  setSharedMode: (id: string, mode: SharedMode | null, everyone: boolean) => Promise<void>;
  decideShared: (id: string, decision: "accept" | "reject" | "withdraw") => Promise<void>;
}

const MemoryContext = createContext<Memory | null>(null);

export function useMemory(): Memory {
  const memory = useContext(MemoryContext);
  if (!memory) throw new Error("useMemory needs a MemoryProvider");
  return memory;
}

/** The answer's JSON, or an Error with the server's message. */
async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { cache: "no-store", ...init });
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
  return body as T;
}

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

const noteUrl = (name: string, action = "") =>
  `/api/memory/notes/${encodeURIComponent(name)}${action ? `/${action}` : ""}`;

export function MemoryProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Memory["status"]>("loading");
  const [mode, setModeState] = useState<Memory["mode"]>("on");
  const [incognito, setIncognitoState] = useState(false);
  const [notes, setNotes] = useState<MemorySummary[]>([]);
  const [inbox, setInbox] = useState<InboxItem[]>([]);
  const [shared, setShared] = useState<SharedSummary[]>([]);
  const [sharedProposals, setSharedProposals] = useState<SharedProposal[]>([]);
  const [targets, setTargets] = useState<SharedTarget[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const threadId = useCopilotChatConfiguration()?.threadId;
  const { editor } = useWorkbench();
  // The knowledge node you're in: you can share a copy there.
  const nodeId = useWorkspace().node;

  const reload = useCallback(async () => {
    try {
      const query = new URLSearchParams();
      if (threadId) query.set("thread", threadId);
      if (nodeId) query.set("node", nodeId);
      const data = await call<{
        mode: Memory["mode"];
        incognito: boolean;
        notes: MemorySummary[];
        inbox?: InboxItem[];
        shared?: SharedSummary[];
        sharedProposals?: SharedProposal[];
        targets?: SharedTarget[];
      }>(`/api/memory${query.size ? `?${query}` : ""}`);
      setModeState(data.mode);
      setIncognitoState(data.incognito);
      setNotes(data.notes);
      setInbox(data.inbox ?? []);
      setShared(data.shared ?? []);
      setSharedProposals(data.sharedProposals ?? []);
      setTargets(data.targets ?? []);
      setStatus("ready");
    } catch {
      setStatus("unavailable");
    }
  }, [threadId, nodeId]);

  useEffect(() => void reload(), [reload]);

  const openNote = useCallback(
    (name: string) => {
      setSelected(name);
      editor.open(MEMORY_TAB);
    },
    [editor],
  );

  // Privacy switches show as set only once the server has them, so the UI
  // never claims memory is off while a run could still use it.
  const setMode = useCallback(
    async (next: Memory["mode"]) => {
      try {
        const saved = await call<{ mode: Memory["mode"] }>(`/api/memory/settings`, json("PUT", { mode: next }));
        setModeState(saved.mode);
      } catch {
        await reload();
      }
    },
    [reload],
  );

  const setIncognito = useCallback(
    async (next: boolean) => {
      if (!threadId) return;
      try {
        const saved = await call<{ incognito: boolean }>(`/api/memory/settings`, json("PUT", { thread: threadId, incognito: next }));
        setIncognitoState(saved.incognito);
      } catch {
        await reload();
      }
    },
    [reload, threadId],
  );

  const detail = useCallback(
    (name: string) => call<{ note: MemoryNote; versions: MemoryVersion[] }>(noteUrl(name)),
    [],
  );

  const save = useCallback(
    async (name: string, input: MemoryInput, create = false) => {
      const { note } = await call<{ note: MemoryNote }>(`${noteUrl(name)}${create ? "?create=1" : ""}`, json("PUT", input));
      await reload();
      return note;
    },
    [reload],
  );

  const remove = useCallback(
    async (name: string) => {
      await call(noteUrl(name), { method: "DELETE" });
      setSelected((s) => (s === name ? null : s));
      await reload();
    },
    [reload],
  );

  const archive = useCallback(
    async (name: string, archived: boolean) => {
      await call(noteUrl(name, "archive"), json("POST", { archived }));
      await reload();
    },
    [reload],
  );

  const restore = useCallback(
    async (name: string, version: number) => {
      await call(noteUrl(name, "restore"), json("POST", { version }));
      await reload();
    },
    [reload],
  );

  const decide = useCallback(
    async (id: string, action: "accept" | "reject") => {
      try {
        await call(`/api/memory/inbox/${encodeURIComponent(id)}/${action}`, { method: "POST" });
      } finally {
        await reload();
      }
    },
    [reload],
  );
  const accept = useCallback((id: string) => decide(id, "accept"), [decide]);
  const reject = useCallback((id: string) => decide(id, "reject"), [decide]);

  const activity = useCallback(
    async () => (await call<{ activity: MemoryActivity[] }>("/api/memory/activity")).activity,
    [],
  );

  const undoChange = useCallback(
    async (id: string) => {
      try {
        await call(`/api/memory/events/${encodeURIComponent(id)}/undo`, { method: "POST" });
      } finally {
        await reload();
      }
    },
    [reload],
  );

  // What the current turn read and changed, from the agent's "memory" events.
  const { agent } = useAgent();
  const [turn, setTurn] = useState<Turn>({ running: false, events: [] });
  useEffect(() => setTurn({ running: false, events: [] }), [threadId]);
  useEffect(() => {
    const sub = agent.subscribe({
      onRunStartedEvent: () => setTurn({ running: true, events: [] }),
      onCustomEvent: ({ event }) => {
        if (event.name !== "memory") return;
        const change = event.value as MemoryEvent;
        setTurn((t) => ({ ...t, events: [...t.events, change] }));
        if (change.kind !== "read") void reload();
      },
      onRunFinalized: () => setTurn((t) => ({ ...t, running: false })),
    });
    return () => sub.unsubscribe();
  }, [agent, reload]);

  const undo = useCallback(
    async (event: MemoryEvent) => {
      await call(`/api/memory/events/${encodeURIComponent(event.id)}/undo`, { method: "POST" });
      setTurn((t) => ({ ...t, events: t.events.map((e) => (e.id === event.id ? { ...e, undone: true } : e)) }));
      await reload();
    },
    [reload],
  );

  const sharedUrl = (id: string, action = "") => `/api/memory/shared/${encodeURIComponent(id)}${action ? `/${action}` : ""}`;
  const sharedDetail = useCallback(
    (id: string) => call<{ note: SharedNote; versions: SharedVersion[] }>(sharedUrl(id)),
    [],
  );
  const shareCopy = useCallback(
    async (target: Pick<SharedPlace, "scope" | "nodeId" | "groupId">, name: string, input: MemoryInput) => {
      const made = await call<{ note: SharedNote | null; proposal: SharedProposal | null }>(
        "/api/memory/shared",
        json("POST", { ...target, name, ...input }),
      );
      await reload();
      return made;
    },
    [reload],
  );
  const updateShared = useCallback(
    async (id: string, input: MemoryInput, version: number) => {
      const { note } = await call<{ note: SharedNote }>(sharedUrl(id), json("PUT", { ...input, version }));
      await reload();
      return note;
    },
    [reload],
  );
  const removeShared = useCallback(
    async (id: string) => {
      await call(sharedUrl(id), { method: "DELETE" });
      setSelected((s) => (s === sharedSelection(id) ? null : s));
      await reload();
    },
    [reload],
  );
  const setSharedMode = useCallback(
    async (id: string, next: SharedMode | null, everyone: boolean) => {
      try {
        await call(sharedUrl(id, "mode"), json("PUT", { mode: next, everyone }));
      } finally {
        await reload();
      }
    },
    [reload],
  );
  const decideShared = useCallback(
    async (id: string, decision: "accept" | "reject" | "withdraw") => {
      try {
        await call(`/api/memory/shared/proposals/${encodeURIComponent(id)}/${decision}`, { method: "POST" });
      } finally {
        await reload();
      }
    },
    [reload],
  );

  const value = useMemo(
    () => ({
      status, mode, incognito, notes, inbox, accept, reject, activity, undoChange, selected, openNote, reload,
      setMode, setIncognito, detail, save, remove, archive, restore, undo, turn,
      shared, sharedProposals, targets, sharedDetail, shareCopy, updateShared, removeShared, setSharedMode, decideShared,
    }),
    [
      status, mode, incognito, notes, inbox, accept, reject, activity, undoChange, selected, openNote, reload,
      setMode, setIncognito, detail, save, remove, archive, restore, undo, turn,
      shared, sharedProposals, targets, sharedDetail, shareCopy, updateShared, removeShared, setSharedMode, decideShared,
    ],
  );
  return <MemoryContext.Provider value={value}>{children}</MemoryContext.Provider>;
}

export const typeLabel = (type: MemoryType) => TYPES.find((t) => t.type === type)?.label ?? type;

export const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

const STALE_DAYS = 60;
const isStale = (note: MemorySummary) =>
  !note.archived && Date.now() - Date.parse(note.lastUsedAt ?? note.updatedAt) > STALE_DAYS * 86_400_000;

const OP_LABEL: Record<InboxItem["op"], string> = { add: "New", update: "Change", delete: "Delete" };

function InboxRow({ item }: { item: InboxItem }) {
  const { accept, reject } = useMemory();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const act = (fn: (id: string) => Promise<void>) => {
    setBusy(true);
    setError(null);
    fn(item.id)
      .catch((err: Error) => setError(err.message))
      .finally(() => setBusy(false));
  };
  return (
    <div data-testid="memory-inbox-item" data-memory={item.name} className="border-b border-[var(--border)] px-3 py-2 last:border-b-0">
      <div className="flex items-center gap-1.5">
        <span className="rounded bg-violet-100 px-1.5 text-[10px] uppercase tracking-wide text-violet-900 dark:bg-violet-950 dark:text-violet-200">
          {OP_LABEL[item.op]}
        </span>
        <span className="min-w-0 flex-1 truncate font-medium">{item.name}</span>
        <button
          type="button"
          disabled={busy}
          title="Accept"
          aria-label={`Accept ${item.name}`}
          onClick={() => act(accept)}
          className="flex size-6 items-center justify-center rounded text-green-700 hover:bg-[var(--secondary)] cursor-pointer"
        >
          <Check className="size-4" />
        </button>
        <button
          type="button"
          disabled={busy}
          title="Reject"
          aria-label={`Reject ${item.name}`}
          onClick={() => act(reject)}
          className="flex size-6 items-center justify-center rounded text-red-600 hover:bg-[var(--secondary)] cursor-pointer"
        >
          <X className="size-4" />
        </button>
      </div>
      {item.description && <p className="mt-0.5 text-xs">{item.description}</p>}
      <p className="mt-0.5 text-xs text-[var(--muted-foreground)]">
        {item.reason ?? (item.source === "learn" ? "From a past chat" : "From a chat")}
      </p>
      {item.body && (
        <details className="mt-1 text-xs">
          <summary className="cursor-pointer text-[var(--muted-foreground)]">Note</summary>
          <pre className="mt-1 whitespace-pre-wrap rounded bg-[var(--secondary)] p-1.5">{item.body}</pre>
        </details>
      )}
      {error && <p role="alert" className="mt-1 text-xs text-red-600">{error}</p>}
    </div>
  );
}

const ACTIVITY_LABEL: Record<MemoryActivity["kind"], string> = { create: "saved", update: "updated", archive: "deleted" };
const SOURCE_LABEL: Record<MemoryActivity["source"], string> = {
  chat: "in a chat",
  learn: "from a past chat",
  inbox: "accepted from the inbox",
};

/** Claude's recent changes, with Undo while each is the note's latest. */
function ActivityList() {
  const { activity, undoChange, notes } = useMemory();
  const [items, setItems] = useState<MemoryActivity[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Reloads when the notes change (Claude saved, you undid).
  const stamp = notes.map((n) => `${n.name}:${n.version}:${n.archived}`).join("|");
  useEffect(() => {
    let live = true;
    activity()
      .then((list) => live && setItems(list))
      .catch(() => live && setItems([]));
    return () => {
      live = false;
    };
  }, [activity, stamp]);
  if (!items) return <p className="px-3 py-1 text-xs text-[var(--muted-foreground)]">Loading…</p>;
  if (!items.length) return <p className="px-3 py-1 text-xs text-[var(--muted-foreground)]">No changes by Claude yet.</p>;
  return (
    <div data-testid="memory-activity">
      {error && <p role="alert" className="px-3 text-xs text-red-600">{error}</p>}
      {items.map((item) => (
        <div key={item.id} data-testid="memory-activity-item" className="flex items-center gap-1.5 px-3 py-1 text-xs">
          <span className={cn("min-w-0 flex-1 truncate", item.undone && "line-through opacity-60")}>
            <span className="font-medium">{item.name}</span> {ACTIVITY_LABEL[item.kind]} {SOURCE_LABEL[item.source]} ·{" "}
            {when(item.at)}
          </span>
          {item.undoable && (
            <button
              type="button"
              title="Undo this change"
              aria-label={`Undo ${item.name}`}
              onClick={() => {
                setError(null);
                undoChange(item.id).catch((err: Error) => setError(err.message));
              }}
              className="rounded p-0.5 hover:bg-[var(--secondary)] cursor-pointer"
            >
              <Undo2 className="size-3" />
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

function NoteRow({ note }: { note: MemorySummary }) {
  const { selected, openNote } = useMemory();
  return (
    <button
      type="button"
      data-testid="memory-row"
      data-memory={note.name}
      aria-current={selected === note.name}
      onClick={() => openNote(note.name)}
      className={cn(
        "flex w-full flex-col gap-0.5 border-b border-[var(--border)] px-3 py-2 text-left last:border-b-0 hover:bg-[var(--secondary)] cursor-pointer",
        selected === note.name && "bg-[var(--secondary)]",
      )}
    >
      <span className="flex items-center gap-1.5">
        <Brain className="size-3.5 shrink-0 text-violet-500" />
        <span className="min-w-0 flex-1 truncate font-medium">{note.name}</span>
        {isStale(note) && (
          <span title="Not used or changed in 60 days: still true?" className="text-[10px] text-amber-600">
            stale
          </span>
        )}
        {note.updatedBy === "agent" && (
          <span title="Claude changed it last">
            <Bot className="size-3.5 text-[var(--muted-foreground)]" />
          </span>
        )}
        <span className="shrink-0 rounded bg-[var(--secondary)] px-1.5 text-[10px] uppercase tracking-wide text-[var(--muted-foreground)]">
          {typeLabel(note.type)}
        </span>
      </span>
      <span className="line-clamp-2 text-xs text-[var(--muted-foreground)]">{note.description}</span>
    </button>
  );
}

/** The Memory view of the side panel. */
export function MemoryPanel() {
  const { status, mode, notes, inbox, setMode, openNote, reload } = useMemory();
  const [showArchived, setShowArchived] = useState(false);
  const [showActivity, setShowActivity] = useState(false);
  // Claude also learns from past chats in the background: catch up when the
  // panel opens and when you come back to the tab.
  useEffect(() => {
    void reload();
    const onVisible = () => document.visibilityState === "visible" && void reload();
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [reload]);
  if (status === "loading") return <p className="px-3 py-2 text-[var(--muted-foreground)]">Loading memory…</p>;
  if (status === "unavailable") {
    return <p className="px-3 py-2 text-[var(--muted-foreground)]">Memory isn&apos;t available on this server.</p>;
  }
  const active = notes.filter((n) => !n.archived);
  const archived = notes.filter((n) => n.archived);
  return (
    <div data-testid="memory-panel" className="flex flex-col">
      <div className="flex items-center gap-2 px-3 pb-2">
        <label className="flex flex-1 items-center gap-2 text-xs">
          Memory
          <select
            data-testid="memory-mode"
            value={mode}
            onChange={(e) => void setMode(e.target.value as MemoryMode)}
            className="rounded border border-[var(--border)] bg-[var(--background)] px-1 py-0.5 text-xs"
          >
            <option value="on">On</option>
            <option value="ask">Ask first</option>
            <option value="off">Off</option>
          </select>
        </label>
        <button
          type="button"
          title="New memory"
          aria-label="New memory"
          onClick={() => openNote(NEW_NOTE)}
          className="flex size-7 items-center justify-center rounded text-[var(--muted-foreground)] hover:bg-[var(--secondary)] hover:text-[var(--foreground)] cursor-pointer"
        >
          <Plus className="size-4" />
        </button>
        <a
          href="/api/memory/export"
          download="memory.zip"
          title="Export as .zip"
          aria-label="Export memory"
          className="flex size-7 items-center justify-center rounded text-[var(--muted-foreground)] hover:bg-[var(--secondary)] hover:text-[var(--foreground)]"
        >
          <Download className="size-4" />
        </a>
      </div>
      <p className="px-3 pb-2 text-xs text-[var(--muted-foreground)]">
        {mode === "off"
          ? "Memory is off: Claude doesn't read or save notes in any chat. Your notes stay here."
          : `Notes Claude keeps about you across chats, also learned from chats after they go quiet. Only you can see them; edit or delete any. Incognito chats leave them alone.${
              mode === "ask" ? " Claude's changes wait below for you to accept." : ""
            }`}
      </p>
      {inbox.length > 0 && (
        <section aria-label="For review" className="mb-2 border-y border-[var(--border)] bg-[var(--secondary)]/40">
          <h3 className="flex items-center gap-1.5 px-3 pt-2 text-xs font-semibold">
            <Inbox className="size-3.5 text-violet-500" /> For review ({inbox.length})
          </h3>
          {inbox.map((item) => (
            <InboxRow key={item.id} item={item} />
          ))}
        </section>
      )}
      {active.length === 0 && (
        <p className="px-3 py-2 text-[var(--muted-foreground)]">
          No memories yet. Tell Claude &ldquo;remember that…&rdquo;, or add one with +.
        </p>
      )}
      {active.map((note) => (
        <NoteRow key={note.name} note={note} />
      ))}
      {archived.length > 0 && (
        <>
          <button
            type="button"
            aria-expanded={showArchived}
            onClick={() => setShowArchived((s) => !s)}
            className="mt-2 flex items-center gap-1.5 px-3 py-1.5 text-xs text-[var(--muted-foreground)] hover:text-[var(--foreground)] cursor-pointer"
          >
            <Archive className="size-3.5" /> Archived ({archived.length})
          </button>
          {showArchived && archived.map((note) => <NoteRow key={note.name} note={note} />)}
        </>
      )}
      <SharedSection />
      <button
        type="button"
        aria-expanded={showActivity}
        onClick={() => setShowActivity((s) => !s)}
        className="mt-2 flex items-center gap-1.5 px-3 py-1.5 text-xs text-[var(--muted-foreground)] hover:text-[var(--foreground)] cursor-pointer"
      >
        <History className="size-3.5" /> Recent changes by Claude
      </button>
      {showActivity && <ActivityList />}
    </div>
  );
}

export const field =
  "w-full rounded border border-[var(--border)] bg-[var(--background)] px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--ring)]";

/** The middle pane's Memory tab: one note to read and edit, with its versions. */
export function MemoryEditor() {
  const { selected, status } = useMemory();
  if (status !== "ready" || selected === null) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-sm text-[var(--muted-foreground)]">
        Pick a memory in the Memory panel.
      </div>
    );
  }
  if (selected.startsWith("shared:")) return <SharedNoteEditor key={selected} id={selected.slice("shared:".length)} />;
  return <NoteEditor key={selected} name={selected} />;
}

function NoteEditor({ name }: { name: string }) {
  const { detail, save, remove, archive, restore, openNote, notes } = useMemory();
  const creating = name === NEW_NOTE;
  const [note, setNote] = useState<MemoryNote | null>(null);
  const [versions, setVersions] = useState<MemoryVersion[]>([]);
  const [draft, setDraft] = useState<MemoryInput & { name: string }>({ name: "", description: "", type: "preference", body: "" });
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [viewing, setViewing] = useState<number | null>(null);
  // Reloads when Claude (or another tab) changes the note.
  const listed = notes.find((n) => n.name === name);
  const stamp = listed ? `${listed.version}:${listed.archived}` : "";

  useEffect(() => {
    if (creating) return;
    let live = true;
    detail(name)
      .then((d) => {
        if (!live) return;
        setNote(d.note);
        setVersions(d.versions);
        setDraft({ name: d.note.name, description: d.note.description, type: d.note.type, body: d.note.body });
        setError(null);
      })
      .catch((err: Error) => live && setError(err.message));
    return () => {
      live = false;
    };
  }, [creating, detail, name, stamp]);

  const changed =
    creating || !note || draft.description !== note.description || draft.type !== note.type || draft.body !== note.body;

  const run = async (fn: () => Promise<unknown>) => {
    setSaving(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const onSave = () =>
    run(async () => {
      const target = creating ? draft.name.trim() : name;
      const saved = await save(target, { description: draft.description, type: draft.type, body: draft.body }, creating);
      if (creating) openNote(saved.name);
    });

  if (!creating && !note) {
    return <div className="p-6 text-sm text-[var(--muted-foreground)]">{error ?? "Loading…"}</div>;
  }
  const shown = viewing === null ? null : versions.find((v) => v.version === viewing);

  return (
    <div data-testid="memory-editor" className="mx-auto flex max-w-3xl flex-col gap-3 p-6">
      <div className="flex items-center gap-2">
        <Brain className="size-5 text-violet-500" />
        {creating ? (
          <input
            aria-label="Name"
            placeholder="name, e.g. writing-style"
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            className={cn(field, "max-w-xs font-medium")}
          />
        ) : (
          <h2 className="text-lg font-semibold">{name}</h2>
        )}
        {note?.archived && (
          <span className="rounded bg-[var(--secondary)] px-1.5 text-xs text-[var(--muted-foreground)]">Archived</span>
        )}
      </div>
      {note && (
        <p className="text-xs text-[var(--muted-foreground)]">
          Version {note.version} · {note.updatedBy === "agent" ? "Claude" : "You"} · {when(note.updatedAt)}
          {note.lastUsedAt && ` · Claude last read it ${when(note.lastUsedAt)}`}
        </p>
      )}
      <label className="flex flex-col gap-1 text-xs font-medium">
        Description (one line, in Claude&apos;s index)
        <input
          aria-label="Description"
          value={draft.description}
          onChange={(e) => setDraft({ ...draft, description: e.target.value })}
          className={field}
        />
      </label>
      <label className="flex flex-col gap-1 text-xs font-medium">
        Type
        <select
          aria-label="Type"
          value={draft.type}
          onChange={(e) => setDraft({ ...draft, type: e.target.value as MemoryType })}
          className={cn(field, "max-w-xs")}
        >
          {TYPES.map((t) => (
            <option key={t.type} value={t.type}>
              {t.label}: {t.hint}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-xs font-medium">
        Note
        <textarea
          aria-label="Note"
          value={draft.body}
          rows={10}
          onChange={(e) => setDraft({ ...draft, body: e.target.value })}
          className={cn(field, "font-mono text-[13px]")}
        />
      </label>
      {error && (
        <p role="alert" className="rounded bg-red-50 px-2 py-1.5 text-xs text-red-700 dark:bg-red-950 dark:text-red-300">
          {error}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={!changed || saving}
          onClick={() => void onSave()}
          className="rounded bg-[var(--primary)] px-3 py-1.5 text-sm text-[var(--primary-foreground)] disabled:opacity-50 cursor-pointer"
        >
          {note?.archived ? "Save and bring back" : "Save"}
        </button>
        {note && (
          <button
            type="button"
            disabled={saving}
            onClick={() => void run(() => archive(name, !note.archived))}
            className="flex items-center gap-1 rounded border border-[var(--border)] px-3 py-1.5 text-sm hover:bg-[var(--secondary)] cursor-pointer"
          >
            <Archive className="size-3.5" /> {note.archived ? "Bring back" : "Archive"}
          </button>
        )}
        {note && (
          <button
            type="button"
            disabled={saving}
            onClick={() => {
              if (window.confirm(`Delete the memory "${name}" and all its versions? This can't be undone.`)) {
                void run(() => remove(name));
              }
            }}
            className="ml-auto flex items-center gap-1 rounded px-3 py-1.5 text-sm text-red-600 hover:bg-red-50 dark:hover:bg-red-950 cursor-pointer"
          >
            <Trash2 className="size-3.5" /> Delete
          </button>
        )}
      </div>
      {note && !note.archived && <ShareCopy note={note} />}
      {versions.length > 1 && (
        <section aria-label="Versions" className="mt-2 border-t border-[var(--border)] pt-3">
          <h3 className="mb-1 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-[var(--muted-foreground)]">
            <History className="size-3.5" /> Versions
          </h3>
          {versions.map((v) => (
            <div key={v.version} data-testid="memory-version" className="flex items-center gap-2 py-1 text-xs">
              <button
                type="button"
                aria-pressed={viewing === v.version}
                onClick={() => setViewing(viewing === v.version ? null : v.version)}
                className="flex-1 text-left hover:underline cursor-pointer"
              >
                v{v.version} · {v.changedBy === "agent" ? "Claude" : "You"} · {when(v.createdAt)}
              </button>
              {note && v.version !== note.version && (
                <button
                  type="button"
                  onClick={() => void run(() => restore(name, v.version))}
                  className="flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-[var(--secondary)] cursor-pointer"
                >
                  <RotateCcw className="size-3" /> Restore
                </button>
              )}
            </div>
          ))}
          {shown && (
            <pre className="mt-2 whitespace-pre-wrap rounded bg-[var(--secondary)] p-2 text-xs">
              {shown.description}
              {"\n\n"}
              {shown.body}
            </pre>
          )}
        </section>
      )}
    </div>
  );
}

const CHANGE_LABEL: Record<MemoryEvent["kind"], string> = {
  read: "used",
  create: "saved",
  update: "updated",
  archive: "deleted",
  propose: "for review",
};

/** Under the chat input: what Claude read and changed in this turn, Undo, and incognito. */
export function MemoryStatus() {
  const { status, mode, incognito, setIncognito, turn, undo, openNote } = useMemory();
  const { sidebar } = useWorkbench();
  const [failed, setFailed] = useState<string | null>(null);
  if (status !== "ready") return null;
  // One chip per note: its latest change, else that Claude read it.
  const byNote = new Map<string, MemoryEvent>();
  for (const event of turn.events) {
    // A shared note can share its name with one of yours.
    const key = event.shared ? `shared:${event.shared.id || event.name}` : event.name;
    const seen = byNote.get(key);
    if (!seen || event.kind !== "read") byNote.set(key, event);
  }
  const chips = [...byNote.values()];
  const off = mode === "off";
  return (
    <div
      data-testid="memory-status"
      className="pointer-events-auto mx-auto flex max-w-3xl flex-wrap items-center gap-1.5 px-5 pt-1 text-xs text-[var(--muted-foreground)]"
    >
      <Brain className="size-3 shrink-0 text-violet-500" />
      {off ? (
        <span>Memory is off</span>
      ) : incognito ? (
        <span title="Claude doesn&apos;t read or save memory in this chat">Incognito: no memory in this chat</span>
      ) : chips.length > 0 ? (
        chips.map((event) => (
          <span
            key={event.shared ? `shared:${event.shared.id || event.name}` : event.name}
            data-testid="memory-chip"
            data-kind={event.kind}
            className={cn(
              "flex items-center gap-1 rounded-full px-2 py-0.5",
              event.kind === "read" ? "bg-[var(--secondary)]" : "bg-violet-100 text-violet-900 dark:bg-violet-950 dark:text-violet-200",
              event.undone && "line-through opacity-60",
            )}
          >
            <button
              type="button"
              title={
                event.kind === "propose"
                  ? event.shared
                    ? `Proposed to ${event.shared.label}'s shared memory`
                    : "Waiting in your Memory inbox"
                  : event.shared
                    ? `Shared · ${event.shared.label}: ${event.description}`
                    : event.description
              }
              onClick={() =>
                event.kind === "propose"
                  ? sidebar.show("memory")
                  : openNote(event.shared?.id ? sharedSelection(event.shared.id) : event.name)
              }
              className="cursor-pointer hover:underline"
            >
              {event.name}
            </button>
            <span className="opacity-70">· {CHANGE_LABEL[event.kind]}</span>
            {event.kind !== "read" && event.kind !== "propose" && !event.undone && (
              <button
                type="button"
                data-testid="memory-undo"
                title="Undo this change"
                aria-label={`Undo ${event.name}`}
                onClick={() =>
                  void undo(event).then(
                    () => setFailed(null),
                    (err: Error) => setFailed(err.message),
                  )
                }
                className="rounded p-0.5 hover:bg-violet-200 dark:hover:bg-violet-900 cursor-pointer"
              >
                <Undo2 className="size-3" />
              </button>
            )}
          </span>
        ))
      ) : (
        <span>{turn.running ? "No memory used yet" : "Claude remembers what helps across chats"}</span>
      )}
      {failed && <span role="alert" className="text-red-600">{failed}</span>}
      {!off && (
        <button
          type="button"
          data-testid="memory-incognito"
          aria-pressed={incognito}
          title={incognito ? "Use memory in this chat again" : "Keep this chat out of memory"}
          onClick={() => void setIncognito(!incognito)}
          className={cn(
            "ml-auto flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-[var(--secondary)] hover:text-[var(--foreground)] cursor-pointer",
            incognito && "bg-[var(--secondary)] text-[var(--foreground)]",
          )}
        >
          <EyeOff className="size-3" /> Incognito
        </button>
      )}
    </div>
  );
}
