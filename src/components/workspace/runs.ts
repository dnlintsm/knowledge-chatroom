/**
 * Runs: a RUN_DIR is a plain folder holding one experiment run's artifacts,
 * recognised by a marker folder inside it (`xdoe-report/` by default). The
 * workbench focuses on one run at a time (Focus mode) or lists them all
 * (Traverse mode); the current run lives in the URL as `?run=<path>`.
 */

/** Folders that make their parent a run, from RUN_DIR_MARKERS (comma-separated). */
export const RUN_DIR_MARKERS = parseMarkers(process.env.NEXT_PUBLIC_RUN_DIR_MARKERS);

/** Where a run's main report lives, relative to the run. */
export const RUN_REPORT = "xdoe-report/report.md";

export interface RunDir {
  /** Workspace path of the run folder, e.g. runs/etch-2026-10-01. */
  path: string;
  /** Its folder name. */
  name: string;
  /** The folder it sits in, "" at the workspace root. */
  parent: string;
  /** Marker folders found in it. */
  markers: string[];
  fileCount: number;
}

export function parseMarkers(raw: string | undefined): string[] {
  const markers = (raw ?? "")
    .split(",")
    .map((m) => m.trim().replace(/^\/+|\/+$/g, ""))
    .filter((m) => m && !m.includes("/"));
  return markers.length ? [...new Set(markers)] : ["xdoe-report"];
}

export function normalizeRunDir(raw: string): string {
  return raw.trim().replace(/^\/+|\/+$/g, "").replace(/\/+/g, "/");
}

/** True for files inside the run (at any depth). */
export function isInRun(path: string, runDir: string): boolean {
  return path.startsWith(`${runDir}/`);
}

/**
 * Every folder holding a marker folder, sorted by path. A marker at the
 * workspace root makes no run: a run is always a folder of its own.
 */
export function findRunDirs(paths: string[], markers: string[] = RUN_DIR_MARKERS): RunDir[] {
  const found = new Map<string, Set<string>>();
  for (const path of paths) {
    const parts = path.split("/");
    // Folders only: the last part is the file name.
    for (let i = 1; i < parts.length - 1; i++) {
      if (!markers.includes(parts[i])) continue;
      const dir = parts.slice(0, i).join("/");
      if (!found.has(dir)) found.set(dir, new Set());
      found.get(dir)!.add(parts[i]);
    }
  }
  return [...found.entries()]
    .map(([dir, marks]) => {
      const cut = dir.lastIndexOf("/");
      return {
        path: dir,
        name: dir.slice(cut + 1),
        parent: cut === -1 ? "" : dir.slice(0, cut),
        markers: [...marks].sort(),
        fileCount: paths.filter((p) => isInRun(p, dir)).length,
      };
    })
    .sort((a, b) => a.path.localeCompare(b.path));
}

/** The run named in a URL query string, or null for Traverse mode. */
export function runFromSearch(search: string): string | null {
  const raw = new URLSearchParams(search).get("run");
  const dir = raw ? normalizeRunDir(raw) : "";
  return dir || null;
}

/** The query string with `run` set (or removed), keeping other parameters. Slashes stay readable. */
export function searchWithRun(search: string, runDir: string | null): string {
  const params = new URLSearchParams(search);
  params.delete("run");
  const rest = params.toString();
  const run = runDir ? `run=${encodeURIComponent(runDir).replace(/%2F/gi, "/")}` : "";
  const query = [run, rest].filter(Boolean).join("&");
  return query ? `?${query}` : "";
}
