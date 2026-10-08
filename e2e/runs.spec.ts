import { test, expect } from "@playwright/test";
import { findRunDirs, isInRun, parseMarkers, runFromSearch, searchWithRun } from "../src/components/workspace/runs";

/** Run discovery and the ?run= URL (src/components/workspace/runs.ts), no browser needed. */

test("finds run folders by their marker folders", () => {
  const paths = [
    "runs/etch-01/xdoe-report/report.md",
    "runs/etch-01/xdoe-report/effects.csv",
    "runs/etch-01/notes.md",
    "runs/litho-02/xdoe-report/report.md",
    "lab/2026/q4/cvd-07/xdoe-report/report.md",
    // A marker at the root, a marker that's a file and unrelated files make no run.
    "xdoe-report/report.md",
    "runs/odd/xdoe-report",
    "notes/welcome.md",
  ];
  expect(findRunDirs(paths, ["xdoe-report"])).toEqual([
    { path: "lab/2026/q4/cvd-07", name: "cvd-07", parent: "lab/2026/q4", markers: ["xdoe-report"], fileCount: 1 },
    { path: "runs/etch-01", name: "etch-01", parent: "runs", markers: ["xdoe-report"], fileCount: 3 },
    { path: "runs/litho-02", name: "litho-02", parent: "runs", markers: ["xdoe-report"], fileCount: 1 },
  ]);
  // Any configured marker counts, and a top-level folder can be a run.
  expect(findRunDirs(["r1/xdoe-report/a.md", "r1/sem-images/b.png", "r2/sem-images/c.png"], ["xdoe-report", "sem-images"]))
    .toEqual([
      { path: "r1", name: "r1", parent: "", markers: ["sem-images", "xdoe-report"], fileCount: 2 },
      { path: "r2", name: "r2", parent: "", markers: ["sem-images"], fileCount: 1 },
    ]);
});

test("reads RUN_DIR_MARKERS", () => {
  expect(parseMarkers(undefined)).toEqual(["xdoe-report"]);
  expect(parseMarkers("")).toEqual(["xdoe-report"]);
  expect(parseMarkers(" xdoe-report, sem-images/ ,,bad/path,sem-images")).toEqual(["xdoe-report", "sem-images"]);
});

test("files belong to a run by path prefix", () => {
  expect(isInRun("runs/a/x.md", "runs/a")).toBe(true);
  expect(isInRun("runs/ab/x.md", "runs/a")).toBe(false);
  expect(isInRun("runs/a", "runs/a")).toBe(false);
});

test("keeps the run in the URL", () => {
  expect(runFromSearch("")).toBeNull();
  expect(runFromSearch("?run=")).toBeNull();
  expect(runFromSearch("?run=runs/etch-01")).toBe("runs/etch-01");
  expect(runFromSearch("?run=%2Fruns%2F%2Fetch-01%2F")).toBe("runs/etch-01");
  expect(searchWithRun("", "runs/etch 01")).toBe("?run=runs/etch%2001");
  expect(searchWithRun("?run=a&debug=1", "runs/b")).toBe("?run=runs/b&debug=1");
  expect(searchWithRun("?run=a&debug=1", null)).toBe("?debug=1");
  expect(searchWithRun("?run=a", null)).toBe("");
  expect(runFromSearch(searchWithRun("", "runs/a&b=c"))).toBe("runs/a&b=c");
});
