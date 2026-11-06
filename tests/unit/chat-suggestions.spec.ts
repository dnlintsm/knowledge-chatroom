import { test, expect } from "@playwright/test";
import {
  FOLLOW_UP_INSTRUCTIONS,
  firstRoundSuggestions,
  type SuggestionPlace,
} from "../../src/components/workspace/chat-suggestions";

const nowhere: SuggestionPlace = {
  openFile: null,
  runTitle: null,
  report: null,
  nodeName: null,
  serverStorage: false,
};
const titles = (place: Partial<SuggestionPlace>) => firstRoundSuggestions({ ...nowhere, ...place }).map((s) => s.title);

test("with nothing open only drafting a note applies", () => {
  const chips = firstRoundSuggestions(nowhere);
  expect(chips).toHaveLength(1);
  expect(chips[0]).toEqual({
    title: "Draft a note",
    message: "Look at my workspace files and draft a short note at notes/next-steps.md with what I should do next.",
  });
});

test("when only an open file is present, adds summarize chip using base file name", () => {
  const chips = firstRoundSuggestions({
    ...nowhere,
    openFile: "nested/path/to/results.json",
  });
  expect(chips.map((s) => s.title)).toEqual(["Summarize results.json", "Draft a note"]);
  expect(chips[0]).toEqual({
    title: "Summarize results.json",
    message: "Summarize nested/path/to/results.json in a few bullets, then save the summary as a new file in the artifacts folder.",
  });
  expect(chips[1]).toEqual({
    title: "Draft a note",
    message: "Look at my workspace files and draft a short note at notes/next-steps.md with what I should do next.",
  });
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
  expect(chips[2]).toEqual({
    title: "Analyze the report",
    message:
      'Analyze the report of the run "Etch, higher RF" at report.md: the key findings and how strong the evidence is, ' +
      "anything that looks off or inconsistent, and which runs to try next.",
  });
});

test("a run without its report has no analyze chip", () => {
  expect(titles({ runTitle: "Etch" })).toEqual(["Draft a note"]);
});

test("a report without a runTitle has no analyze chip", () => {
  expect(titles({ report: "report.md" })).toEqual(["Draft a note"]);
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
  expect(like({})).toContain("search_files by meaning");
});

test("all conditions met produces full ordered list of chips", () => {
  const chips = firstRoundSuggestions({
    openFile: "src/main.py",
    runTitle: "Run 1",
    report: "results/report.html",
    nodeName: "Optimization Node",
    serverStorage: true,
  });

  expect(chips.map((s) => s.title)).toEqual([
    "Summarize main.py",
    "Draft a note",
    "Analyze the report",
    "Search similar experiments",
  ]);

  expect(chips[0].title).toBe("Summarize main.py");
  expect(chips[1].message).toContain('the run "Run 1"');
  expect(chips[2].message).toContain('the run "Run 1" at results/report.html');
  expect(chips[3].message).toContain('Find experiments similar to the run "Run 1"');
});

test("serverStorage with nodeName alone compares against the work on that node", () => {
  const chips = firstRoundSuggestions({
    ...nowhere,
    nodeName: "Plasma Etch V2",
    serverStorage: true,
  });

  expect(chips.map((s) => s.title)).toEqual(["Draft a note", "Search similar experiments"]);
  expect(chips[1].message).toContain("Find experiments similar to the work on Plasma Etch V2");
});

test("serverStorage with neither runTitle nor nodeName compares against what I'm working on", () => {
  const chips = firstRoundSuggestions({
    ...nowhere,
    serverStorage: true,
  });

  expect(chips.map((s) => s.title)).toEqual(["Draft a note", "Search similar experiments"]);
  expect(chips[1].message).toContain("Find experiments similar to what I'm working on");
});

test("exports FOLLOW_UP_INSTRUCTIONS with expected guidance text", () => {
  expect(typeof FOLLOW_UP_INSTRUCTIONS).toBe("string");
  expect(FOLLOW_UP_INSTRUCTIONS.length).toBeGreaterThan(0);
  expect(FOLLOW_UP_INSTRUCTIONS).toContain("Suggest the next steps");
});
