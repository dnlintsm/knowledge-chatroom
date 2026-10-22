"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { Archive, Bot, Brain, Download, EyeOff, History, Plus, RotateCcw, Trash2, Undo2 } from "lucide-react";
import { useAgent, useCopilotChatConfiguration } from "@copilotkit/react-core/v2";
import { cn } from "@/lib/utils";
import { MEMORY_TAB } from "./types";
import { useWorkbench } from "./workbench";

/**
 * Personalized memory (issue #93): notes Claude keeps about you across chats,
 * that only you can see.
 * - the Memory view of the side panel lists your notes, turns memory on or
 *   off for you, and exports them; a note opens in the middle pane to edit,
 *   with its versions;
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

/** A note Claude read or changed in this turn (the agent's "memory" event). */
export interface MemoryEvent {
  id: string;
  name: string;
  description: string;
  kind: "read" | "create" | "update" | "archive";
  version: number;
  /** Set here once the user undid it. */
  undone?: boolean;
}

export interface MemoryInput {
  description: string;
  type: MemoryType;
  body: string;
}

const TYPES: { type: MemoryType; label: string; hint: string }[] = [
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

interface Memory {
  status: "loading" | "ready" | "unavailable";
  /** Memory on or off for you (all chats). */
  mode: "on" | "off";
  /** This chat is incognito: Claude neither reads nor saves memory in it. */
  incognito: boolean;
  notes: MemorySummary[];
  /** The note open in the editor; NEW_NOTE for a new one; null for none. */
  selected: string | null;
  /** Opens a note (or a new one) in the middle pane. */
  openNote: (name: string) => void;
  reload: () => Promise<void>;
  setMode: (mode: "on" | "off") => Promise<void>;
  setIncognito: (incognito: boolean) => Promise<void>;
  detail: (name: string) => Promise<{ note: MemoryNote; versions: MemoryVersion[] }>;
  save: (name: string, input: MemoryInput, create?: boolean) => Promise<MemoryNote>;
  remove: (name: string) => Promise<void>;
  archive: (name: string, archived: boolean) => Promise<void>;
  restore: (name: string, version: number) => Promise<void>;
  /** Undoes one of Claude's changes in this turn. */
  undo: (event: MemoryEvent) => Promise<void>;
  turn: Turn;
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
  const [selected, setSelected] = useState<string | null>(null);
  const threadId = useCopilotChatConfiguration()?.threadId;
  const { editor } = useWorkbench();

  const reload = useCallback(async () => {
    try {
      const query = threadId ? `?thread=${encodeURIComponent(threadId)}` : "";
      const data = await call<{ mode: Memory["mode"]; incognito: boolean; notes: MemorySummary[] }>(`/api/memory${query}`);
      setModeState(data.mode);
      setIncognitoState(data.incognito);
      setNotes(data.notes);
      setStatus("ready");
    } catch {
      setStatus("unavailable");
    }
  }, [threadId]);

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

  const value = useMemo(
    () => ({
      status, mode, incognito, notes, selected, openNote, reload, setMode, setIncognito,
      detail, save, remove, archive, restore, undo, turn,
    }),
    [status, mode, incognito, notes, selected, openNote, reload, setMode, setIncognito, detail, save, remove, archive, restore, undo, turn],
  );
  return <MemoryContext.Provider value={value}>{children}</MemoryContext.Provider>;
}

const typeLabel = (type: MemoryType) => TYPES.find((t) => t.type === type)?.label ?? type;

const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

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
  const { status, mode, notes, setMode, openNote } = useMemory();
  const [showArchived, setShowArchived] = useState(false);
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
          <input
            type="checkbox"
            role="switch"
            data-testid="memory-mode"
            checked={mode === "on"}
            onChange={(e) => void setMode(e.target.checked ? "on" : "off")}
          />
          Claude remembers
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
        {mode === "on"
          ? "Notes Claude keeps about you across chats. Only you can see them; edit or delete any. Incognito chats leave them alone."
          : "Memory is off: Claude doesn't read or save notes in any chat. Your notes stay here."}
      </p>
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
    </div>
  );
}

const field =
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
};

/** Under the chat input: what Claude read and changed in this turn, Undo, and incognito. */
export function MemoryStatus() {
  const { status, mode, incognito, setIncognito, turn, undo, openNote } = useMemory();
  const [failed, setFailed] = useState<string | null>(null);
  if (status !== "ready") return null;
  // One chip per note: its latest change, else that Claude read it.
  const byNote = new Map<string, MemoryEvent>();
  for (const event of turn.events) {
    const seen = byNote.get(event.name);
    if (!seen || event.kind !== "read") byNote.set(event.name, event);
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
            key={event.name}
            data-testid="memory-chip"
            data-kind={event.kind}
            className={cn(
              "flex items-center gap-1 rounded-full px-2 py-0.5",
              event.kind === "read" ? "bg-[var(--secondary)]" : "bg-violet-100 text-violet-900 dark:bg-violet-950 dark:text-violet-200",
              event.undone && "line-through opacity-60",
            )}
          >
            <button type="button" title={event.description} onClick={() => openNote(event.name)} className="cursor-pointer hover:underline">
              {event.name}
            </button>
            <span className="opacity-70">· {CHANGE_LABEL[event.kind]}</span>
            {event.kind !== "read" && !event.undone && (
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
