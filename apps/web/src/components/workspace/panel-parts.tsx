"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Plus, X } from "lucide-react";
import { cn } from "@/lib/utils";

/** Parts the Experiment and Run views share. */

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--muted-foreground)]">{title}</h3>
      {children}
    </section>
  );
}

export function ActionButton({
  onClick,
  title,
  destructive,
  disabled,
  children,
}: {
  onClick: () => void;
  title?: string;
  destructive?: boolean;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex h-7 items-center gap-1 rounded-md border border-[var(--border)] px-2 text-xs cursor-pointer hover:bg-[var(--secondary)] disabled:cursor-default disabled:opacity-50",
        destructive && "hover:text-[var(--destructive)]",
      )}
    >
      {children}
    </button>
  );
}

/** How a value shows in an input: plain for text and numbers, JSON otherwise. */
export const show = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v));
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
export function KeyValues({
  label,
  values,
  readOnly,
  onSave,
  singular = label === "Parameters" ? "parameter" : "result",
}: {
  label: string;
  values: Record<string, unknown>;
  readOnly: boolean;
  onSave: (values: Record<string, unknown>) => void;
  /** What one row is, for its fields' names. */
  singular?: string;
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

