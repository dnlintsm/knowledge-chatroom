// Decides which demo images a pull request can affect (issue #218).
//
//   node scripts/docker-changes.mjs            # in CI: writes `images` (JSON) and `compose` to $GITHUB_OUTPUT
//   node scripts/docker-changes.mjs a.py b.ts  # locally: prints them for these paths
//
// Same approach as scripts/ci-changes.mjs: each changed path adds the targets of
// the first rule it matches, and a path no rule matches builds every image, so a
// new input is covered until someone adds a narrower rule. Pushes, manual runs
// and a diff that cannot be computed also build everything.
//
// The rules follow what each Dockerfile copies:
// - app (Dockerfile, target app): the pnpm manifests, packages/contracts, apps/web.
// - agent (Dockerfile, target agent): the pnpm manifests, packages/contracts, apps/agent.
// - api-py: the uv workspace, packages/knowledge-py, services/api-py, and from
//   apps/agent the storage migrations and the skills.
// - agent-py, lab-tools, papers-mcp: the uv workspace, packages/knowledge-py, their service.
// `compose` is the `docker compose config` check of docker-compose.yml.
//
// The no-rule fallback only covers paths no rule matches. A file under a directory
// that already has a rule (say apps/web/** or a skipped e2e/**) follows that rule,
// so when a Dockerfile starts copying something new, add or move a rule here and a
// case in tests/unit/docker-changes.spec.ts in the same change.
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { matches } from "./ci-changes.mjs";

export const IMAGES = ["app", "agent", "api-py", "agent-py", "lab-tools", "papers-mcp"];
export const TARGETS = [...IMAGES, "compose"];

const NODE = ["app", "agent"];
const PYTHON = ["api-py", "agent-py", "lab-tools", "papers-mcp"];

// [path pattern, targets]. Patterns: `dir/**` (anything below), or an exact path.
export const RULES = [
  // Not read by any image build.
  ["docs/**", []],
  ["README.md", []],
  ["CHANGELOG.md", []],
  ["LICENSE", []],
  ["e2e/**", []],
  ["tests/**", []],
  ["examples/**", []],
  ["pyrefly-baseline.json", []],
  // This workflow builds everything; the other workflows build nothing here.
  [".github/workflows/docker.yml", TARGETS],
  [".github/**", []],
  // Build context and compose.
  [".dockerignore", TARGETS],
  ["Dockerfile", NODE],
  ["docker-compose.yml", ["compose"]],
  ["infra/**", ["compose"]],
  // api-py packages these from the agent (services/api-py/Dockerfile).
  ["apps/agent/src/storage/migrations/**", ["agent", "api-py"]],
  ["apps/agent/skills/**", ["agent", "api-py"]],
  // Both Node images install from every workspace manifest.
  ["apps/web/package.json", NODE],
  ["apps/agent/package.json", NODE],
  ["apps/web/**", ["app"]],
  ["apps/agent/**", ["agent"]],
  ["packages/contracts/**", NODE],
  ["package.json", NODE],
  ["pnpm-lock.yaml", NODE],
  ["pnpm-workspace.yaml", NODE],
  // The uv workspace.
  ["packages/knowledge-py/**", PYTHON],
  ["pyproject.toml", PYTHON],
  ["uv.lock", PYTHON],
  ["services/api-py/**", ["api-py"]],
  ["services/agent-py/**", ["agent-py"]],
  ["services/lab-tools/**", ["lab-tools"]],
  ["services/papers-mcp/**", ["papers-mcp"]],
];

/** What to build for these changed paths: { images: string[], compose: boolean }. */
export function affectedImages(paths) {
  const run = new Set();
  for (const path of paths) {
    const rule = RULES.find(([pattern]) => matches(pattern, path));
    for (const target of rule ? rule[1] : TARGETS) run.add(target);
  }
  return { images: IMAGES.filter((image) => run.has(image)), compose: run.has("compose") };
}

export function allImages() {
  return { images: [...IMAGES], compose: true };
}

// The merge commit's first parent is the base branch tip (see ci-changes.mjs).
// --no-renames lists both sides of a rename, so a moved file counts for both places.
function changedPaths() {
  const out = execFileSync("git", ["diff", "--name-only", "--no-renames", "HEAD^1", "HEAD"], { encoding: "utf8" });
  return out.split("\n").filter(Boolean);
}

function main() {
  const args = process.argv.slice(2);
  if (args.length) {
    console.log(JSON.stringify(affectedImages(args), null, 2));
    return;
  }
  let result;
  let reason;
  if (process.env.GITHUB_EVENT_NAME !== "pull_request") {
    result = allImages();
    reason = `Event ${process.env.GITHUB_EVENT_NAME ?? "unknown"}: building every image.`;
  } else {
    try {
      const paths = changedPaths();
      if (!paths.length) throw new Error("empty diff");
      result = affectedImages(paths);
      reason = `${paths.length} changed path(s):\n\n${paths.slice(0, 50).map((p) => `- \`${p}\``).join("\n")}${paths.length > 50 ? "\n- …" : ""}`;
    } catch (error) {
      result = allImages();
      reason = `Could not determine the changed paths (${error.message}): building every image.`;
    }
  }
  const lines = [`images=${JSON.stringify(result.images)}`, `compose=${result.compose}`];
  console.log(lines.join("\n"));
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join("\n")}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    const table = TARGETS.map((t) => `| ${t} | ${(t === "compose" ? result.compose : result.images.includes(t)) ? "build" : "skip"} |`).join("\n");
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Affected images\n\n| Target | |\n| --- | --- |\n${table}\n\n${reason}\n`);
  }
}

// Not import.meta: the unit tests load this module through a CommonJS transform.
if (process.argv[1]?.endsWith("docker-changes.mjs")) main();
