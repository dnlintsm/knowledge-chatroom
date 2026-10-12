import { test, expect } from "@playwright/test";
import { parseRulesResponse, rulesPath, rulesToMarkdown } from "../../src/components/workspace/rules";
import { mockRules } from "../../src/lib/rules-mock";

/** The rules API answer and its fixed markdown transform (src/components/workspace/rules.ts). */

test("the rules file lives in the run's models folder", () => {
  expect(rulesPath("runs/etch-01")).toBe("runs/etch-01/models/general_rules.md");
});

test("turns the API's JSON into a fixed markdown table", () => {
  const md = rulesToMarkdown(
    parseRulesResponse({
      run: "runs/etch-01",
      generatedAt: "2026-10-08T00:00:00.000Z",
      rules: [
        { id: "R1", title: "Power | rate", condition: "RF power\nrises", action: "Rate rises", confidence: 0.934 },
        { id: "R2", title: "Clamp", condition: "x", action: "y", confidence: 1.7 },
      ],
    }),
  );
  expect(md).toBe(
    [
      "# General rules: etch-01",
      "",
      "Generated from the rules API for `runs/etch-01` (2026-10-08T00:00:00.000Z). This file is read-only.",
      "",
      "| ID | Rule | When | Then | Confidence |",
      "| --- | --- | --- | --- | --- |",
      "| R1 | Power \\| rate | RF power rises | Rate rises | 93% |",
      "| R2 | Clamp | x | y | 100% |",
      "",
    ].join("\n"),
  );
  // Same input, same file.
  expect(rulesToMarkdown(mockRules("runs/a"))).toBe(rulesToMarkdown(mockRules("runs/a")));
});

test("says so when there are no rules", () => {
  expect(rulesToMarkdown({ run: "runs/a", generatedAt: "t", rules: [] })).toContain("returned no rules");
});

test("rejects malformed answers", () => {
  expect(() => parseRulesResponse(null)).toThrow(/no JSON object/);
  expect(() => parseRulesResponse({ run: "a", rules: [] })).toThrow(/run, generatedAt and rules/);
  expect(() =>
    parseRulesResponse({ run: "a", generatedAt: "t", rules: [{ id: "R1", title: "t", condition: "c", action: "a" }] }),
  ).toThrow(/Rule 1/);
  expect(parseRulesResponse(mockRules("runs/a")).rules).toHaveLength(3);
});
