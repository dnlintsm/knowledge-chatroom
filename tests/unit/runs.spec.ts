import { test, expect } from "@playwright/test";
import {
  ALL_EXPERIMENTS,
  experimentFromSearch,
  experimentsIn,
  findReport,
  listScopeFromSearch,
  runsUnder,
  searchWithExperiment,
  searchWithListScope,
  shownScope,
} from "../../apps/web/src/components/workspace/runs";
import type { Experiment, KnowledgeNode } from "../../apps/web/src/components/workspace/server-files";

/** Runs are experiments (apps/web/src/components/workspace/runs.ts), no browser needed. */

test("a run's report is its report.md at the top of the run", () => {
  expect(findReport(["data.csv", "report.md"])).toBe("report.md");
  expect(findReport(["notes/report.md", "data.csv"])).toBeNull();
  // The old xDOE location doesn't count any more.
  expect(findReport(["xdoe-report/report.md", "xdoe-report/effects.csv"])).toBeNull();
});

const node = (id: string, parentId: string | null) => ({ id, parentId }) as KnowledgeNode;
const run = (id: string, nodeId: string | null) => ({ id, nodeId }) as Experiment;

test("the runs at a place are those on it and below it; at the root, all of them", () => {
  const nodes = [node("tech", null), node("module", "tech"), node("loop", "module"), node("other", null)];
  const runs = [run("r-root", null), run("r-tech", "tech"), run("r-loop", "loop"), run("r-other", "other")];
  const ids = (nodeId: string | null) => runsUnder(runs, nodes, nodeId).map((r) => r.id);
  expect(ids(null)).toEqual(["r-root", "r-tech", "r-loop", "r-other"]);
  expect(ids("tech")).toEqual(["r-tech", "r-loop"]);
  expect(ids("module")).toEqual(["r-loop"]);
  expect(ids("other")).toEqual(["r-other"]);
});

test("keeps the run in the URL, and drops old ?run= links", () => {
  expect(experimentFromSearch("")).toBeNull();
  expect(experimentFromSearch("?experiment=")).toBeNull();
  expect(experimentFromSearch("?experiment=9f8e")).toBe("9f8e");
  expect(searchWithExperiment("", "9f8e")).toBe("?experiment=9f8e");
  expect(searchWithExperiment("?debug=1", "9f8e")).toBe("?debug=1&experiment=9f8e");
  expect(searchWithExperiment("?experiment=a&debug=1", null)).toBe("?debug=1");
  expect(searchWithExperiment("?run=runs/etch-01", null)).toBe("");
  expect(experimentFromSearch(searchWithExperiment("?run=x", "a&b=c"))).toBe("a&b=c");
});

test("the list scope round-trips through the URL, apart from the experiment", () => {
  expect(listScopeFromSearch("")).toBeNull();
  expect(listScopeFromSearch("?experiment=e1")).toBeNull();
  expect(listScopeFromSearch("?list=all")).toEqual(ALL_EXPERIMENTS);
  expect(listScopeFromSearch("?list=loop")).toEqual({ node: "loop", descendants: true });
  expect(listScopeFromSearch("?list=loop&direct=1")).toEqual({ node: "loop", descendants: false });

  const scoped = searchWithListScope("?experiment=e1", { node: "loop", descendants: false });
  expect(new URLSearchParams(scoped).get("experiment")).toBe("e1");
  expect(listScopeFromSearch(scoped)).toEqual({ node: "loop", descendants: false });
  // All is no parameter at all, so root links stay as they were.
  expect(searchWithListScope(scoped, ALL_EXPERIMENTS)).toBe("?experiment=e1");
  expect(searchWithListScope("?list=loop&direct=1", ALL_EXPERIMENTS)).toBe("");
  // All chosen on a node stays in the URL, so a reload keeps it.
  const all = searchWithListScope("?list=loop&direct=1", ALL_EXPERIMENTS, true);
  expect(all).toBe("?list=all");
  expect(listScopeFromSearch(all)).toEqual(ALL_EXPERIMENTS);
  // Opening another experiment keeps the scope.
  expect(listScopeFromSearch(searchWithExperiment(scoped, "e2"))).toEqual({ node: "loop", descendants: false });
});

test("a scope shows a node's experiments, with or without its sub-levels", () => {
  const nodes = [node("tech", null), node("module", "tech"), node("loop", "module")];
  const runs = [run("r-root", null), run("r-tech", "tech"), run("r-loop", "loop")];
  const ids = (scope: { node: string | null; descendants: boolean }) =>
    experimentsIn(runs, nodes, scope).map((r) => r.id);
  expect(ids(ALL_EXPERIMENTS)).toEqual(["r-root", "r-tech", "r-loop"]);
  expect(ids({ node: "tech", descendants: true })).toEqual(["r-tech", "r-loop"]);
  expect(ids({ node: "tech", descendants: false })).toEqual(["r-tech"]);
  // A node that is gone (or not visible) shows them all, and the chip says so.
  expect(ids({ node: "gone", descendants: true })).toEqual(["r-root", "r-tech", "r-loop"]);
  expect(shownScope({ node: "gone", descendants: false }, nodes)).toEqual(ALL_EXPERIMENTS);
  expect(shownScope({ node: "loop", descendants: false }, nodes)).toEqual({ node: "loop", descendants: false });
});
