"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Archive, FileDiff, FlaskConical, Lock, Plus, RotateCcw, Send, Share2, Trash2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  listPromotable,
  type Experiment,
  type ExperimentChange,
  type ExperimentStatus,
  type Promotable,
} from "./server-files";
import { useWorkspace } from "./store";
import { REVIEW_TAB } from "./types";

const STATUS_LABEL: Record<ExperimentStatus, string> = {
  draft: "Draft",
  shared: "Shared",
  archived: "Archived",
};

export function StatusBadge({ status, className }: { status: ExperimentStatus; className?: string }) {
  return (
    <span
      className={cn(
        "shrink-0 rounded-full px-1.5 text-[10px] font-medium uppercase tracking-wide",
        status === "draft" && "bg-[var(--secondary)] text-[var(--muted-foreground)]",
        status === "shared" && "bg-[var(--accent)] text-[var(--accent-foreground)]",
        status === "archived" && "border border-[var(--border)] text-[var(--muted-foreground)]",
        className,
      )}
    >
      {STATUS_LABEL[status]}
    </span>
  );
}

/**
 * The current experiment: what was tried (hypothesis, params), what came out
 * (results), and its status. Its author edits it; others who can see it read
 * it. Below, the other experiments on the same node side by side.
 */
export function ExperimentPanel() {
  const ws = useWorkspace();
  const exp = ws.experiment;
  const [error, setError] = useState<string | null>(null);
  if (!exp) {
    return <p className="p-8 text-sm text-[var(--muted-foreground)]">Loading the experiment…</p>;
  }
  const node = ws.lineage[ws.lineage.length - 1];
  const nodeName = node?.name ?? "its node";
  const canChange = exp.access === "writer";

  const save = async (change: ExperimentChange) => {
    try {
      await ws.updateExperiment(exp.id, change);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  const remove = async () => {
    if (!window.confirm(`Delete the experiment "${exp.title}" and its files?`)) return;
    try {
      await ws.deleteExperiment(exp.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div data-testid="experiment-panel" className="mx-auto flex max-w-3xl flex-col gap-6 px-8 py-6 text-sm">
      <header className="flex flex-col gap-2">
        <div className="flex items-center gap-2 text-xs text-[var(--muted-foreground)]">
          <FlaskConical className="size-3.5" />
          <span>
            Experiment on {nodeName}
            {exp.authorName && !exp.mine ? ` by ${exp.authorName}` : ""}, started{" "}
            {new Date(exp.forkedAt).toLocaleDateString(undefined, { dateStyle: "medium" })}
          </span>
          <StatusBadge status={exp.status} />
          {!canChange && (
            <span className="flex items-center gap-1">
              <Lock className="size-3" /> Read only
            </span>
          )}
        </div>
        <EditableText
          key={`title-${exp.id}`}
          label="Title"
          value={exp.title}
          readOnly={!canChange}
          onSave={(title) => save({ title })}
          className="text-xl font-semibold"
        />
        {exp.mine && (
          <div className="flex flex-wrap items-center gap-2">
            {exp.status === "draft" && (
              <ActionButton onClick={() => save({ status: "shared" })} title={`Everyone who can view ${nodeName} will see it`}>
                <Share2 className="size-3.5" /> Share
              </ActionButton>
            )}
            {exp.status === "shared" && (
              <ActionButton onClick={() => save({ status: "draft" })}>
                <Lock className="size-3.5" /> Make private
              </ActionButton>
            )}
            {exp.status !== "archived" ? (
              <ActionButton
                onClick={() => save({ status: "archived" })}
                title={`Read only from then on, and visible to everyone who can view ${nodeName}`}
              >
                <Archive className="size-3.5" /> Archive
              </ActionButton>
            ) : (
              <ActionButton onClick={() => save({ status: "shared" })}>
                <RotateCcw className="size-3.5" /> Restore
              </ActionButton>
            )}
            <ActionButton onClick={remove} destructive>
              <Trash2 className="size-3.5" /> Delete
            </ActionButton>
          </div>
        )}
        <p className="text-xs text-[var(--muted-foreground)]">
          {exp.status === "draft"
            ? "Only you can see this draft. "
            : `Everyone who can view ${nodeName} can see this. `}
          Its files started as a copy of {nodeName}&apos;s; changes here don&apos;t touch {nodeName}.
        </p>
        {error && (
          <p role="alert" className="text-xs text-red-500">
            {error}
          </p>
        )}
      </header>

      <Section title="Hypothesis">
        <EditableText
          key={`hypothesis-${exp.id}`}
          label="Hypothesis"
          value={exp.hypothesis}
          readOnly={!canChange}
          multiline
          placeholder={canChange ? "What do you expect, and why?" : "No hypothesis written."}
          onSave={(hypothesis) => save({ hypothesis })}
        />
      </Section>
      <Section title="Parameters">
        <KeyValues
          key={`params-${exp.id}`}
          label="Parameters"
          values={exp.params}
          readOnly={!canChange}
          onSave={(params) => save({ params })}
        />
      </Section>
      <Section title="Results">
        <KeyValues
          key={`results-${exp.id}`}
          label="Results"
          values={exp.results}
          readOnly={!canChange}
          onSave={(results) => save({ results })}
        />
      </Section>
      {canChange && <Promote experiment={exp} nodeName={nodeName} />}
      <Compare current={exp} nodeName={nodeName} />
    </div>
  );
}

/**
 * The files this experiment changed that its node doesn't have yet, to
 * propose to the node; someone who can edit there accepts or rejects them.
 */
function Promote({ experiment, nodeName }: { experiment: Experiment; nodeName: string }) {
  const ws = useWorkspace();
  const [files, setFiles] = useState<Promotable[] | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);
  // Changes here, and decisions on the node, change what there is to propose.
  const filesKey = ws.files.map((f) => `${f.path}@${f.updatedAt}`).join("|");
  const proposalsKey = ws.proposals.map((p) => `${p.id}@${p.updatedAt}`).join("|");

  useEffect(() => {
    let live = true;
    const timer = setTimeout(() => {
      listPromotable(experiment.id)
        .then((list) => {
          if (!live) return;
          setFiles(list);
          // Everything not proposed yet starts ticked.
          setChosen(new Set(list.filter((f) => !f.proposal).map((f) => f.path)));
        })
        .catch(() => live && setFiles([]));
    }, 400);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [experiment.id, filesKey, proposalsKey]);

  const propose = async () => {
    setBusy(true);
    try {
      const made = await ws.promote(experiment.id, [...chosen], note.trim() || undefined);
      setNote("");
      setMessage({
        text: `Proposed ${made.length} ${made.length === 1 ? "file" : "files"} to ${nodeName}. Someone who can edit ${nodeName} accepts or rejects them.`,
      });
    } catch (err) {
      setMessage({ text: err instanceof Error ? err.message : String(err), error: true });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title={`Propose to ${nodeName}`}>
      {files === null ? (
        <p className="text-xs text-[var(--muted-foreground)]">Looking for changes…</p>
      ) : files.length === 0 ? (
        <p className="text-xs text-[var(--muted-foreground)]">
          No changes yet that {nodeName} doesn&apos;t have. Files you change or add here can be
          proposed to it.
        </p>
      ) : (
        <div data-testid="promote" className="flex flex-col gap-2">
          <ul className="flex flex-col rounded-md border border-[var(--border)]">
            {files.map((f) => (
              <li key={f.path} className="flex items-center gap-2 border-b border-[var(--border)] px-3 py-1.5 last:border-b-0">
                <input
                  type="checkbox"
                  aria-label={`Propose ${f.path}`}
                  checked={chosen.has(f.path)}
                  onChange={(e) =>
                    setChosen((s) => {
                      const next = new Set(s);
                      if (e.target.checked) next.add(f.path);
                      else next.delete(f.path);
                      return next;
                    })
                  }
                />
                <span className="truncate font-[family-name:var(--font-code)] text-[12px]">{f.path}</span>
                <span className="text-[11px] text-[var(--muted-foreground)]">
                  {f.change === "new" ? "new" : "changed"}
                </span>
                {f.proposal && (
                  <span className="ml-auto rounded-full bg-[var(--accent)] px-1.5 text-[10px] font-medium uppercase tracking-wide text-[var(--accent-foreground)]">
                    Proposed
                  </span>
                )}
              </li>
            ))}
          </ul>
          <input
            aria-label="Why these changes"
            placeholder={`Why these belong in ${nodeName} (optional)`}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            className="h-8 rounded-md border border-[var(--border)] bg-transparent px-2 text-[13px] outline-none focus:ring-2 focus:ring-[var(--ring)]"
          />
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={busy || chosen.size === 0}
              onClick={() => void propose()}
              className="flex h-7 items-center gap-1 rounded-md bg-[var(--primary)] px-2 text-xs text-[var(--primary-foreground)] cursor-pointer disabled:cursor-default disabled:opacity-50"
            >
              <Send className="size-3.5" />
              Propose {chosen.size} {chosen.size === 1 ? "file" : "files"}
            </button>
            {files.some((f) => f.proposal) && (
              <button
                type="button"
                onClick={() => ws.open(REVIEW_TAB)}
                className="flex h-7 items-center gap-1 rounded-md border border-[var(--border)] px-2 text-xs cursor-pointer hover:bg-[var(--secondary)]"
              >
                <FileDiff className="size-3.5" /> See proposals
              </button>
            )}
          </div>
        </div>
      )}
      {message && (
        <p role={message.error ? "alert" : "status"} className={cn("text-xs", message.error ? "text-red-500" : "text-[var(--muted-foreground)]")}>
          {message.text}
        </p>
      )}
    </Section>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--muted-foreground)]">{title}</h3>
      {children}
    </section>
  );
}

function ActionButton({
  onClick,
  title,
  destructive,
  children,
}: {
  onClick: () => void;
  title?: string;
  destructive?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={cn(
        "flex h-7 items-center gap-1 rounded-md border border-[var(--border)] px-2 text-xs cursor-pointer hover:bg-[var(--secondary)]",
        destructive && "hover:text-[var(--destructive)]",
      )}
    >
      {children}
    </button>
  );
}

/** Text that saves when it loses focus (or on Enter, for one line). */
function EditableText({
  label,
  value,
  readOnly,
  multiline,
  placeholder,
  className,
  onSave,
}: {
  label: string;
  value: string;
  readOnly: boolean;
  multiline?: boolean;
  placeholder?: string;
  className?: string;
  onSave: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    if (draft !== value && (multiline || draft.trim())) onSave(draft);
    else setDraft(value);
  };
  const shared = cn(
    "w-full rounded-md border border-transparent bg-transparent px-2 py-1 outline-none",
    !readOnly && "hover:border-[var(--border)] focus:border-[var(--ring)]",
    className,
  );
  return multiline ? (
    <textarea
      aria-label={label}
      value={draft}
      readOnly={readOnly}
      placeholder={placeholder}
      rows={Math.max(3, draft.split("\n").length)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      className={cn(shared, "resize-y leading-relaxed")}
    />
  ) : (
    <input
      aria-label={label}
      value={draft}
      readOnly={readOnly}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
      className={shared}
    />
  );
}

/** How a value shows in an input: plain for text and numbers, JSON otherwise. */
const show = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v));
/** The reverse: numbers, true/false, null, and JSON objects or arrays come back typed. */
function parse(text: string): unknown {
  const t = text.trim();
  if (t !== "" && !Number.isNaN(Number(t))) return Number(t);
  if (/^(true|false|null)$/.test(t) || /^[[{]/.test(t)) {
    try {
      return JSON.parse(t);
    } catch {
      // Not JSON after all: keep the text.
    }
  }
  return text;
}

type Row = { key: string; value: string };

/** Name and value rows, saved as one object when a row is left or removed. */
function KeyValues({
  label,
  values,
  readOnly,
  onSave,
}: {
  label: string;
  values: Record<string, unknown>;
  readOnly: boolean;
  onSave: (values: Record<string, unknown>) => void;
}) {
  const fromValues = () => Object.entries(values).map(([key, value]) => ({ key, value: show(value) }));
  const [rows, setRows] = useState<Row[]>(fromValues);
  const group = useRef<HTMLDivElement>(null);
  const toObject = (list: Row[]) =>
    Object.fromEntries(list.filter((r) => r.key.trim()).map((r) => [r.key.trim(), parse(r.value)]));
  // Take in changes made elsewhere (Claude, another tab), unless you are
  // editing these rows right now.
  const saved = JSON.stringify(values);
  useEffect(() => {
    if (group.current?.contains(document.activeElement)) return;
    setRows((current) => (JSON.stringify(toObject(current)) === saved ? current : fromValues()));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saved]);
  const commit = (list: Row[]) => {
    const next = toObject(list);
    if (JSON.stringify(next) !== JSON.stringify(values)) onSave(next);
  };
  const singular = label === "Parameters" ? "parameter" : "result";

  if (readOnly && !rows.length) {
    return <p className="px-2 text-[var(--muted-foreground)]">None recorded.</p>;
  }
  return (
    <div
      ref={group}
      role="group"
      aria-label={label}
      className="flex flex-col gap-1"
      onBlur={(e) => {
        // Save once focus leaves the whole list, not on every field.
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) commit(rows);
      }}
    >
      {rows.map((row, i) => (
        <div key={i} className="flex items-center gap-2">
          <input
            aria-label={`${singular} name`}
            value={row.key}
            readOnly={readOnly}
            placeholder="name"
            onChange={(e) => setRows(rows.map((r, j) => (j === i ? { ...r, key: e.target.value } : r)))}
            className="w-1/3 rounded-md border border-[var(--border)] bg-transparent px-2 py-1 font-[family-name:var(--font-code)] text-xs outline-none focus:border-[var(--ring)]"
          />
          <input
            aria-label={`${row.key || singular} value`}
            value={row.value}
            readOnly={readOnly}
            placeholder="value"
            onChange={(e) => setRows(rows.map((r, j) => (j === i ? { ...r, value: e.target.value } : r)))}
            className="min-w-0 flex-1 rounded-md border border-[var(--border)] bg-transparent px-2 py-1 font-[family-name:var(--font-code)] text-xs outline-none focus:border-[var(--ring)]"
          />
          {!readOnly && (
            <button
              type="button"
              aria-label={`Remove ${row.key || singular}`}
              onClick={() => {
                const next = rows.filter((_, j) => j !== i);
                setRows(next);
                commit(next);
              }}
              className="flex size-6 items-center justify-center rounded text-[var(--muted-foreground)] hover:text-[var(--foreground)] cursor-pointer"
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>
      ))}
      {!readOnly && (
        <button
          type="button"
          onClick={() => setRows([...rows, { key: "", value: "" }])}
          className="flex w-fit items-center gap-1 rounded px-2 py-1 text-xs text-[var(--muted-foreground)] hover:bg-[var(--secondary)] hover:text-[var(--foreground)] cursor-pointer"
        >
          <Plus className="size-3.5" /> Add {singular}
        </button>
      )}
    </div>
  );
}

/** The experiments on the same node, one row each, with every param and result as a column. */
function Compare({ current, nodeName }: { current: Experiment; nodeName: string }) {
  const ws = useWorkspace();
  const siblings = ws.experiments.filter((e) => e.nodeId === current.nodeId);
  const paramKeys = [...new Set(siblings.flatMap((e) => Object.keys(e.params)))];
  const resultKeys = [...new Set(siblings.flatMap((e) => Object.keys(e.results)))];
  if (siblings.length < 2) return null;
  const cell = "border-b border-[var(--border)] px-2 py-1.5 text-left align-top";
  return (
    <Section title={`Experiments on ${nodeName}`}>
      <div className="overflow-x-auto">
        <table aria-label={`Experiments on ${nodeName}`} className="w-full border-collapse text-xs">
          <thead className="text-[var(--muted-foreground)]">
            <tr>
              <th className={cell}>Experiment</th>
              {paramKeys.map((k) => (
                <th key={`p-${k}`} className={cn(cell, "font-[family-name:var(--font-code)] font-normal")}>
                  {k}
                </th>
              ))}
              {resultKeys.map((k) => (
                <th key={`r-${k}`} className={cn(cell, "font-[family-name:var(--font-code)]")}>
                  {k}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {siblings.map((e) => (
              <tr
                key={e.id}
                onClick={() => void ws.enterExperiment(e.id)}
                className={cn(
                  "cursor-pointer hover:bg-[var(--secondary)]",
                  e.id === current.id && "bg-[var(--secondary)]",
                )}
              >
                <td className={cell}>
                  <span className="flex items-center gap-1.5">
                    <span className="truncate font-medium">{e.title}</span>
                    <StatusBadge status={e.status} />
                  </span>
                </td>
                {paramKeys.map((k) => (
                  <td key={`p-${k}`} className={cn(cell, "font-[family-name:var(--font-code)]")}>
                    {k in e.params ? show(e.params[k]) : ""}
                  </td>
                ))}
                {resultKeys.map((k) => (
                  <td key={`r-${k}`} className={cn(cell, "font-[family-name:var(--font-code)] font-semibold")}>
                    {k in e.results ? show(e.results[k]) : ""}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Section>
  );
}
