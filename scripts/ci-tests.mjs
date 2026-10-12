import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { playwrightCounts, summaryMarkdown, tapCounts } from "./ci-test-results.mjs";

const args = process.argv.slice(2);
const directory = process.env.CI_TEST_REPORT_DIR ?? join(process.env.RUNNER_TEMP ?? tmpdir(), "knowledge-chatroom-tests", process.env.GITHUB_RUN_ID ?? "local", process.env.GITHUB_JOB ?? "local");
const fileFor = (label) => join(directory, `${Buffer.from(label).toString("hex")}.json`);
mkdirSync(directory, { recursive: true });

if (args[0] === "summary") {
  const records = args.slice(1).map((label) => {
    try { return JSON.parse(readFileSync(fileFor(label), "utf8")); }
    catch { return { label, outcome: "Not run", counts: null }; }
  });
  const markdown = summaryMarkdown(records);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
  else process.stdout.write(markdown);
} else if (args[0] === "run" && ["tap", "playwright"].includes(args[2]) && args[3] === "--" && args.length > 4) {
  const [, label, kind, , command, ...commandArgs] = args;
  const rawReport = join(directory, `${Buffer.from(label).toString("hex")}.playwright.json`);
  rmSync(fileFor(label), { force: true });
  rmSync(rawReport, { force: true });
  const child = spawn(command, commandArgs, {
    env: { ...process.env, ...(kind === "playwright" ? { PLAYWRIGHT_JSON_OUTPUT_NAME: rawReport } : {}) },
    stdio: ["inherit", "pipe", "pipe"],
  });
  let tail = "";
  child.stdout.on("data", (chunk) => {
    process.stdout.write(chunk);
    tail = (tail + chunk.toString()).slice(-256_000);
  });
  child.stderr.pipe(process.stderr);
  const forwardSignal = (signal) => child.kill(signal);
  process.once("SIGINT", () => forwardSignal("SIGINT"));
  process.once("SIGTERM", () => forwardSignal("SIGTERM"));
  let spawnError;
  child.once("error", (error) => { spawnError = error; });
  const status = await new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal })));
  let exitCode = spawnError ? 127 : status.code ?? (status.signal === "SIGINT" ? 130 : 143);
  let counts = null;
  try {
    counts = kind === "playwright" ? playwrightCounts(JSON.parse(readFileSync(rawReport, "utf8"))) : tapCounts(tail);
    // Required suites cannot silently succeed with no cases or only skips.
    if (exitCode === 0 && (!counts.total || counts.failed || counts.cancelled || counts.passed === 0)) exitCode = 1;
  } catch (error) {
    console.error(`[test results] ${label}: ${error.message}`);
    if (exitCode === 0) exitCode = 1;
  }
  if (spawnError) console.error(spawnError.message);
  writeFileSync(fileFor(label), JSON.stringify({ label, outcome: exitCode === 0 ? "Passed" : counts ? "Failed" : "Failed — no report", counts, exitCode }));
  process.exitCode = exitCode;
} else {
  console.error("Usage: ci-tests.mjs run <suite> <tap|playwright> -- <command> [args], or summary <suite> [...]");
  process.exitCode = 1;
}
