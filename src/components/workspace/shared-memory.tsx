"use client";

import { useEffect, useState } from "react";
import { Building2, Check, FolderTree, History, Share2, Trash2, Undo2, Users, X } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  TYPES,
  field,
  sharedSelection,
  typeLabel,
  useMemory,
  when,
  type MemoryInput,
  type MemoryNote,
  type MemoryType,
  type SharedMode,
  type SharedNote,
  type SharedPlace,
  type SharedProposal,
  type SharedSummary,
  type SharedVersion,
} from "./memory";

/**
 * Shared memory in the Memory view (issue #93, step 3): notes your workspace,
 * knowledge nodes and groups share, each Auto (in every chat's index), Manual
 * (Claude finds it by searching) or Off for you; proposals waiting for their
 * editors; and sharing a copy of one of your own notes.
 */

const MODE_LABEL: Record<SharedMode, string> = { auto: "Auto", manual: "Manual", off: "Off" };
const MODE_HINT: Record<SharedMode, string> = {
  auto: "In every chat's memory index",
  manual: "Claude finds it only by searching",
  off: "Claude never reads it",
};

export function PlaceIcon({ place, className }: { place: SharedPlace; className?: string }) {
  const Icon = place.scope === "workspace" ? Building2 : place.scope === "node" ? FolderTree : Users;
  return <Icon className={cn("size-3.5 shrink-0 text-sky-600", className)} aria-hidden />;
}

const placeKey = (p: Pick<SharedPlace, "scope" | "nodeId" | "groupId">) => `${p.scope}:${p.nodeId ?? ""}:${p.groupId ?? ""}`;

function SharedRow({ note }: { note: SharedSummary }) {
  const { selected, openNote, setSharedMode } = useMemory();
  const key = sharedSelection(note.id);
  return (
    <div
      data-testid="shared-memory-row"
      data-memory={note.name}
      className={cn(
        "flex items-start gap-1.5 border-b border-[var(--border)] px-3 py-2 last:border-b-0 hover:bg-[var(--secondary)]",
        selected === key && "bg-[var(--secondary)]",
        note.mode === "off" && "opacity-60",
      )}
    >
      <button type="button" onClick={() => openNote(key)} className="flex min-w-0 flex-1 flex-col gap-0.5 text-left cursor-pointer">
        <span className="flex items-center gap-1.5">
          <PlaceIcon place={note.place} />
          <span className="min-w-0 flex-1 truncate font-medium">{note.name}</span>
        </span>
        <span className="line-clamp-2 text-xs text-[var(--muted-foreground)]">{note.description}</span>
      </button>
      <select
        aria-label={`Mode for ${note.name}`}
        title={MODE_HINT[note.mode]}
        value={note.mode}
        onChange={(e) => void setSharedMode(note.id, e.target.value as SharedMode, false)}
        className="rounded border border-[var(--border)] bg-[var(--background)] px-1 py-0.5 text-xs"
      >
        {(Object.keys(MODE_LABEL) as SharedMode[]).map((m) => (
          <option key={m} value={m}>
            {MODE_LABEL[m]}
          </option>
        ))}
      </select>
    </div>
  );
}

const OP_LABEL: Record<SharedProposal["op"], string> = { add: "new", update: "change", delete: "delete" };

function ProposalRow({ proposal }: { proposal: SharedProposal }) {
  const { decideShared } = useMemory();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const act = (decision: "accept" | "reject" | "withdraw") => {
    setBusy(true);
    setError(null);
    decideShared(proposal.id, decision)
      .catch((err: Error) => setError(err.message))
      .finally(() => setBusy(false));
  };
  const by = proposal.authorType === "agent" ? `Claude, for ${proposal.mine ? "you" : (proposal.author ?? "someone")}` : proposal.mine ? "You" : (proposal.author ?? "Someone");
  return (
    <div data-testid="shared-proposal" data-memory={proposal.name} className="border-b border-[var(--border)] px-3 py-2 last:border-b-0">
      <div className="flex items-center gap-1.5">
        <span className="rounded bg-sky-100 px-1.5 text-[10px] uppercase tracking-wide text-sky-900 dark:bg-sky-950 dark:text-sky-200">
          {OP_LABEL[proposal.op]}
        </span>
        <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="min-w-0 flex-1 truncate text-left font-medium hover:underline cursor-pointer">
          {proposal.name}
        </button>
        {proposal.canDecide && (
          <>
            <button
              type="button"
              disabled={busy}
              title="Accept"
              aria-label={`Accept shared ${proposal.name}`}
              onClick={() => act("accept")}
              className="flex size-6 items-center justify-center rounded text-green-700 hover:bg-[var(--secondary)] cursor-pointer"
            >
              <Check className="size-4" />
            </button>
            <button
              type="button"
              disabled={busy}
              title="Reject"
              aria-label={`Reject shared ${proposal.name}`}
              onClick={() => act("reject")}
              className="flex size-6 items-center justify-center rounded text-red-600 hover:bg-[var(--secondary)] cursor-pointer"
            >
              <X className="size-4" />
            </button>
          </>
        )}
        {proposal.mine && !proposal.canDecide && (
          <button
            type="button"
            disabled={busy}
            title="Withdraw"
            aria-label={`Withdraw ${proposal.name}`}
            onClick={() => act("withdraw")}
            className="flex size-6 items-center justify-center rounded text-[var(--muted-foreground)] hover:bg-[var(--secondary)] cursor-pointer"
          >
            <Undo2 className="size-4" />
          </button>
        )}
      </div>
      <p className="mt-0.5 flex items-center gap-1 text-xs text-[var(--muted-foreground)]">
        <PlaceIcon place={proposal.place} className="size-3" /> {proposal.place.label} · {by} · {when(proposal.createdAt)}
      </p>
      {proposal.reason && <p className="mt-0.5 text-xs italic text-[var(--muted-foreground)]">{proposal.reason}</p>}
      {open && proposal.op !== "delete" && (
        <pre className="mt-1 whitespace-pre-wrap rounded bg-[var(--secondary)] p-2 text-xs">
          {proposal.description}
          {"\n\n"}
          {proposal.body}
        </pre>
      )}
      {error && <p role="alert" className="mt-1 text-xs text-red-600">{error}</p>}
    </div>
  );
}

/** The Memory view's shared part: notes by place, and proposals. */
export function SharedSection() {
  const { shared, sharedProposals } = useMemory();
  if (!shared.length && !sharedProposals.length) return null;
  const places = new Map<string, { place: SharedPlace; notes: SharedSummary[] }>();
  for (const note of shared) {
    const key = placeKey(note.place);
    if (!places.has(key)) places.set(key, { place: note.place, notes: [] });
    places.get(key)!.notes.push(note);
  }
  return (
    <section aria-label="Shared memory" data-testid="shared-memory" className="mt-3 border-t border-[var(--border)]">
      <h3 className="flex items-center gap-1.5 px-3 pt-2 text-xs font-semibold">
        <Share2 className="size-3.5 text-sky-600" /> Shared with you ({shared.length})
      </h3>
      <p className="px-3 pb-1 text-xs text-[var(--muted-foreground)]">
        Notes your workspace, groups and knowledge nodes share. Claude only proposes changes to them.
      </p>
      {sharedProposals.length > 0 && (
        <div aria-label="Shared proposals" className="mx-3 my-1 rounded border border-[var(--border)] bg-[var(--secondary)]/40">
          <p className="px-3 pt-1.5 text-xs font-medium">Proposed changes ({sharedProposals.length})</p>
          {sharedProposals.map((p) => (
            <ProposalRow key={p.id} proposal={p} />
          ))}
        </div>
      )}
      {[...places.values()].map(({ place, notes }) => (
        <div key={placeKey(place)}>
          <p className="flex items-center gap-1 px-3 pt-2 text-[11px] uppercase tracking-wider text-[var(--muted-foreground)]">
            <PlaceIcon place={place} className="size-3" /> {place.label}
          </p>
          {notes.map((note) => (
            <SharedRow key={note.id} note={note} />
          ))}
        </div>
      ))}
    </section>
  );
}

/** The middle pane for a shared note: read it, and edit it where you can. */
export function SharedNoteEditor({ id }: { id: string }) {
  const { sharedDetail, updateShared, removeShared, setSharedMode, shared } = useMemory();
  const [note, setNote] = useState<SharedNote | null>(null);
  const [versions, setVersions] = useState<SharedVersion[]>([]);
  const [draft, setDraft] = useState<MemoryInput>({ description: "", type: "reference", body: "" });
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const listed = shared.find((n) => n.id === id);
  const stamp = listed ? `${listed.version}:${listed.mode}:${listed.everyoneMode}` : "";

  useEffect(() => {
    let live = true;
    sharedDetail(id)
      .then((d) => {
        if (!live) return;
        setNote(d.note);
        setVersions(d.versions);
        setDraft({ description: d.note.description, type: d.note.type, body: d.note.body });
        setError(null);
      })
      .catch((err: Error) => live && setError(err.message));
    return () => {
      live = false;
    };
  }, [id, sharedDetail, stamp]);

  if (!note) return <div className="p-6 text-sm text-[var(--muted-foreground)]">{error ?? "Loading…"}</div>;
  const changed = draft.description !== note.description || draft.type !== note.type || draft.body !== note.body;
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
  const readOnly = !note.canEdit;

  return (
    <div data-testid="shared-memory-editor" className="mx-auto flex max-w-3xl flex-col gap-3 p-6">
      <div className="flex items-center gap-2">
        <PlaceIcon place={note.place} className="size-5" />
        <h2 className="text-lg font-semibold">{note.name}</h2>
        <span className="rounded bg-sky-100 px-1.5 text-xs text-sky-900 dark:bg-sky-950 dark:text-sky-200">Shared · {note.place.label}</span>
      </div>
      <p className="text-xs text-[var(--muted-foreground)]">
        Version {note.version} · {when(note.updatedAt)}
        {readOnly && " · Only its editors change it; Claude can propose changes."}
      </p>
      <div className="flex flex-wrap items-center gap-3 text-xs">
        <label className="flex items-center gap-1.5">
          For you
          <select
            aria-label="Mode for you"
            value={note.myMode ?? ""}
            onChange={(e) => void run(() => setSharedMode(id, (e.target.value || null) as SharedMode | null, false))}
            className="rounded border border-[var(--border)] bg-[var(--background)] px-1 py-0.5"
          >
            <option value="">Default ({MODE_LABEL[note.everyoneMode]})</option>
            {(Object.keys(MODE_LABEL) as SharedMode[]).map((m) => (
              <option key={m} value={m}>
                {MODE_LABEL[m]}: {MODE_HINT[m]}
              </option>
            ))}
          </select>
        </label>
        {note.canEdit && (
          <label className="flex items-center gap-1.5">
            For everyone
            <select
              aria-label="Mode for everyone"
              value={note.everyoneMode}
              onChange={(e) => void run(() => setSharedMode(id, e.target.value as SharedMode, true))}
              className="rounded border border-[var(--border)] bg-[var(--background)] px-1 py-0.5"
            >
              {(Object.keys(MODE_LABEL) as SharedMode[]).map((m) => (
                <option key={m} value={m}>
                  {MODE_LABEL[m]}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      <label className="flex flex-col gap-1 text-xs font-medium">
        Description
        <input
          aria-label="Description"
          readOnly={readOnly}
          value={draft.description}
          onChange={(e) => setDraft({ ...draft, description: e.target.value })}
          className={field}
        />
      </label>
      <label className="flex flex-col gap-1 text-xs font-medium">
        Type
        <select
          aria-label="Type"
          disabled={readOnly}
          value={draft.type}
          onChange={(e) => setDraft({ ...draft, type: e.target.value as MemoryType })}
          className={cn(field, "max-w-xs")}
        >
          {TYPES.map((t) => (
            <option key={t.type} value={t.type}>
              {t.label}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-xs font-medium">
        Note
        <textarea
          aria-label="Note"
          readOnly={readOnly}
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
      {note.canEdit && (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={!changed || saving}
            onClick={() => void run(async () => setNote(await updateShared(id, draft, note.version)))}
            className="rounded bg-[var(--primary)] px-3 py-1.5 text-sm text-[var(--primary-foreground)] disabled:opacity-50 cursor-pointer"
          >
            Save
          </button>
          <button
            type="button"
            disabled={saving}
            onClick={() => {
              if (window.confirm(`Delete the shared note "${note.name}" for everyone? This can't be undone.`)) {
                void run(() => removeShared(id));
              }
            }}
            className="ml-auto flex items-center gap-1 rounded px-3 py-1.5 text-sm text-red-600 hover:bg-red-50 dark:hover:bg-red-950 cursor-pointer"
          >
            <Trash2 className="size-3.5" /> Delete
          </button>
        </div>
      )}
      {versions.length > 1 && (
        <section aria-label="Versions" className="mt-2 border-t border-[var(--border)] pt-3">
          <h3 className="mb-1 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-[var(--muted-foreground)]">
            <History className="size-3.5" /> Versions
          </h3>
          {versions.map((v) => (
            <p key={v.version} className="py-0.5 text-xs">
              v{v.version} · {v.changedAs === "agent" ? `Claude, for ${v.changedBy ?? "someone"}` : (v.changedBy ?? "Someone")} · {when(v.createdAt)}
            </p>
          ))}
        </section>
      )}
    </div>
  );
}

/**
 * Shares a copy of one of your notes: you pick the place and check the text
 * first. Later edits to your note don't change the copy.
 */
export function ShareCopy({ note }: { note: MemoryNote }) {
  const { targets, shareCopy, openNote } = useMemory();
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState(0);
  const [draft, setDraft] = useState({ name: note.name, description: note.description, body: note.body });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  if (!targets.length) return null;
  if (!open) {
    return (
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => {
            setDraft({ name: note.name, description: note.description, body: note.body });
            setDone(null);
            setOpen(true);
          }}
          className="flex items-center gap-1 self-start rounded border border-[var(--border)] px-3 py-1.5 text-sm hover:bg-[var(--secondary)] cursor-pointer"
        >
          <Share2 className="size-3.5" /> Share a copy…
        </button>
        {done && <p role="status" className="text-xs text-[var(--muted-foreground)]">{done}</p>}
      </div>
    );
  }
  const place = targets[Math.min(target, targets.length - 1)];
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const made = await shareCopy(place, draft.name.trim(), { description: draft.description, type: note.type, body: draft.body });
      setOpen(false);
      if (made.note) {
        setDone(`Shared to ${place.label}.`);
        openNote(sharedSelection(made.note.id));
      } else {
        setDone(`Sent to ${place.label}'s editors for review.`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section aria-label="Share a copy" data-testid="share-copy" className="flex flex-col gap-2 rounded border border-sky-300 bg-sky-50/50 p-3 dark:border-sky-800 dark:bg-sky-950/30">
      <h3 className="flex items-center gap-1.5 text-sm font-semibold">
        <Share2 className="size-4 text-sky-600" /> Share a copy of {typeLabel(note.type).toLowerCase()} note {note.name}
      </h3>
      <p className="text-xs text-[var(--muted-foreground)]">
        Everyone there will see this text. Take out anything private first. Later edits to your note won&apos;t change the copy.
      </p>
      <label className="flex flex-col gap-1 text-xs font-medium">
        Share to
        <select aria-label="Share to" value={target} onChange={(e) => setTarget(Number(e.target.value))} className={cn(field, "max-w-sm")}>
          {targets.map((t, i) => (
            <option key={placeKey(t)} value={i}>
              {t.label}
              {t.canEdit ? "" : " (its editors review it first)"}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-xs font-medium">
        Name
        <input aria-label="Shared name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} className={cn(field, "max-w-xs")} />
      </label>
      <label className="flex flex-col gap-1 text-xs font-medium">
        Description
        <input aria-label="Shared description" value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} className={field} />
      </label>
      <label className="flex flex-col gap-1 text-xs font-medium">
        Text to share
        <textarea aria-label="Shared text" rows={6} value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} className={cn(field, "font-mono text-[13px]")} />
      </label>
      {error && <p role="alert" className="text-xs text-red-600">{error}</p>}
      <div className="flex gap-2">
        <button
          type="button"
          disabled={busy || !draft.name.trim()}
          onClick={() => void submit()}
          className="rounded bg-[var(--primary)] px-3 py-1.5 text-sm text-[var(--primary-foreground)] disabled:opacity-50 cursor-pointer"
        >
          {place.canEdit ? "Share" : "Send for review"}
        </button>
        <button type="button" onClick={() => setOpen(false)} className="rounded px-3 py-1.5 text-sm hover:bg-[var(--secondary)] cursor-pointer">
          Cancel
        </button>
      </div>
    </section>
  );
}
