// Keeps docs/settings.md in step with the settings the code reads.
//
//   node scripts/settings-check.mjs     # exits 1 and lists what differs
//
// Two rules, per process:
//   1. A setting the code reads from the environment by name is in that process's table.
//   2. A setting in a process's table is named somewhere in that process's code.
// The first catches a new setting nobody documented; the second, a row left behind
// after a setting was removed or renamed.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const REFERENCE = "docs/settings.md";

// A table's heading in the reference, and the code of the process it describes.
export const PROCESSES = [
  { heading: "Web app", kind: "js", sources: ["apps/web/src", "apps/web/next.config.ts", "packages/contracts/src"] },
  { heading: "api-py", kind: "py", sources: ["services/api-py/api_py"] },
  { heading: "agent-py", kind: "py", sources: ["services/agent-py/agent_py"] },
  { heading: "papers-mcp", kind: "py", sources: ["services/papers-mcp/papers_mcp"] },
  { heading: "lab-tools", kind: "py", sources: ["services/lab-tools/lab_tools"] },
];
// Read on behalf of whichever Python process imports it: each of its settings
// must be in at least one Python process's table.
export const SHARED_PYTHON = ["packages/knowledge-py/src"];

// Environment names the code reads that are not this application's settings.
export const NOT_SETTINGS = new Set([
  "NODE_ENV", // set by Node tooling
  "NEXT_RUNTIME", // set by Next.js
  "PATH", // the system's, extended for skill scripts
  "NO_PROXY", // the system's, extended for the model key proxy
]);

const SKIPPED_DIRS = new Set(["node_modules", ".next", "__pycache__", "generated", "tests"]);
const EXTENSIONS = { js: /\.(ts|tsx|mjs|js)$/, py: /\.py$/ };
// How a setting is read by name.
const READS = {
  js: [/process\.env\.([A-Z][A-Z0-9_]+)/g, /\benv\.([A-Z][A-Z0-9_]+)\b/g, /\benv\[["']([A-Z][A-Z0-9_]+)["']\]/g],
  py: [
    /\b(?:env|environ|settings|inherited)(?:\.get\(|\[)\s*"([A-Z][A-Z0-9_]+)"/g,
    /getenv\(\s*"([A-Z][A-Z0-9_]+)"/g,
  ],
};
// Any mention of a name: in a string, or as a JavaScript property.
const MENTIONS = /["'`.]([A-Z][A-Z0-9_]{2,})\b/g;

/** Every file under `path` (a file or a folder) with this kind's extension. */
export function sourceFiles(root, path, kind) {
  const full = join(root, path);
  if (statSync(full).isFile()) return [full];
  const found = [];
  for (const entry of readdirSync(full, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name)) found.push(...sourceFiles(root, join(path, entry.name), kind));
    } else if (EXTENSIONS[kind].test(entry.name)) {
      found.push(join(full, entry.name));
    }
  }
  return found;
}

function matches(text, patterns) {
  const names = new Set();
  for (const pattern of patterns) for (const match of text.matchAll(pattern)) names.add(match[1]);
  return names;
}

/** The settings `sources` read by name, and every capitalised name they mention. */
export function namesInCode(root, sources, kind) {
  const read = new Set();
  const mentioned = new Set();
  for (const source of sources) {
    for (const file of sourceFiles(root, source, kind)) {
      const text = readFileSync(file, "utf8");
      for (const name of matches(text, READS[kind])) if (!NOT_SETTINGS.has(name)) read.add(name);
      for (const name of matches(text, [MENTIONS])) mentioned.add(name);
    }
  }
  return { read, mentioned };
}

/** The settings each `## heading` of the reference lists: the first cell of each table row, in backticks. */
export function documented(markdown) {
  /** @type {Map<string, Set<string>>} */
  const sections = new Map();
  let current = null;
  for (const line of markdown.split(/\r?\n/)) {
    const heading = line.match(/^##\s+(.+?)\s*$/);
    if (heading) {
      current = new Set();
      sections.set(heading[1], current);
      continue;
    }
    const row = line.match(/^\|\s*`([A-Z][A-Z0-9_]+)`\s*\|/);
    if (row && current) current.add(row[1]);
  }
  return sections;
}

/** What differs between the reference and the code, one line each; empty when they agree. */
export function problems(root, markdown = readFileSync(join(root, REFERENCE), "utf8")) {
  const sections = documented(markdown);
  const found = [];
  const pythonDocumented = new Set();
  const shared = namesInCode(root, SHARED_PYTHON, "py");
  for (const { heading, kind, sources } of PROCESSES) {
    const listed = sections.get(heading);
    if (!listed) {
      found.push(`${REFERENCE} has no "## ${heading}" section`);
      continue;
    }
    const code = namesInCode(root, sources, kind);
    if (kind === "py") for (const name of listed) pythonDocumented.add(name);
    for (const name of [...code.read].sort()) {
      if (!listed.has(name)) found.push(`${heading} reads ${name}, which its table in ${REFERENCE} doesn't list`);
    }
    const known = kind === "py" ? new Set([...code.mentioned, ...shared.mentioned]) : code.mentioned;
    for (const name of [...listed].sort()) {
      if (!known.has(name)) found.push(`${REFERENCE} lists ${name} under ${heading}, but that code doesn't name it`);
    }
  }
  for (const name of [...shared.read].sort()) {
    if (!pythonDocumented.has(name)) {
      found.push(`packages/knowledge-py reads ${name}, which no Python process's table in ${REFERENCE} lists`);
    }
  }
  return found;
}

function main() {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const found = problems(root);
  if (!found.length) {
    console.log(`${REFERENCE} matches the settings the code reads.`);
    return;
  }
  console.error(found.join("\n"));
  console.error(`\nUpdate ${REFERENCE} (and .env.example when the setting is one people set).`);
  process.exit(1);
}

// Not import.meta: the unit tests load this module through a CommonJS transform.
if (process.argv[1]?.endsWith("settings-check.mjs")) main();
