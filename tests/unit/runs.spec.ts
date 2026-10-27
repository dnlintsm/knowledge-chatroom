import { test, expect } from "@playwright/test";
import {
  experimentFromSearch,
  findReport,
  runsUnder,
  searchWithExperiment,
} from "../../src/components/workspace/runs";
import type { Experiment, KnowledgeNode } from "../../src/components/workspace/server-files";

/** Runs are experiments (src/components/workspace/runs.ts), no browser needed. */

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
