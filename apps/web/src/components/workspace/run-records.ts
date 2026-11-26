/**
 * Runs of an Experiment (docs/experiment-runs.md): each one execution of its
 * question, with the parameters it ran with, its results, and at finish a
 * record of every file as it was then. The API's /runs routes.
 */

import type { components } from "@knowledge-chatroom/contracts/generated/storage-api";
import type { RunEvent } from "@knowledge-chatroom/contracts/storage-contract";
import { apiFetch, type RunProvenance } from "./server-files";

type Schema = components["schemas"];

export type Run = Omit<Schema["Run"], "provenance"> & { provenance: RunProvenance };
export type ComparedRun = Run & { experiment: Schema["RunExperiment"] };
export type RunFile = Schema["RunFile"];
export type RunState = Schema["RunState"];

async function runRequest<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await apiFetch(url, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    cache: "no-store",
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `${method} run: ${res.status}`);
  return data;
}

const id = encodeURIComponent;

/** An Experiment's Runs, newest first: live ones, with archived ones too, or its deleted ones. */
export async function listRuns(experimentId: string, which: "live" | "archived" | "deleted" = "live"): Promise<Run[]> {
  const query = which === "live" ? "" : `?${which}=1`;
  return (await runRequest<{ runs: Run[] }>("GET", `/api/experiments/${id(experimentId)}/runs${query}`)).runs;
}

export const startRun = (experimentId: string, start: { label?: string; params?: Record<string, unknown> }) =>
  runRequest<Run>("POST", `/api/experiments/${id(experimentId)}/runs`, start);

export const finishRun = (runId: string, results: Record<string, unknown>, state: "done" | "failed") =>
  runRequest<Run>("POST", `/api/runs/${id(runId)}/finish`, { results, state });

/** Another Run of the same Experiment (`experiment` its id), or Run 1 of a new one of yours (null). */
export const rerunRun = (runId: string, experiment: string | null) =>
  runRequest<Run>("POST", `/api/runs/${id(runId)}/rerun`, { experiment });

export const changeRun = (runId: string, change: { label?: string; archived?: boolean }) =>
  runRequest<Run>("PATCH", `/api/runs/${id(runId)}`, change);

export const deleteRun = (runId: string) => runRequest<{ deleted: string }>("DELETE", `/api/runs/${id(runId)}`);

export const restoreRun = (runId: string) => runRequest<Run>("POST", `/api/runs/${id(runId)}/restore`);

/** One Run with its file record. */
export const getRun = (runId: string) => runRequest<Run>("GET", `/api/runs/${id(runId)}`);

/** Where a recorded file's bytes are, as the Run recorded them. */
export const runFileUrl = (runId: string, path: string) =>
  `/api/runs/${id(runId)}/files/${path.split("/").map(encodeURIComponent).join("/")}`;

/** Runs to compare: anywhere you can see (node undefined), or on a node (null: the root) and below. */
export async function compareRuns(scope: { node?: string | null; descendants?: boolean; archived?: boolean }): Promise<ComparedRun[]> {
  const params = new URLSearchParams();
  if (scope.node !== undefined) params.set("node", scope.node ?? "root");
  if (scope.descendants) params.set("descendants", "1");
  if (scope.archived) params.set("archived", "1");
  const query = params.toString();
  return (await runRequest<{ runs: ComparedRun[] }>("GET", `/api/runs${query ? `?${query}` : ""}`)).runs;
}

/** "Run 2", or "Run 2 · hotter" with a label. */
export const runName = (run: Pick<Run, "number" | "label">) => (run.label ? `Run ${run.number} · ${run.label}` : `Run ${run.number}`);

/**
 * Run changes from the workspace's event stream, for the views that show
 * Runs. The store hands each one on here; its Experiment's update follows.
 */
const runEvents = new EventTarget();

export function announceRunEvent(event: RunEvent) {
  runEvents.dispatchEvent(new CustomEvent<RunEvent>("run", { detail: event }));
}

/** Calls `listener` for each Run change; returns the unsubscribe. */
export function onRunEvent(listener: (event: RunEvent) => void): () => void {
  const handler = (e: Event) => listener((e as CustomEvent<RunEvent>).detail);
  runEvents.addEventListener("run", handler);
  return () => runEvents.removeEventListener("run", handler);
}
