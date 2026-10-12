function count(value) {
  if (!Number.isInteger(value) || value < 0) throw new Error("Invalid test count");
  return value;
}

export function playwrightCounts(report) {
  const stats = report.stats;
  const passed = count(stats.expected) + count(stats.flaky);
  const failed = count(stats.unexpected);
  const skipped = count(stats.skipped);
  return { total: passed + failed + skipped, passed, failed, skipped, cancelled: 0, todo: 0, flaky: stats.flaky };
}

export function tapCounts(output) {
  const get = (name) => {
    const matches = [...output.matchAll(new RegExp(`^# ${name} (\\d+)\\r?$`, "gm"))];
    if (!matches.length) throw new Error(`Missing TAP count: ${name}`);
    return count(Number(matches.at(-1)[1]));
  };
  return { total: get("tests"), passed: get("pass"), failed: get("fail"), skipped: get("skipped"), cancelled: get("cancelled"), todo: get("todo"), flaky: 0 };
}

export function summaryMarkdown(records) {
  const escape = (value) => String(value).replace(/\|/g, "\\|").replace(/[\r\n]/g, " ");
  const lines = ["## Test suite results", "", "| Suite | Outcome | Cases | Passed | Failed | Skipped | Cancelled | Todo | Flaky |", "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |"];
  for (const record of records) {
    const c = record.counts;
    lines.push(`| ${escape(record.label)} | ${escape(record.outcome)} | ${c ? [c.total, c.passed, c.failed, c.skipped, c.cancelled, c.todo, c.flaky].join(" | ") : "— | — | — | — | — | — | —"} |`);
  }
  lines.push("", "Counts describe test cases, not retry attempts. Flaky Playwright cases are included in Passed and listed separately. Missing reports are shown explicitly; an unexecuted step is Not run.", "");
  return lines.join("\n");
}
