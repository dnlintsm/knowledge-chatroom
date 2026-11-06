/**
 * Runs: a run is an experiment with a report (issue #82), the experiment's
 * `report.md`. The experiment the user is in lives in the URL as
 * `?experiment=<id>`, so links open a run and back/forward move between runs.
 */

import type { Experiment, KnowledgeNode } from "./server-files";

/** Where a run's report is, relative to the experiment. */
export const RUN_REPORT = "report.md";

/** A run's report path, or null when it has none yet. */
export function findReport(paths: Iterable<string>): string | null {
  for (const path of paths) if (path === RUN_REPORT) return RUN_REPORT;
  return null;
}

/**
 * The runs at a place and below it: at the workspace root (null) every
 * experiment you can see, on a node those on it and on the nodes under it.
 */
export function runsUnder(experiments: Experiment[], nodes: KnowledgeNode[], nodeId: string | null): Experiment[] {
  if (nodeId === null) return experiments;
  const parent = new Map(nodes.map((n) => [n.id, n.parentId]));
  const under = (id: string | null) => {
    for (let at = id; at !== null; at = parent.get(at) ?? null) if (at === nodeId) return true;
    return false;
  };
  return experiments.filter((e) => under(e.nodeId));
}

/** The experiment named in a URL query string, or null. */
export function experimentFromSearch(search: string): string | null {
  return new URLSearchParams(search).get("experiment")?.trim() || null;
}

/** The query string with `experiment` set (or removed), keeping other parameters. */
export function searchWithExperiment(search: string, id: string | null): string {
  const params = new URLSearchParams(search);
  params.delete("experiment");
  // The old ?run= links have nothing to point at any more.
  params.delete("run");
  if (id) params.set("experiment", id);
  const query = params.toString();
  return query ? `?${query}` : "";
}
