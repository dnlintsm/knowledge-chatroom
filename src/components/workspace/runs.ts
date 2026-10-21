/**
 * Runs: a run is an experiment with a report (issue #82). The report is the
 * experiment's `report.md`; experiments made from an xDOE run folder keep
 * theirs at `xdoe-report/report.md`, which counts too. The experiment the
 * user is in lives in the URL as `?experiment=<id>`, so links open a run and
 * back/forward move between runs.
 *
 * Folders from before runs were experiments (any folder holding an
 * `xdoe-report/` folder) are listed so they can be turned into one.
 */

import type { Experiment, KnowledgeNode } from "./server-files";

/** Where a run's report may be, relative to the experiment, in order. */
export const RUN_REPORTS = ["report.md", "xdoe-report/report.md"];

/** A run's report path, or null when it has none yet. */
export function findReport(paths: Iterable<string>): string | null {
  const have = new Set(paths);
  return RUN_REPORTS.find((p) => have.has(p)) ?? null;
}

/** A folder that makes its parent an old-style run folder. */
export const RUN_FOLDER_MARKER = "xdoe-report";

export interface RunFolder {
  /** Path of the folder in its place, e.g. runs/etch-2026-10-01. */
  path: string;
  /** Its folder name, which becomes the experiment's title. */
  name: string;
  fileCount: number;
}

/**
 * Old-style run folders among `paths`: every folder holding an
 * `xdoe-report/` folder, sorted by path. A marker at the top makes no run: a
 * run was always a folder of its own.
 */
export function findRunFolders(paths: string[]): RunFolder[] {
  const found = new Set<string>();
  for (const path of paths) {
    const parts = path.split("/");
    // Folders only: the last part is the file name.
    for (let i = 1; i < parts.length - 1; i++) {
      if (parts[i] === RUN_FOLDER_MARKER) found.add(parts.slice(0, i).join("/"));
    }
  }
  return [...found]
    .sort((a, b) => a.localeCompare(b))
    .map((dir) => ({
      path: dir,
      name: dir.slice(dir.lastIndexOf("/") + 1),
      fileCount: paths.filter((p) => p.startsWith(`${dir}/`)).length,
    }));
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
