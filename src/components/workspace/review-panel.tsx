"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Bot, Check, FileDiff, FlaskConical, TriangleAlert, Undo2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { diffRows } from "./diff-rows";
import { apiFetch, fileUrl, proposalText, type Proposal } from "./server-files";
import { useWorkspace } from "./store";
import { isTextFile } from "./types";

/**
 * Proposed changes to this place's files, each as a diff against the file as
 * it is now, with accept and reject for editors and withdraw for whoever
 * proposed it. Inside an experiment, the ones promoted from it.
 */
export function ReviewPanel() {
  const ws = useWorkspace();
  const here = ws.experiment
    ? ws.proposals.filter((p) => p.experiment === ws.experiment!.id)
    : ws.proposals.filter((p) => p.node === ws.node);
  const placeName = ws.experiment
    ? ws.experiment.title
    : (ws.lineage[ws.lineage.length - 1]?.name ?? "the workspace");

  return (
    <div data-testid="review-panel" className="mx-auto flex max-w-4xl flex-col gap-4 px-8 py-6 text-sm">
      <header className="flex flex-col gap-1">
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          <FileDiff className="size-4" /> Proposed changes
        </h2>
        <p className="text-xs text-[var(--muted-foreground)]">
          {ws.experiment
            ? `What this experiment proposed to its node. Someone who can edit the node accepts or rejects each one.`
            : `Changes to ${placeName}'s files from Claude and from experiments. Nothing changes until someone who can edit here accepts them.`}
        </p>
      </header>
      {here.length === 0 ? (
        <p className="rounded-lg border border-dashed border-[var(--border)] p-6 text-center text-[var(--muted-foreground)]">
          Nothing waiting for review.
        </p>
      ) : (
        here.map((p) => <ProposalCard key={p.id} proposal={p} />)
      )}
    </div>
  );
}

function ProposalCard({ proposal: p }: { proposal: Proposal }) {
  const ws = useWorkspace();
  const [before, setBefore] = useState<string | null>(null);
  const [after, setAfter] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const text = isTextFile(p);
  // In its place, the open copy is the latest (it may hold edits not saved yet).
  const local = !ws.experiment && ws.node === p.node ? ws.getFile(p.path) : undefined;

  useEffect(() => {
    if (!text) return;
    let live = true;
    proposalText(p.id)
      .then((t) => live && setAfter(t))
      .catch((err: Error) => live && setError(err.message));
    return () => {
      live = false;
    };
  }, [p.id, p.updatedAt, text]);

  useEffect(() => {
    if (!text) return;
    if (local) {
      setBefore(local.content);
      return;
    }
    if (p.isNew) {
      setBefore("");
      return;
    }
    let live = true;
    apiFetch(fileUrl(p.path, p.node), { cache: "no-store" })
      .then(async (res) => live && setBefore(res.ok ? await res.text() : ""))
      .catch(() => live && setBefore(""));
    return () => {
      live = false;
    };
  }, [p.path, p.node, p.isNew, p.updatedAt, text, local]);

  const decide = async (decision: "accept" | "reject" | "withdraw") => {
    setBusy(true);
    try {
      await ws.decideProposal(p.id, decision);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  const who = p.author === "agent" ? `Claude${p.authorName ? ` for ${p.authorName}` : ""}` : (p.authorName ?? "Someone");

  return (
    <article
      data-testid="proposal"
      aria-label={`Proposed change to ${p.path}`}
      className="overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--card)]"
    >
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-[var(--border)] bg-[var(--secondary)] px-4 py-2">
        <span className="font-[family-name:var(--font-code)] text-[13px] font-medium">{p.path}</span>
        {p.isNew && (
          <span className="rounded-full bg-[var(--accent)] px-1.5 text-[10px] font-medium uppercase tracking-wide text-[var(--accent-foreground)]">
            New file
          </span>
        )}
        <span className="flex items-center gap-1 text-xs text-[var(--muted-foreground)]">
          {p.author === "agent" && <Bot className="size-3" />}
          {who}
          {p.experiment && (
            <>
              {" "}from <FlaskConical className="size-3" aria-label="Experiment" />
              {p.experimentTitle ?? "an experiment"}
            </>
          )}
          , {new Date(p.updatedAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}
        </span>
        <span className="ml-auto flex items-center gap-1.5">
          {p.mine && (
            <ReviewButton onClick={() => decide("withdraw")} disabled={busy}>
              <Undo2 className="size-3.5" /> Withdraw
            </ReviewButton>
          )}
          {p.canDecide && (
            <>
              <ReviewButton onClick={() => decide("reject")} disabled={busy}>
                <X className="size-3.5" /> Reject
              </ReviewButton>
              <ReviewButton onClick={() => decide("accept")} disabled={busy} primary>
                <Check className="size-3.5" /> Accept
              </ReviewButton>
            </>
          )}
        </span>
      </header>
      {p.note && <p className="border-b border-[var(--border)] px-4 py-2 text-[13px]">{p.note}</p>}
      {p.fileChanged && !p.isNew && (
        <p className="flex items-center gap-1.5 border-b border-[var(--border)] px-4 py-1.5 text-xs text-amber-700 dark:text-amber-400">
          <TriangleAlert className="size-3.5 shrink-0" />
          The file changed after this was proposed. The diff is against the file as it is now, so
          accepting would also undo anything shown as removed.
        </p>
      )}
      {!p.canDecide && !p.mine && (
        <p className="border-b border-[var(--border)] px-4 py-1.5 text-xs text-[var(--muted-foreground)]">
          Someone who can edit here decides on this one.
        </p>
      )}
      {error && (
        <p role="alert" className="px-4 py-2 text-xs text-red-500">
          {error}
        </p>
      )}
      {!text ? (
        <p className="px-4 py-3 text-xs text-[var(--muted-foreground)]">
          Binary file ({formatSize(p.size)}); accepting {p.isNew ? "adds" : "replaces"} it.
        </p>
      ) : before === null || after === null ? (
        <p className="px-4 py-3 text-xs text-[var(--muted-foreground)]">Loading the diff…</p>
      ) : (
        <Diff before={before} after={after} />
      )}
    </article>
  );
}

function ReviewButton({
  onClick,
  disabled,
  primary,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  primary?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "flex h-7 items-center gap-1 rounded-md border px-2 text-xs cursor-pointer disabled:cursor-default disabled:opacity-50",
        primary
          ? "border-transparent bg-[var(--primary)] text-[var(--primary-foreground)] hover:opacity-90"
          : "border-[var(--border)] bg-[var(--background)] hover:bg-[var(--secondary)]",
      )}
    >
      {children}
    </button>
  );
}

function Diff({ before, after }: { before: string; after: string }) {
  const rows = diffRows(before, after);
  const added = rows.filter((r) => r.type === "added").length;
  const removed = rows.filter((r) => r.type === "removed").length;
  return (
    <div>
      <p className="px-4 pt-2 text-[11px] text-[var(--muted-foreground)]">
        <span className="text-emerald-700 dark:text-emerald-400">+{added}</span>{" "}
        <span className="text-red-700 dark:text-red-400">−{removed}</span> lines
      </p>
      <table data-testid="diff" className="w-full border-collapse font-[family-name:var(--font-code)] text-[12px] leading-5">
        <tbody>
          {rows.map((r, i) =>
            r.type === "fold" ? (
              <tr key={i} className="bg-[var(--secondary)] text-[var(--muted-foreground)]">
                <td colSpan={3} className="px-4 py-0.5 text-[11px]">
                  {r.count} unchanged {r.count === 1 ? "line" : "lines"}
                </td>
              </tr>
            ) : (
              <tr
                key={i}
                data-change={r.type}
                className={cn(
                  r.type === "added" && "bg-emerald-500/10",
                  r.type === "removed" && "bg-red-500/10",
                )}
              >
                <td className="w-10 select-none px-2 text-right text-[var(--muted-foreground)]">{r.old ?? ""}</td>
                <td className="w-10 select-none px-2 text-right text-[var(--muted-foreground)]">{r.new ?? ""}</td>
                <td className="whitespace-pre-wrap break-words px-2">
                  <span aria-hidden className="mr-2 select-none text-[var(--muted-foreground)]">
                    {r.type === "added" ? "+" : r.type === "removed" ? "−" : " "}
                  </span>
                  {r.text}
                </td>
              </tr>
            ),
          )}
        </tbody>
      </table>
    </div>
  );
}

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
