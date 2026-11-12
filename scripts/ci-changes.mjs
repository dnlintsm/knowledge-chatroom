// Decides which CI suites a pull request can affect (issue #192).
//
//   node scripts/ci-changes.mjs            # in CI: writes suite flags to $GITHUB_OUTPUT
//   node scripts/ci-changes.mjs a.py b.ts  # locally: prints the flags for these paths
//
// Each changed path adds the suites listed for the first rule it matches. A path
// that no rule matches runs every suite, so a new directory is covered until
// someone adds a narrower rule. Pushes, manual runs and a diff that cannot be
// computed also run every suite. The required checks (`checks`, `preview`,
// `python`) are gate jobs that accept only the skips decided here.
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";

export const SUITES = ["node", "python", "browser", "storage", "pyagent"];

// [path pattern, suites]. Patterns: `dir/**` (anything below), or an exact path.
export const RULES = [
  // Documentation outside the code. Markdown under apps/ is runtime content (skills).
  ["docs/**", []],
  ["README.md", []],
  ["CHANGELOG.md", []],
  ["LICENSE", []],
  // Python services the E2E suites never start (the mock agent stands in for them).
  ["services/lab-tools/**", ["python"]],
  ["services/papers-mcp/**", ["python"]],
  ["examples/python-agent/**", ["python"]],
  // api-py sits in front of the agent in the storage and login E2E runs (#190).
  ["services/api-py/**", ["python", "storage"]],
  // agent-py serves the chat in the Python agent E2E run (#176).
  ["services/agent-py/**", ["python", "pyagent"]],
  // Shared by both Python services, or the whole uv workspace.
  ["packages/knowledge-py/**", ["python", "storage", "pyagent"]],
  ["pyproject.toml", ["python", "storage", "pyagent"]],
  ["uv.lock", ["python", "storage", "pyagent"]],
  [".python-version", ["python", "storage", "pyagent"]],
  ["pyrefly-baseline.json", ["python"]],
];

function matches(pattern, path) {
  return pattern.endsWith("/**") ? path.startsWith(pattern.slice(0, -2)) : path === pattern;
}

/** The suites to run for these changed paths, as { suite: boolean }. */
export function affectedSuites(paths) {
  const run = new Set();
  for (const path of paths) {
    const rule = RULES.find(([pattern]) => matches(pattern, path));
    for (const suite of rule ? rule[1] : SUITES) run.add(suite);
  }
  return Object.fromEntries(SUITES.map((suite) => [suite, run.has(suite)]));
}

export function allSuites() {
  return Object.fromEntries(SUITES.map((suite) => [suite, true]));
}

// On pull_request, actions/checkout checks out the merge commit: its first parent
// is the base branch tip, so this is the PR's effect on the current base.
// --no-renames lists both sides of a rename.
function changedPaths() {
  const out = execFileSync("git", ["diff", "--name-only", "--no-renames", "HEAD^1", "HEAD"], { encoding: "utf8" });
  return out.split("\n").filter(Boolean);
}

function main() {
  const args = process.argv.slice(2);
  if (args.length) {
    console.log(JSON.stringify(affectedSuites(args), null, 2));
    return;
  }
  let suites;
  let reason;
  if (process.env.GITHUB_EVENT_NAME !== "pull_request") {
    suites = allSuites();
    reason = `Event ${process.env.GITHUB_EVENT_NAME ?? "unknown"}: running every suite.`;
  } else {
    try {
      const paths = changedPaths();
      if (!paths.length) throw new Error("empty diff");
      suites = affectedSuites(paths);
      reason = `${paths.length} changed path(s):\n\n${paths.slice(0, 50).map((p) => `- \`${p}\``).join("\n")}${paths.length > 50 ? "\n- …" : ""}`;
    } catch (error) {
      suites = allSuites();
      reason = `Could not determine the changed paths (${error.message}): running every suite.`;
    }
  }
  const lines = SUITES.map((suite) => `${suite}=${suites[suite]}`);
  console.log(lines.join("\n"));
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join("\n")}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    const table = SUITES.map((suite) => `| ${suite} | ${suites[suite] ? "run" : "skip"} |`).join("\n");
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Affected suites\n\n| Suite | |\n| --- | --- |\n${table}\n\n${reason}\n`);
  }
}

// Not import.meta: the unit tests load this module through a CommonJS transform.
if (process.argv[1]?.endsWith("ci-changes.mjs")) main();
