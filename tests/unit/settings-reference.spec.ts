import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { documented, problems, PROCESSES, REFERENCE } from "../../scripts/settings-check.mjs";

/** docs/settings.md against the settings the code reads (scripts/settings-check.mjs). */

// The unit tests run from the repository root.
const root = resolve(".");
const reference = readFileSync(resolve(root, REFERENCE), "utf8");

test("the settings reference lists every setting the code reads, and none it no longer names", () => {
  expect(problems(root)).toEqual([]);
});

test("every process has a table with settings in it", () => {
  const sections = documented(reference);
  for (const { heading } of PROCESSES) {
    expect(sections.get(heading)?.size ?? 0, heading).toBeGreaterThan(0);
  }
});

test("a setting missing from a table, and a row for a setting that is gone, are both reported", () => {
  // The UI reads LOCAL_AGENT_URL; its row is the first one in the file.
  const row = /^\| `LOCAL_AGENT_URL` \|.*\n/m;
  expect(reference).toMatch(row);
  expect(problems(root, reference.replace(row, ""))).toContain(
    `Web app reads LOCAL_AGENT_URL, which its table in ${REFERENCE} doesn't list`,
  );

  const gone = "SETTING_" + "REMOVED_LONG_AGO";
  const withStaleRow = reference.replace(/^(## api-py\n[\s\S]*?\| --- \|.*\n)/m, `$1| \`${gone}\` | unset | Was removed. |\n`);
  expect(withStaleRow).not.toBe(reference);
  expect(problems(root, withStaleRow)).toEqual([
    `${REFERENCE} lists ${gone} under api-py, but that code doesn't name it`,
  ]);

  expect(problems(root, reference.replace("## lab-tools", "## Lab tools"))).toContain(
    `${REFERENCE} has no "## lab-tools" section`,
  );
});
