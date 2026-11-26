"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Archive, ChevronRight, Play, Repeat, RotateCcw, Trash2, X } from "lucide-react";
import { IconButton } from "@/components/ui/icon-button";
import { authorizedByText, finishedByText, ranAsText, type Pipeline } from "@/lib/pipelines";
import { cn } from "@/lib/utils";
import { workspaceUrl } from "@/lib/workspace-request";
import { StateBadge } from "./experiment-panel";
import { ActionButton, KeyValues, Section, show } from "./panel-parts";
import {
  changeRun,
  deleteRun,
  finishRun,
  getRun,
  rerunRun,
  restoreRun,
  runFileUrl,
  runName,
  startRun,
  type Run,
  type RunFile,
} from "./run-records";
import { apiFetch, type Experiment } from "./server-files";
import { useWorkspace } from "./store";
import { isTextFile } from "./types";
import { useRuns } from "./use-runs";
import { useWorkbench } from "./workbench";

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

/** A few results, for a Run's row. */
function keyResults(results: Record<string, unknown>) {
  const entries = Object.entries(results);
  const shown = entries.slice(0, 3).map(([k, v]) => `${k} ${show(v)}`).join(" · ");
  return entries.length > 3 ? `${shown} · +${entries.length - 3}` : shown;
}

/**
 * An Experiment's Runs (docs/experiment-runs.md): each execution of its
 * question, newest first. Its maintainer and collaborators start a new one
 * from the planned parameters; one runs at a time. Opening a Run shows what
 * it ran with, what came out, and its files as recorded.
 */
export function RunsSection({
  experiment,
  canChange,
  canRerun,
}: {
  experiment: Experiment;
  canChange: boolean;
  canRerun: boolean;
}) {
  const [showArchived, setShowArchived] = useState(false);
  const [opened, setOpened] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const { runs, deleted, error, reload } = useRuns(experiment, { archived: showArchived, worker: canChange });
  const running = runs?.find((r) => r.state === "running") ?? null;
  const archivedCount = runs?.filter((r) => r.archived).length ?? 0;

  return (
    <Section title="Runs">
      <div className="flex flex-wrap items-center gap-2">
        {canChange && (
          <ActionButton
            onClick={() => setStarting(true)}
            disabled={starting || !!running}
            title={running ? `${runName(running)} is running. Finish it first: runs share the working files.` : "Start a run with the planned parameters"}
          >
            <Play className="size-3.5" /> New run
          </ActionButton>
        )}
        <label className="ml-auto flex cursor-pointer items-center gap-1 text-xs text-[var(--muted-foreground)]">
          <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
          Show archived{showArchived && archivedCount ? ` (${archivedCount})` : ""}
        </label>
      </div>
      {starting && (
        <NewRun
          experiment={experiment}
          onCancel={() => setStarting(false)}
          onStarted={(run) => {
            setStarting(false);
            setOpened(run.id);
            void reload();
          }}
        />
      )}
      {error && (
        <p role="alert" className="text-xs text-red-500">
          {error}
        </p>
      )}
      {runs === null ? (
        <p className="text-xs text-[var(--muted-foreground)]">Loading runs…</p>
      ) : runs.length === 0 ? (
        <p className="px-2 text-xs text-[var(--muted-foreground)]">
          {canChange ? "No runs yet. A run records what it ran with, its results, and its files as they were when it finished." : "No runs yet."}
        </p>
      ) : (
        <ul aria-label="Runs" className="flex flex-col rounded-md border border-[var(--border)]">
          {runs.map((run) => (
            <li key={run.id} data-testid="run" data-state={run.state} className="border-b border-[var(--border)] last:border-b-0">
              <button
                type="button"
                aria-expanded={opened === run.id}
                onClick={() => setOpened(opened === run.id ? null : run.id)}
                className="flex w-full min-w-0 cursor-pointer items-center gap-2 px-2 py-1.5 text-left text-xs hover:bg-[var(--secondary)]"
              >
                <ChevronRight className={cn("size-3.5 shrink-0 transition-transform", opened === run.id && "rotate-90")} />
                <span className="shrink-0 font-medium">{runName(run)}</span>
                <StateBadge state={run.state} />
                {run.archived && (
                  <span className="shrink-0 rounded-full border border-[var(--border)] px-1.5 text-[10px] uppercase tracking-wide text-[var(--muted-foreground)]">
                    Archived
                  </span>
                )}
                <span className="min-w-0 truncate font-[family-name:var(--font-code)] text-[var(--muted-foreground)]">
                  {keyResults(run.results)}
                </span>
                <span className="ml-auto shrink-0 text-[var(--muted-foreground)] max-sm:hidden">
                  {run.startedBy?.name ?? "Someone"}, {when(run.startedAt)}
                </span>
              </button>
              {opened === run.id && (
                <RunView
                  run={run}
                  runs={runs}
                  experiment={experiment}
                  canChange={canChange}
                  canRerun={canRerun}
                  anotherRunning={!!running && running.id !== run.id}
                  onOpen={setOpened}
                  onChanged={() => void reload()}
                />
              )}
            </li>
          ))}
        </ul>
      )}
      {canChange && deleted.length > 0 && <DeletedRuns deleted={deleted} onChanged={() => void reload()} />}
    </Section>
  );
}

/** The planned parameters, editable before the run starts, and an optional label. */
function NewRun({
  experiment,
  onCancel,
  onStarted,
}: {
  experiment: Experiment;
  onCancel: () => void;
  onStarted: (run: Run) => void;
}) {
  const ws = useWorkspace();
  const [label, setLabel] = useState("");
  const [params, setParams] = useState<Record<string, unknown>>(experiment.params);
  // Rows save when focus leaves them, which Start run's click does; read the latest.
  const latest = useRef(params);
  const keepParams = (next: Record<string, unknown>) => {
    latest.current = next;
    setParams(next);
  };
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const start = async () => {
    setBusy(true);
    try {
      // The run's record is of what the server has, so edits on their way go first.
      await ws.edits.save();
      onStarted(await startRun(experiment.id, { label: label.trim(), params: latest.current }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };
  return (
    <form
      aria-label="New run"
      className="flex flex-col gap-2 rounded-md border border-[var(--border)] bg-surface-raised p-2 text-xs"
      onSubmit={(e) => {
        e.preventDefault();
        void start();
      }}
    >
      <input
        aria-label="Run label"
        value={label}
        maxLength={200}
        placeholder="Label (optional), e.g. hotter chamber"
        onChange={(e) => setLabel(e.target.value)}
        className="rounded-md border border-[var(--border)] bg-transparent px-2 py-1 outline-none focus:border-[var(--ring)]"
      />
      <KeyValues label="Parameters" values={params} readOnly={false} onSave={keepParams} />
      {error && <p role="alert" className="text-red-500">{error}</p>}
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={busy}
          className="h-7 cursor-pointer rounded-md bg-brand px-2 text-brand-foreground disabled:cursor-default disabled:opacity-50"
        >
          Start run
        </button>
        <ActionButton onClick={onCancel}>Cancel</ActionButton>
      </div>
    </form>
  );
}

/** One Run's record: what it ran with, what came out, where it came from, and its files. */
function RunView({
  run,
  runs,
  experiment,
  canChange,
  canRerun,
  anotherRunning,
  onOpen,
  onChanged,
}: {
  run: Run;
  runs: Run[];
  experiment: Experiment;
  canChange: boolean;
  canRerun: boolean;
  anotherRunning: boolean;
  onOpen: (id: string) => void;
  onChanged: () => void;
}) {
  const ws = useWorkspace();
  const { notify } = useWorkbench();
  const [full, setFull] = useState<Run | null>(null);
  const [results, setResults] = useState<Record<string, unknown>>(run.results);
  // Rows save when focus leaves them, which Finish's click does; read the latest.
  const latestResults = useRef(results);
  const keepResults = (next: Record<string, unknown>) => {
    latestResults.current = next;
    setResults(next);
  };
  const [viewing, setViewing] = useState<RunFile | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { id, state, finishedAt } = run;
  const execution = run.provenance.execution;
  const pipelineId = execution?.ranAs.kind === "pipeline" ? execution.ranAs.id : undefined;
  const [pipelineRevoked, setPipelineRevoked] = useState(false);

  // A pipeline's Run left running after it was revoked: its key can't finish
  // it, so the Run says so. Only its owner and the workspace's Owners and
  // Admins can look the pipeline up; for anyone else nothing is said.
  useEffect(() => {
    setPipelineRevoked(false);
    if (!pipelineId || state !== "running") return;
    let live = true;
    void apiFetch(`/api/pipelines/${encodeURIComponent(pipelineId)}`, { cache: "no-store" })
      .then(async (res) => (res.ok ? ((await res.json()) as Pipeline) : null))
      .then((found) => live && setPipelineRevoked(found?.status === "revoked"))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [pipelineId, state]);

  useEffect(() => {
    let live = true;
    void getRun(id)
      .then((found) => live && setFull(found))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [id, state, finishedAt]);

  const act = async (what: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await what();
      setError(null);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  const finish = (outcome: "done" | "failed") =>
    act(async () => {
      await ws.edits.save();
      await finishRun(id, latestResults.current, outcome);
    });
  const again = () =>
    act(async () => {
      await ws.edits.save();
      onOpen((await rerunRun(id, experiment.id)).id);
    });
  const asYourOwn = () =>
    act(() => ws.rerunAsYourOwn(id));
  // No confirmation: the notice offers Undo, and Recently deleted keeps it after that.
  const remove = () =>
    act(async () => {
      await deleteRun(id);
      notify(`Deleted ${runName(run)}`, "info", {
        label: "Undo",
        run: () =>
          void restoreRun(id)
            .then(onChanged)
            .catch((err: unknown) => notify(err instanceof Error ? err.message : String(err), "error")),
      });
    });

  const p = run.provenance;
  const source = p.rerunOf?.run && p.rerunOf.id === experiment.id ? runs.find((r) => r.id === p.rerunOf!.run) : undefined;
  const sourceExperiment = p.rerunOf && p.rerunOf.id !== experiment.id ? ws.experiments.find((e) => e.id === p.rerunOf!.id) : undefined;
  const placeNames = {
    node: (node: string) => ws.nodes.find((n) => n.id === node && n.role !== null)?.name,
    experiment: (x: string) => ws.experiments.find((e) => e.id === x)?.title,
  };
  const rows: [string, ReactNode][] = [
    ["Started", [run.startedBy?.name, when(run.startedAt)].filter(Boolean).join(", ")],
    ["Ran as", ranAsText(execution) ?? <span className="text-[var(--muted-foreground)]">Not recorded</span>],
    ["Authorized by", authorizedByText(execution, placeNames)],
    ["Finished", run.finishedAt && when(run.finishedAt)],
    ["Finished by", finishedByText(execution)],
    ["Model", p.model],
    ["Skill", p.skill && [p.skill.name, p.skill.version && `v${p.skill.version}`].filter(Boolean).join(" · ")],
    ["Chat", p.chat],
    [
      "Rerun of",
      p.rerunOf &&
        (source ? (
          <button type="button" className="cursor-pointer underline-offset-2 hover:underline" onClick={() => onOpen(source.id)}>
            {runName(source)}
          </button>
        ) : sourceExperiment ? (
          <button
            type="button"
            className="cursor-pointer underline-offset-2 hover:underline"
            onClick={() => void ws.enterExperiment(sourceExperiment.id)}
          >
            {sourceExperiment.title}
          </button>
        ) : p.rerunOf.id === experiment.id ? (
          "a deleted run"
        ) : (
          "an experiment you can't open"
        )),
    ],
  ];
  const record = full?.id === id ? full.record : undefined;
  const editable = canChange && state === "running";

  return (
    <div data-testid="run-view" className="flex flex-col gap-3 border-t border-[var(--border)] bg-surface-raised px-3 py-2 text-xs">
      {pipelineRevoked && (
        <p role="status" className="text-[var(--muted-foreground)]">
          Its pipeline was revoked while it ran, so its key can&apos;t finish it. Its owner or the Experiment&apos;s maintainer can.
        </p>
      )}
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        {rows
          .filter(([, value]) => value)
          .map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-[var(--muted-foreground)]">{label}</dt>
              <dd className="min-w-0 break-words">{value}</dd>
            </div>
          ))}
      </dl>
      <div className="flex flex-col gap-1">
        <h4 className="font-medium text-[var(--muted-foreground)]">Parameters it ran with</h4>
        <KeyValues key={`params-${id}`} label="Run parameters" singular="parameter" values={run.params} readOnly onSave={() => {}} />
      </div>
      <div className="flex flex-col gap-1">
        <h4 className="font-medium text-[var(--muted-foreground)]">Results</h4>
        <KeyValues key={`results-${id}-${state}`} label="Results" values={editable ? results : run.results} readOnly={!editable} onSave={keepResults} />
        {editable && (
          <div className="flex gap-2">
            <ActionButton onClick={() => void finish("done")} disabled={busy} title="Record these results and the files as they are now">
              Finish run
            </ActionButton>
            <ActionButton onClick={() => void finish("failed")} disabled={busy}>
              Mark as failed
            </ActionButton>
          </div>
        )}
      </div>
      <div className="flex flex-col gap-1">
        <h4 className="font-medium text-[var(--muted-foreground)]">Files as recorded</h4>
        {state === "running" ? (
          <p className="text-[var(--muted-foreground)]">Recorded when the run finishes.</p>
        ) : record === undefined ? (
          <p className="text-[var(--muted-foreground)]">…</p>
        ) : (
          <>
            {run.recordTaken === "migration" && (
              <p className="text-[var(--muted-foreground)]">Recorded when runs were split, not at finish: later changes may be in it.</p>
            )}
            {record && record.length > 0 ? (
              <ul aria-label="Recorded files" className="flex flex-col gap-0.5">
                {record.map((f) => {
                  const now = ws.serverHash(f.path);
                  return (
                    <li key={f.path} data-testid="run-file" className="flex min-w-0 flex-wrap items-center gap-x-2">
                      <button
                        type="button"
                        className="cursor-pointer truncate text-left underline-offset-2 hover:underline"
                        title={`View ${f.path} as the run recorded it`}
                        onClick={() => setViewing(f)}
                      >
                        {f.path}
                      </button>
                      <span className="font-mono text-[var(--muted-foreground)]" title={f.sha256}>
                        {f.sha256.slice(0, 8)}
                      </span>
                      {now !== undefined && now !== f.sha256 && (
                        <span className="text-amber-700 dark:text-amber-400">differs from the working copy</span>
                      )}
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="text-[var(--muted-foreground)]">No files.</p>
            )}
          </>
        )}
        {viewing && <RecordedFile run={run} file={viewing} onClose={() => setViewing(null)} />}
      </div>
      {error && (
        <p role="alert" className="text-red-500">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {canChange && state !== "running" && (
          <ActionButton
            onClick={() => void again()}
            disabled={busy || anotherRunning}
            title={anotherRunning ? "Another run is running. Finish it first." : "Another run of this experiment, with these parameters"}
          >
            <Repeat className="size-3.5" /> Run again
          </ActionButton>
        )}
        {canRerun && state !== "running" && (
          <ActionButton onClick={() => void asYourOwn()} disabled={busy} title="A new draft experiment of yours, starting from this run">
            <Repeat className="size-3.5" /> Rerun as your own
          </ActionButton>
        )}
        {canChange && (
          <ActionButton
            onClick={() => void act(() => changeRun(id, { archived: !run.archived }))}
            disabled={busy}
            title={run.archived ? undefined : "Hidden from Compare unless archived runs are shown; still readable"}
          >
            {run.archived ? <RotateCcw className="size-3.5" /> : <Archive className="size-3.5" />}
            {run.archived ? "Unarchive" : "Archive"}
          </ActionButton>
        )}
        {canChange && state !== "running" && (
          <ActionButton onClick={() => void remove()} disabled={busy} destructive>
            <Trash2 className="size-3.5" /> Delete
          </ActionButton>
        )}
      </div>
    </div>
  );
}

/** A file's bytes as the Run recorded them, read only. */
function RecordedFile({ run, file, onClose }: { run: Run; file: RunFile; onClose: () => void }) {
  const url = runFileUrl(run.id, file.path);
  const text = isTextFile({ path: file.path, mime: "" });
  const [content, setContent] = useState<{ url: string; text: string | null } | null>(null);
  useEffect(() => {
    if (!text) return;
    let live = true;
    void apiFetch(url)
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
    <section aria-label={`${file.path} as recorded`} data-testid="run-file-view" className="flex flex-col gap-1 rounded-md border border-[var(--border)] p-2">
      <div className="flex items-center gap-2">
        <span className="font-medium">{file.path} as recorded</span>
        <span className="text-[var(--muted-foreground)]">read only</span>
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

/** The Experiment's deleted Runs, to bring back. */
function DeletedRuns({ deleted, onChanged }: { deleted: Run[]; onChanged: () => void }) {
  const { notify } = useWorkbench();
  return (
    <details className="text-xs">
      <summary className="cursor-pointer text-[var(--muted-foreground)]">Recently deleted ({deleted.length})</summary>
      <ul aria-label="Deleted runs" className="mt-1 flex flex-col gap-1">
        {deleted.map((run) => (
          <li key={run.id} className="flex items-center gap-2">
            <span className="font-medium">{runName(run)}</span>
            <StateBadge state={run.state} />
            {run.deletedAt && (
              <span className="text-[var(--muted-foreground)]">
                deleted {run.deletedBy?.name ? `by ${run.deletedBy.name} ` : ""}
                {when(run.deletedAt)}
              </span>
            )}
            <ActionButton
              onClick={() =>
                void restoreRun(run.id)
                  .then(onChanged)
                  .catch((err: unknown) => notify(err instanceof Error ? err.message : String(err), "error"))
              }
            >
              <RotateCcw className="size-3.5" /> Restore
            </ActionButton>
          </li>
        ))}
      </ul>
    </details>
  );
}
