import { test, expect } from "@playwright/test";
import { firstRoundSuggestions, type SuggestionPlace } from "../../src/components/workspace/chat-suggestions";

const nowhere: SuggestionPlace = {
  openFile: null,
  runTitle: null,
  report: null,
  nodeName: null,
  serverStorage: false,
};
const titles = (place: Partial<SuggestionPlace>) => firstRoundSuggestions({ ...nowhere, ...place }).map((s) => s.title);

test("with nothing open only drafting a note applies", () => {
  expect(titles({})).toEqual(["Draft a note"]);
});

test("a run with a report offers all of its chips, named after the file and run", () => {
  const chips = firstRoundSuggestions({
    ...nowhere,
    openFile: "data/effects.csv",
    runTitle: "Etch, higher RF",
    report: "report.md",
  });
  expect(chips.map((s) => s.title)).toEqual(["Summarize effects.csv", "Draft a note", "Analyze the report"]);
  expect(chips[0].message).toContain("data/effects.csv");
  expect(chips[0].message).toContain("the artifacts folder.");
  expect(chips[1].message).toContain('the run "Etch, higher RF"');
  expect(chips[1].message).toContain("notes/next-steps.md in the run");
  expect(chips[2].message).toContain('the run "Etch, higher RF" at report.md');
});

test("a run without its report has no analyze chip", () => {
  expect(titles({ runTitle: "Etch" })).toEqual(["Draft a note"]);
});

test("similar experiments needs server storage and names what to compare against", () => {
  expect(titles({ runTitle: "Higher RF power" })).not.toContain("Search similar experiments");
  const like = (place: Partial<SuggestionPlace>) =>
    firstRoundSuggestions({ ...nowhere, serverStorage: true, ...place }).find(
      (s) => s.title === "Search similar experiments",
    )!.message;
  expect(like({ runTitle: "Higher RF power", nodeName: "Main etch" })).toContain('the run "Higher RF power"');
  expect(like({ nodeName: "Main etch" })).toContain("the work on Main etch");
  expect(like({})).toContain("what I'm working on");
  expect(like({})).toContain("list_experiments");
});
