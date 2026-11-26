"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Archive, FileDiff, FlaskConical, Lock, Repeat, RotateCcw, Send, Share2, Trash2, Upload, X } from "lucide-react";
import { IconButton } from "@/components/ui/icon-button";
import { cn } from "@/lib/utils";
import { workspaceUrl } from "@/lib/workspace-request";
import { ExperimentPeople } from "./experiment-people";
import { ActionButton, KeyValues, Section, show } from "./panel-parts";
import { RunsSection } from "./runs-section";
import { compareRuns, onRunEvent, runName, type ComparedRun } from "./run-records";
import { useListScope } from "./list-scope";
import { readOnlyReason } from "./read-only";
import { hasRole } from "./roles";
import { RULES_FILE } from "./rules";
import {
  DRIFT_LABEL,
  listRunReads,
  listVersions,
  reader,
  rulesRecord,
  versionUrl,
  type FileVersion,
  type RulesRecord,
} from "./run-evidence";
import { useInputEvidence, type InputEvidence } from "./use-input-evidence";
import { experimentsIn, shownScope } from "./runs";
import {
  apiFetch,
  experimentPlace,
  listPromotable,
  type Experiment,
  type ExperimentChange,
  type ExperimentState,
  type ExperimentStatus,
  type KnowledgeNode,
  type Promotable,
} from "./server-files";
import { useWorkspace } from "./store";
import { isTextFile, REVIEW_TAB } from "./types";
import { uploadFiles } from "./upload";
import { useWorkbench } from "./workbench";

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

const STATE_LABEL: Record<ExperimentState, string> = {
  ready: "Ready",
  running: "Running",
  done: "Done",
  failed: "Failed",
};

/** How far a run got. Ready, the usual state of a hand-made experiment, shows nothing. */
export function StateBadge({ state, className }: { state: ExperimentState; className?: string }) {
  if (state === "ready") return null;
  return (
    <span
      data-state={state}
      className={cn(
        "shrink-0 rounded-full px-1.5 text-[10px] font-medium uppercase tracking-wide",
        state === "running" && "bg-sky-500/15 text-sky-700 dark:text-sky-300",
        state === "done" && "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
        state === "failed" && "bg-red-500/15 text-red-700 dark:text-red-300",
        className,
      )}
    >
      {STATE_LABEL[state]}
    </span>
  );
}

/** Where an experiment lives, by name: its node, or the workspace root. */
export function placeName(nodes: KnowledgeNode[], nodeId: string | null) {
  return nodeId === null ? "the workspace" : (nodes.find((n) => n.id === nodeId)?.name ?? "its node");
}

/**
 * The current experiment: what was tried (hypothesis, params), what came out
 * (results), and its status. Its author edits it; others who can see it read
 * it. Below, the other experiments on the same node side by side.
 */
export function ExperimentPanel() {
  const ws = useWorkspace();
  const { notify } = useWorkbench();
  const exp = ws.experiment;
  const [error, setError] = useState<string | null>(null);
  const [rerunning, setRerunning] = useState(false);
  if (!exp) {
    return <p className="p-8 text-sm text-[var(--muted-foreground)]">Loading the experiment…</p>;
  }
  const nodeName = placeName(ws.nodes, exp.nodeId);
  const canChange = exp.access === "writer";
  // Anyone who can see it may rerun it as their own, where they can see the node.
  const nodeRole = exp.nodeId === null ? ws.rootRole : (ws.nodes.find((n) => n.id === exp.nodeId)?.role ?? null);
  const canRerun = hasRole(nodeRole, "viewer");
  const reason = readOnlyReason({ experiment: exp, placeRole: ws.placeRole, placeName: nodeName, canRerun });

  const save = async (change: ExperimentChange) => {
    try {
      await ws.updateExperiment(exp.id, change);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  const rerun = async () => {
    setRerunning(true);
    try {
      await ws.rerunExperiment(exp.id);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRerunning(false);
    }
  };
  // No confirmation: the notice offers Undo, and Recently deleted keeps it after that.
  const remove = async () => {
    const { id, title } = exp;
    try {
      await ws.deleteExperiment(id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return;
    }
    notify(`Deleted ${title}`, "info", {
      label: "Undo",
      run: () =>
        void ws.restoreExperiment(id, true).catch((err: unknown) =>
          notify(err instanceof Error ? err.message : String(err), "error"),
        ),
    });
  };

  return (
    <div data-testid="experiment-panel" className="mx-auto flex max-w-3xl flex-col gap-6 px-8 py-6 text-sm">
      <header className="flex flex-col gap-2">
        <div className="flex items-center gap-2 text-xs text-[var(--muted-foreground)]">
          <FlaskConical className="size-3.5" />
          <span>
            {exp.nodeId === null ? "Experiment in" : "Experiment on"} {nodeName}, started{" "}
            {new Date(exp.forkedAt).toLocaleDateString(undefined, { dateStyle: "medium" })}
          </span>
          <StatusBadge status={exp.status} />
          <StateBadge state={exp.state} />
          {reason && (
            <span className="flex items-center gap-1" title={reason.detail}>
              <Lock className="size-3" /> {reason.label}
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
        <ExperimentPeople experiment={exp} nodeName={nodeName} />
        {reason && (
          <p data-testid="read-only-reason" className="text-xs text-[var(--muted-foreground)]">
            {reason.detail}
          </p>
        )}
        {(exp.mine || (canRerun && !canChange)) && (
          <div className="flex flex-wrap items-center gap-2">
            {/* Who works on it starts runs below; others rerun it as their own. */}
            {canRerun && !canChange && (
              <ActionButton
                onClick={() => void rerun()}
                disabled={rerunning}
                title="A new experiment of yours with the same parameters and the inputs as its latest run recorded them"
              >
                <Repeat className="size-3.5" /> {exp.mine ? "Rerun" : "Rerun as your own"}
              </ActionButton>
            )}
            {exp.mine && (
              <>
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
                <ActionButton onClick={() => void remove()} destructive>
                  <Trash2 className="size-3.5" /> Delete
                </ActionButton>
              </>
            )}
          </div>
        )}
        <p className="text-xs text-[var(--muted-foreground)]">
          {exp.status !== "draft"
            ? `Everyone who can view ${nodeName} can see this. `
            : exp.collaborators.length === 0 && exp.mine
              ? "Only you can see this draft. "
              : exp.mine
                ? "Only you and the collaborators can see this draft. "
                : "Only its maintainer and the collaborators can see this draft. "}
          {exp.nodeId === null
            ? "It started empty; changes here don't touch the workspace's files."
            : <>Its files started as a copy of {nodeName}&apos;s; changes here don&apos;t touch {nodeName}.</>}
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
        {canChange && <p className="px-2 text-xs text-[var(--muted-foreground)]">Planned: each new run starts with these.</p>}
        <KeyValues
          key={`params-${exp.id}`}
          label="Parameters"
          values={exp.params}
          readOnly={!canChange}
          onSave={(params) => save({ params })}
        />
      </Section>
      {/* Before anything ran, results are typed in here; the first run keeps them as Run 1. */}
      {exp.state === "ready" && (canChange || Object.keys(exp.results).length > 0) && (
        <Section title="Results">
          {canChange && (
            <p className="px-2 text-xs text-[var(--muted-foreground)]">
              Recorded by hand. When a run starts, these are kept as Run 1.
            </p>
          )}
          <KeyValues
            key={`results-${exp.id}`}
            label="Results"
            values={exp.results}
            readOnly={!canChange}
            onSave={(results) => save({ results })}
          />
        </Section>
      )}
      <RunsSection key={`runs-${exp.id}`} experiment={exp} canChange={canChange} canRerun={canRerun} />
      {canChange && <AddFiles key={`add-${exp.id}`} experiment={exp} />}
      <Provenance experiment={exp} />
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

/**
 * Uploads into this experiment: files go to its uploads/ and,
 * unless the run already finished, are also added as run inputs,
 * copies under inputs/ recorded in its provenance, so a rerun reads them too.
 */
function AddFiles({ experiment }: { experiment: Experiment }) {
  const ws = useWorkspace();
  const inputRef = useRef<HTMLInputElement>(null);
  const finished = experiment.state === "done" || experiment.state === "failed";
  const [asInputs, setAsInputs] = useState(true);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);
  const linking = asInputs && !finished;
  // Where uploads would land now; null once this panel is gone.
  const here = useRef<string | null>(null);
  here.current = ws.experiment?.id ?? null;
  useEffect(() => () => void (here.current = null), []);

  const add = async (list: FileList | null) => {
    setBusy(true);
    const skipped: string[] = [];
    try {
      const written = await uploadFiles(
        list,
        ws.write,
        (path) => skipped.push(path),
        () => here.current === experiment.id,
      );
      if (!written.length) {
        if (skipped.length) setMessage({ text: `${skipped.join(", ")} is being renamed, so nothing was uploaded.`, error: true });
        return;
      }
      const count = `${written.length} ${written.length === 1 ? "file" : "files"}`;
      if (linking) await ws.addRunInputs(experiment.id, written);
      setMessage({
        text: linking
          ? `Uploaded ${count} to uploads/ and added ${written.length === 1 ? "it" : "them"} as inputs under inputs/.`
          : `Uploaded ${count} to uploads/.`,
      });
    } catch (err) {
      setMessage({ text: err instanceof Error ? err.message : String(err), error: true });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title="Add files">
      <div
        data-testid="add-files"
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          void add(e.dataTransfer.files);
        }}
        className={cn(
          "flex flex-col gap-2 rounded-md border border-dashed border-[var(--border)] px-3 py-3",
          dragging && "ring-2 ring-[var(--ring)]",
        )}
      >
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            disabled={busy}
            onClick={() => inputRef.current?.click()}
            className="flex h-7 items-center gap-1 rounded-md bg-[var(--primary)] px-2 text-xs text-[var(--primary-foreground)] cursor-pointer disabled:cursor-default disabled:opacity-50"
          >
            <Upload className="size-3.5" /> Upload to {experiment.title}
          </button>
          <span className="text-xs text-[var(--muted-foreground)]">or drop files here</span>
          <label className="ml-auto flex items-center gap-1.5 text-xs" title={finished ? "A finished experiment keeps the inputs it ran with; rerun it to add more" : undefined}>
            <input
              type="checkbox"
              checked={linking}
              disabled={finished}
              onChange={(e) => setAsInputs(e.target.checked)}
            />
            Add as inputs
          </label>
        </div>
        <p className="text-xs text-[var(--muted-foreground)]">
          {finished
            ? "Files go to uploads/. This experiment finished, so its inputs stay as they were."
            : linking
              ? "Files go to uploads/, and a copy under inputs/ is recorded with the experiment, so a rerun reads it too."
              : "Files go to uploads/ in this experiment."}
        </p>
        <input
          ref={inputRef}
          type="file"
          multiple
          hidden
          data-testid="add-files-input"
          onChange={(e) => {
            void add(e.target.files);
            e.target.value = "";
          }}
        />
      </div>
      {message && (
        <p role={message.error ? "alert" : "status"} className={cn("text-xs", message.error ? "text-red-500" : "text-[var(--muted-foreground)]")}>
          {message.text}
        </p>
      )}
    </Section>
  );
}

/** A version of one of the run's files, opened read only from its provenance. */
interface Viewing {
  path: string;
  version: FileVersion;
  label: string;
}

/** Where a run came from: who started it, from which chat, with what, and the exact inputs. */
function Provenance({ experiment }: { experiment: Experiment }) {
  const ws = useWorkspace();
  const [viewing, setViewing] = useState<Viewing | null>(null);
  const inputs = useInputEvidence(experiment);
  const p = experiment.provenance;
  // Hand-made experiments have a record only once inputs are added to them.
  if (!p || !(p.startedAt || p.inputs?.length)) return null;
  const when = (iso?: string) => (iso ? new Date(iso).toLocaleString() : null);
  // The record keeps only the old run's id; its title shows only to those who can see it.
  const source = p.rerunOf && ws.experiments.find((e) => e.id === p.rerunOf!.id);
  const rows: [string, ReactNode][] = [
    ["Started", [p.startedBy?.name, when(p.startedAt)].filter(Boolean).join(", ")],
    ["Finished", when(p.finishedAt)],
    ["Model", p.model],
    [
      "Skill",
      p.skill &&
        [p.skill.name, p.skill.version && `v${p.skill.version}`, p.skill.sha256?.slice(0, 8)]
          .filter(Boolean)
          .join(" · "),
    ],
    ["Tools", p.tools && Object.entries(p.tools).map(([k, v]) => `${k} ${v}`).join(", ")],
    ["Rules", p.startedAt && <RulesEvidence experiment={experiment} onView={setViewing} />],
    ["Chat", p.chat],
    [
      "Rerun of",
      p.rerunOf &&
        (source ? (
          <button
            type="button"
            className="cursor-pointer text-left underline-offset-2 hover:underline"
            onClick={() => void ws.enterExperiment(source.id)}
          >
            {source.title}
          </button>
        ) : (
          "an experiment you can't open"
        )),
    ],
  ];
  return (
    <Section title={experiment.state === "ready" ? "Provenance" : "Provenance of the latest run"}>
      <dl data-testid="run-provenance" className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        {rows
          .filter(([, value]) => value)
          .map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-[var(--muted-foreground)]">{label}</dt>
              <dd className="min-w-0 break-words">{value}</dd>
            </div>
          ))}
      </dl>
      {p.inputs && p.inputs.length > 0 && (
        <ul aria-label="Inputs" className="flex flex-col gap-1 text-xs">
          {inputs.map((evidence) => (
            <RecordedInputRow key={evidence.input.path} evidence={evidence} onView={setViewing} />
          ))}
        </ul>
      )}
      {viewing && <VersionView experiment={experiment} viewing={viewing} onClose={() => setViewing(null)} />}
    </Section>
  );
}

/**
 * One recorded input and whether its copy under inputs/ still has the
 * recorded bytes (docs/run-evidence.md, "Input drift"). When it doesn't, the
 * recorded content opens read only.
 */
function RecordedInputRow({ evidence, onView }: { evidence: InputEvidence; onView: (v: Viewing) => void }) {
  const ws = useWorkspace();
  const { input, drift, recorded } = evidence;
  const label = DRIFT_LABEL[drift];
  return (
    <li className="flex min-w-0 flex-wrap items-center gap-x-2" data-testid="run-input" data-drift={drift}>
      {drift !== "missing" ? (
        <button
          type="button"
          className="cursor-pointer truncate text-left underline-offset-2 hover:underline"
          onClick={() => ws.open(input.path)}
          title={drift === "differs" ? `Open ${input.path} as it is now` : `Open ${input.path}`}
        >
          {input.path}
        </button>
      ) : (
        <span className="truncate">{input.path}</span>
      )}
      <span className="truncate text-[var(--muted-foreground)]" title={input.sha256}>
        from {input.from.path}
        {input.sha256 && ` · ${input.sha256.slice(0, 8)}`}
      </span>
      {label && (
        <span className={cn(drift === "differs" ? "text-amber-700 dark:text-amber-400" : "text-[var(--muted-foreground)]")}>
          {label}
        </span>
      )}
      {recorded && (
        <button
          type="button"
          className="cursor-pointer text-brand-text underline-offset-2 hover:underline"
          onClick={() => onView({ path: input.path, version: recorded, label: `${input.path} as recorded` })}
        >
          View recorded
        </button>
      )}
    </li>
  );
}

/** A past version, read only, under the provenance it was opened from. */
function VersionView({ experiment, viewing, onClose }: { experiment: Experiment; viewing: Viewing; onClose: () => void }) {
  const url = versionUrl(viewing.path, experimentPlace(experiment.id), viewing.version.id);
  const text = isTextFile({ path: viewing.path, mime: viewing.version.mime });
  const [content, setContent] = useState<{ url: string; text: string | null } | null>(null);
  useEffect(() => {
    if (!text) return;
    let live = true;
    void apiFetch(url, { cache: "no-store" })
      .then(async (res) => (res.ok ? res.text() : null))
      .catch(() => null)
      .then((body) => {
        if (live) setContent({ url, text: body });
      });
    return () => {
      live = false;
    };
  }, [text, url]);
  const shown = content?.url === url ? content.text : undefined;
  return (
    <section
      aria-label={viewing.label}
      data-testid="version-view"
      className="flex flex-col gap-1 rounded-md border border-[var(--border)] bg-surface-raised p-2 text-xs"
    >
      <div className="flex items-center gap-2">
        <span className="font-medium">{viewing.label}</span>
        <span className="text-[var(--muted-foreground)]" title={viewing.version.sha256}>
          {viewing.version.sha256.slice(0, 8)} · {when(viewing.version.createdAt)} · read only
        </span>
        <IconButton aria-label="Close" className="ml-auto" onClick={onClose}>
          <X />
        </IconButton>
      </div>
      {!text ? (
        <a className="text-brand-text underline-offset-2 hover:underline" href={workspaceUrl(url)} target="_blank" rel="noreferrer">
          Open this version
        </a>
      ) : shown === undefined ? (
        <p className="text-[var(--muted-foreground)]">Loading…</p>
      ) : shown === null ? (
        <p role="alert">This version can&apos;t be read now.</p>
      ) : (
        <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words font-mono">{shown}</pre>
      )}
    </section>
  );
}

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });

/**
 * The run's Rules (models/general_rules.md) in its provenance: the versions
 * written while it ran, those an agent or tool read, and the one there when
 * it finished. It says "read" only for reads the server recorded.
 */
function RulesEvidence({ experiment, onView }: { experiment: Experiment; onView: (v: Viewing) => void }) {
  const ws = useWorkspace();
  const place = experimentPlace(experiment.id);
  const now = ws.serverHash(RULES_FILE);
  const [found, setFound] = useState<{ versions: FileVersion[] | null; record: RulesRecord } | null>(null);
  const { id, state, updatedAt, provenance } = experiment;
  useEffect(() => {
    let live = true;
    void Promise.all([listVersions(RULES_FILE, place), listRunReads(id)])
      .then(([versions, reads]) => {
        if (live) setFound({ versions, record: rulesRecord(versions, reads ?? [], provenance ?? {}) });
      })
      .catch(() => {});
    return () => {
      live = false;
    };
    // Again when the run changes (it finished) or its Rules do.
  }, [id, place, state, updatedAt, provenance, now]);
  if (!found) return <span className="text-[var(--muted-foreground)]">…</span>;
  const { versions, record } = found;
  const people = new Map<string, string | null>([
    [experiment.authorId, experiment.authorName],
    [experiment.maintainerId, experiment.maintainerName],
    ...experiment.collaborators.map((c) => [c.id, c.name] as [string, string | null]),
  ]);
  const writer = (v: FileVersion) =>
    v.author === "agent" ? "Claude" : ((v.authorId && people.get(v.authorId)) ?? "someone");
  const version = (id: string, sha256: string, label: string) => {
    const live = versions?.find((v) => v.id === id);
    const short = sha256.slice(0, 8);
    return live ? (
      <button
        key={id}
        type="button"
        className="cursor-pointer font-mono underline-offset-2 hover:underline"
        title={`View this version (${sha256})`}
        onClick={() => onView({ path: RULES_FILE, version: live, label })}
      >
        {short}
      </button>
    ) : (
      <span key={id} className="font-mono" title={sha256}>
        {short}
      </span>
    );
  };
  return (
    <div data-testid="run-rules" className="flex flex-col gap-0.5">
      {record.written.length > 0 && (
        <span>
          Written:{" "}
          {record.written.map((v, i) => (
            <span key={v.id}>
              {i > 0 && "; "}
              {version(v.id, v.sha256, "Rules as written")} by {writer(v)}, {when(v.createdAt)}
            </span>
          ))}
        </span>
      )}
      {record.read.length > 0 ? (
        <span data-testid="run-rules-read">
          Read:{" "}
          {record.read.map((r, i) => (
            <span key={r.version}>
              {i > 0 && "; "}
              {version(r.version, r.sha256, "Rules as read")} by {reader(r.via)}, {when(r.readAt)}
            </span>
          ))}
        </span>
      ) : (
        <span className="text-[var(--muted-foreground)]">Not read during the run</span>
      )}
      {record.atFinish !== undefined && (
        <span>
          At finish: {record.atFinish ? version(record.atFinish.version, record.atFinish.sha256, "Rules at finish") : "deleted"}
        </span>
      )}
    </div>
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

/** The experiments on the same node (or at the root), side by side. */
function Compare({ current, nodeName }: { current: Experiment; nodeName: string }) {
  const ws = useWorkspace();
  const siblings = ws.experiments.filter((e) => e.nodeId === current.nodeId);
  if (siblings.length < 2) return null;
  return (
    <Section title={`Experiments on ${nodeName}`}>
      <RunsTable runs={siblings} current={current.id} label={`Experiments on ${nodeName}`} />
    </Section>
  );
}

/**
 * The Compare tab: the runs of the experiments in the list's scope (all of
 * them, or a node's), one row each, grouped by experiment, with every param
 * and result as a column. An experiment that hasn't run shows as one row.
 */
export function RunsPanel() {
  const ws = useWorkspace();
  // The same scope as the sidebar's list.
  const [listScope] = useListScope();
  const scope = shownScope(listScope, ws.nodes);
  const [showArchived, setShowArchived] = useState(false);
  const experiments = experimentsIn(ws.experiments, ws.nodes, scope);
  const runs = useComparedRuns(scope, showArchived, ws.experiments);
  const here =
    scope.node === null
      ? "the workspace"
      : `${placeName(ws.nodes, scope.node)}${scope.descendants ? "" : " (not its sub-levels)"}`;
  const runCount = runs ? experiments.reduce((n, e) => n + (runs.get(e.id)?.length ?? 0), 0) : 0;
  return (
    <div data-testid="runs-panel" className="mx-auto flex max-w-5xl flex-col gap-4 px-8 py-6 text-sm">
      <header className="flex flex-wrap items-center gap-2">
        <FlaskConical className="size-4 text-[var(--muted-foreground)]" />
        <h2 className="text-base font-semibold">Runs in {here}</h2>
        <span className="text-xs text-[var(--muted-foreground)]">
          {runCount} {runCount === 1 ? "run" : "runs"} of {experiments.length} {experiments.length === 1 ? "experiment" : "experiments"}
        </span>
        <label className="ml-auto flex cursor-pointer items-center gap-1 text-xs text-[var(--muted-foreground)]">
          <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
          Show archived runs
        </label>
      </header>
      {!experiments.length ? (
        <p className="text-[var(--muted-foreground)]">
          No experiments here yet. Start one from the Experiments view, or ask Claude to run an analysis on your files.
        </p>
      ) : runs === null ? (
        <p className="text-xs text-[var(--muted-foreground)]">Loading runs…</p>
      ) : (
        <RunsByExperiment experiments={experiments} runs={runs} current={ws.experiment?.id ?? null} label={`Runs in ${here}`} />
      )}
    </div>
  );
}

/** The Runs in a scope, by experiment; loaded again when a run or an experiment changes. */
function useComparedRuns(scope: { node: string | null; descendants: boolean }, archived: boolean, experiments: Experiment[]) {
  const [found, setFound] = useState<{ key: string; runs: Map<string, ComparedRun[]> } | null>(null);
  const key = `${scope.node ?? ""}|${scope.descendants}|${archived}`;
  // Their states and results show on the experiments, which change when a run does.
  const changed = experiments.map((e) => `${e.id}:${e.updatedAt}`).join(",");
  useEffect(() => {
    let live = true;
    const load = () =>
      void compareRuns(scope.node === null ? { archived } : { node: scope.node, descendants: scope.descendants, archived })
        .then((list) => {
          if (!live) return;
          const by = new Map<string, ComparedRun[]>();
          for (const run of list) by.set(run.experimentId, [...(by.get(run.experimentId) ?? []), run]);
          for (const group of by.values()) group.sort((a, b) => b.number - a.number);
          setFound({ key, runs: by });
        })
        .catch(() => {});
    load();
    const stop = onRunEvent(load);
    return () => {
      live = false;
      stop();
    };
  }, [key, scope.node, scope.descendants, archived, changed]);
  return found?.key === key ? found.runs : null;
}

function RunsByExperiment({
  experiments,
  runs,
  current,
  label,
}: {
  experiments: Experiment[];
  runs: Map<string, ComparedRun[]>;
  current: string | null;
  label: string;
}) {
  const ws = useWorkspace();
  // Each experiment's runs, or the experiment itself when none is shown: one
  // that hasn't run (its planned parameters and any results typed by hand),
  // or one whose runs are all archived (nothing, since its mirrored results
  // are an archived run's).
  type Row = { experiment: Experiment; run: ComparedRun | null; first: boolean; span: number };
  const rows = experiments.flatMap((e): Row[] => {
    const its = runs.get(e.id) ?? [];
    return its.length
      ? its.map((run, i) => ({ experiment: e, run, first: i === 0, span: its.length }))
      : [{ experiment: e, run: null, first: true, span: 1 }];
  });
  const neverRan = (e: Experiment) => e.state === "ready";
  const paramsOf = (r: Row) => r.run?.params ?? (neverRan(r.experiment) ? r.experiment.params : {});
  const resultsOf = (r: Row) => r.run?.results ?? (neverRan(r.experiment) ? r.experiment.results : {});
  const paramKeys = [...new Set(rows.flatMap((r) => Object.keys(paramsOf(r))))];
  const resultKeys = [...new Set(rows.flatMap((r) => Object.keys(resultsOf(r))))];
  const cell = "border-b border-[var(--border)] px-2 py-1.5 text-left align-top";
  return (
    <div className="overflow-x-auto">
      <table aria-label={label} className="w-full border-collapse text-xs">
        <thead className="text-[var(--muted-foreground)]">
          <tr>
            <th className={cell}>Experiment</th>
            <th className={cn(cell, "font-normal")}>Run</th>
            <th className={cn(cell, "font-normal")}>Where</th>
            <th className={cn(cell, "font-normal")}>By</th>
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
          {rows.map((r) => {
            const { experiment: e, run } = r;
            const params = paramsOf(r);
            const results = resultsOf(r);
            return (
              <tr
                key={run?.id ?? e.id}
                data-testid="compared-run"
                data-experiment={e.id}
                onClick={() => void ws.enterExperiment(e.id)}
                className={cn("cursor-pointer hover:bg-[var(--secondary)]", e.id === current && "bg-[var(--secondary)]")}
              >
                {r.first && (
                  <td className={cell} rowSpan={r.span}>
                    <span className="flex items-center gap-1.5">
                      <span className="truncate font-medium">{e.title}</span>
                      <StatusBadge status={e.status} />
                    </span>
                  </td>
                )}
                <td className={cell}>
                  {run ? (
                    <span className="flex items-center gap-1.5 whitespace-nowrap">
                      {runName(run)}
                      <StateBadge state={run.state} />
                      {run.archived && <span className="text-[var(--muted-foreground)]">archived</span>}
                    </span>
                  ) : (
                    <span className="text-[var(--muted-foreground)]">
                      {neverRan(e) ? "Not run" : "Runs archived"}
                    </span>
                  )}
                </td>
                <td className={cell}>{placeName(ws.nodes, e.nodeId)}</td>
                <td className={cell}>{run ? (run.startedBy?.name ?? "Someone") : e.mine ? "You" : (e.maintainerName ?? "Someone")}</td>
                {paramKeys.map((k) => (
                  <td key={`p-${k}`} className={cn(cell, "font-[family-name:var(--font-code)]")}>
                    {k in params ? show(params[k]) : ""}
                  </td>
                ))}
                {resultKeys.map((k) => (
                  <td key={`r-${k}`} className={cn(cell, "font-[family-name:var(--font-code)] font-semibold")}>
                    {k in results ? show(results[k]) : ""}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function RunsTable({
  runs,
  current,
  label,
  showPlace = false,
}: {
  runs: Experiment[];
  current: string | null;
  label: string;
  showPlace?: boolean;
}) {
  const ws = useWorkspace();
  const paramKeys = [...new Set(runs.flatMap((e) => Object.keys(e.params)))];
  const resultKeys = [...new Set(runs.flatMap((e) => Object.keys(e.results)))];
  const cell = "border-b border-[var(--border)] px-2 py-1.5 text-left align-top";
  return (
    <div className="overflow-x-auto">
      <table aria-label={label} className="w-full border-collapse text-xs">
        <thead className="text-[var(--muted-foreground)]">
          <tr>
            <th className={cell}>Experiment</th>
            {showPlace && <th className={cn(cell, "font-normal")}>Where</th>}
            {showPlace && <th className={cn(cell, "font-normal")}>By</th>}
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
          {runs.map((e) => (
            <tr
              key={e.id}
              onClick={() => void ws.enterExperiment(e.id)}
              className={cn("cursor-pointer hover:bg-[var(--secondary)]", e.id === current && "bg-[var(--secondary)]")}
            >
              <td className={cell}>
                <span className="flex items-center gap-1.5">
                  <span className="truncate font-medium">{e.title}</span>
                  <StatusBadge status={e.status} />
                  <StateBadge state={e.state} />
                </span>
              </td>
              {showPlace && <td className={cell}>{placeName(ws.nodes, e.nodeId)}</td>}
              {showPlace && <td className={cell}>{e.mine ? "You" : (e.maintainerName ?? "Someone")}</td>}
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
  );
}
