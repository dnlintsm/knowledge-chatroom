import { test, expect } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { playwrightCounts, summaryMarkdown, tapCounts } from "../../scripts/ci-test-results.mjs";

const tap = "# tests 4\n# pass 1\n# fail 1\n# cancelled 1\n# skipped 1\n# todo 0\n";

test("suite counts retain failures, skips and cancellation and distinguish retries", () => {
  expect(tapCounts(`diagnostic output\n${tap}`)).toMatchObject({ total: 4, passed: 1, failed: 1, cancelled: 1, skipped: 1 });
  expect(playwrightCounts({ stats: { expected: 2, unexpected: 1, flaky: 1, skipped: 3 } })).toMatchObject({ total: 7, passed: 3, failed: 1, skipped: 3, flaky: 1 });
  expect(() => tapCounts("no report")).toThrow();
  expect(() => playwrightCounts({ stats: { expected: -1 } })).toThrow();
});

test("the reporting wrapper preserves failed commands and reports unexecuted suites", () => {
  const directory = mkdtempSync(join(tmpdir(), "ci-summary-test-"));
  const script = resolve("scripts/ci-tests.mjs");
  const env = { ...process.env, CI_TEST_REPORT_DIR: directory, GITHUB_STEP_SUMMARY: join(directory, "summary.md") };
  try {
    const failed = spawnSync(process.execPath, [script, "run", "Storage", "tap", "--", process.execPath, "-e", `process.stdout.write(${JSON.stringify(tap)}); process.exit(23);`], { env });
    expect(failed.status).toBe(23);
    const summary = spawnSync(process.execPath, [script, "summary", "Storage", "Login"], { env });
    expect(summary.status).toBe(0);
    const markdown = readFileSync(env.GITHUB_STEP_SUMMARY, "utf8");
    expect(markdown).toContain("| Storage | Failed | 4 | 1 | 1 | 1 | 1 | 0 | 0 |");
    expect(markdown).toContain("| Login | Not run | —");
    for (const output of ["", "# tests 1\n# pass 0\n# fail 0\n# cancelled 0\n# skipped 1\n# todo 0\n"]) {
      const missing = spawnSync(process.execPath, [script, "run", "Required", "tap", "--", process.execPath, "-e", `process.stdout.write(${JSON.stringify(output)});`], { env });
      expect(missing.status).toBe(1);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("summary renders suites with missing reports without inventing zero counts", () => {
  expect(summaryMarkdown([{ label: "Browser", outcome: "Failed — no report", counts: null }])).toContain("| Browser | Failed — no report | —");
});
