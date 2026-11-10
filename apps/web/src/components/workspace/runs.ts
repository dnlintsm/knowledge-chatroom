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

/**
 * Which experiments a list shows (#186): those on `node` (null: every one you
 * can see) and, with `descendants`, on the nodes under it. It lives in the URL
 * as `?list=<nodeId>` (and `&direct=1` without the sub-levels), apart from
 * where the user is, so opening an experiment doesn't change it. Without a
 * `list`, the list shows every experiment, so links to the workspace root
 * stay as they were.
 */
export interface ListScope {
  node: string | null;
  descendants: boolean;
}

export const ALL_EXPERIMENTS: ListScope = { node: null, descendants: true };

/** The list scope in a URL query string, or null when it has none. */
export function listScopeFromSearch(search: string): ListScope | null {
  const params = new URLSearchParams(search);
  const list = params.get("list")?.trim();
  if (!list) return null;
  return list === "all" ? ALL_EXPERIMENTS : { node: list, descendants: params.get("direct") !== "1" };
}

/** The query string with the list scope set, keeping other parameters. */
export function searchWithListScope(search: string, scope: ListScope): string {
  const params = new URLSearchParams(search);
  params.delete("list");
  params.delete("direct");
  if (scope.node !== null) params.set("list", scope.node);
  if (scope.node !== null && !scope.descendants) params.set("direct", "1");
  const query = params.toString();
  return query ? `?${query}` : "";
}

/** The experiments a scope shows; a node that isn't there (any more) shows them all. */
export function experimentsIn(experiments: Experiment[], nodes: KnowledgeNode[], scope: ListScope): Experiment[] {
  if (scope.node === null || !nodes.some((n) => n.id === scope.node)) return experiments;
  if (!scope.descendants) return experiments.filter((e) => e.nodeId === scope.node);
  return runsUnder(experiments, nodes, scope.node);
}

/** The scope as shown: a node that isn't there (any more) means all. */
export function shownScope(scope: ListScope, nodes: KnowledgeNode[]): ListScope {
  return scope.node !== null && !nodes.some((n) => n.id === scope.node) ? ALL_EXPERIMENTS : scope;
}
