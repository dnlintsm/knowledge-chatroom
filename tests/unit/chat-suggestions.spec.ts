import { test, expect } from "@playwright/test";
import { firstRoundSuggestions, type SuggestionPlace } from "../../src/components/workspace/chat-suggestions";

const nowhere: SuggestionPlace = {
  openFile: null,
  runDir: null,
  hasReport: false,
  nodeName: null,
  experimentTitle: null,
  serverStorage: false,
};
const titles = (place: Partial<SuggestionPlace>) => firstRoundSuggestions({ ...nowhere, ...place }).map((s) => s.title);

test("with nothing open only drafting a note applies", () => {
  expect(titles({})).toEqual(["Draft a note"]);
});

test("a focused run with a report offers all of its chips, named after the file and run", () => {
  const chips = firstRoundSuggestions({
    ...nowhere,
    openFile: "runs/etch/data/effects.csv",
    runDir: "runs/etch",
    hasReport: true,
  });
  expect(chips.map((s) => s.title)).toEqual(["Summarize effects.csv", "Draft a note", "Analyze the etch report"]);
  expect(chips[0].message).toContain("runs/etch/data/effects.csv");
  expect(chips[0].message).toContain("the runs/etch/artifacts folder.");
  expect(chips[1].message).toContain("runs/etch/notes/next-steps.md");
  expect(chips[2].message).toContain("runs/etch/xdoe-report/report.md");
});

test("a run without its report has no analyze chip", () => {
  expect(titles({ runDir: "runs/etch" })).toEqual(["Draft a note"]);
});

test("similar experiments needs server storage and names what to compare against", () => {
  expect(titles({ experimentTitle: "Higher RF power" })).not.toContain("Search similar experiments");
  const like = (place: Partial<SuggestionPlace>) =>
    firstRoundSuggestions({ ...nowhere, serverStorage: true, ...place }).find(
      (s) => s.title === "Search similar experiments",
    )!.message;
  expect(like({ experimentTitle: "Higher RF power", runDir: "runs/etch" })).toContain('experiment "Higher RF power"');
  expect(like({ runDir: "runs/etch", nodeName: "Main etch" })).toContain("the run etch");
  expect(like({ nodeName: "Main etch" })).toContain("the work on Main etch");
  expect(like({})).toContain("what I'm working on");
  expect(like({})).toContain("list_experiments");
});
