// Compares an existing .env with .env.example after an upgrade: settings that were
// removed or renamed, new ones, and ones .env.example doesn't know. --write applies
// it: only removed and renamed settings change; new ones are appended commented
// out. Values are never printed, only names. The command is env-upgrade.mjs.

// One row per setting a release removed or renamed; newest last.
export const MIGRATIONS = [
  { key: "AGENT_URL", since: "0.1.2", renamed: "LOCAL_AGENT_URL", when: (value) => /:8000\/?$/.test(value),
    note: "AGENT_URL now names a remote chat backend; this repo's agent server is LOCAL_AGENT_URL" },
  { key: "RUN_DIR_MARKERS", since: "0.1.2", note: "runs are experiments now; run folder markers are gone" },
  { key: "IDENTITY_FORMAT", since: "0.2.1", note: "identity tokens are only v2; the agent refuses to start while it is set" },
];

const ACTIVE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;
// A commented-out setting has one word as its value, maybe with a # remark after
// it; "# AUTH_MODE=local: no login, ..." is explanation.
const COMMENTED = /^\s*#\s*([A-Z][A-Z0-9_]*)=\S*\s*(?:#.*)?$/;
const SECTION = /^#\s*---.*---\s*$/;
const CONTINUATION = /^#\s{2,}#/;

function value(raw) {
  const v = raw.trim();
  const quoted = v.match(/^(["'])(.*)\1/);
  return quoted ? quoted[2] : v.replace(/\s+#.*$/, "");
}

// .env.example as blocks: an optional section, explanation lines, then settings.
/** @returns {{ section: string | null, comments: string[], settings: { key: string, lines: string[] }[] }[]} */
export function exampleBlocks(text) {
  /** @type {ReturnType<typeof exampleBlocks>} */
  const blocks = [];
  let section = null, block = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) { block = null; continue; }
    if (SECTION.test(line)) { section = line; block = null; continue; }
    const key = (line.match(ACTIVE) ?? line.match(COMMENTED))?.[1];
    if (key) {
      if (!block) blocks.push(block = { section, comments: [], settings: [] });
      block.settings.push({ key, lines: [line] });
    } else if (block?.settings.length && CONTINUATION.test(line)) {
      block.settings.at(-1).lines.push(line);
    } else {
      if (!block || block.settings.length) blocks.push(block = { section, comments: [], settings: [] });
      block.comments.push(line);
    }
  }
  return blocks;
}

/**
 * @typedef {{ key: string, since: string, note: string, renamed?: string }} Migration
 * @typedef {{ removed: Migration[], renamed: Migration[], check: Migration[],
 *   added: { key: string, section: string | null }[], unknown: string[], text: string, changed: boolean }} Plan
 * @returns {Plan}
 */
export function planUpgrade(envText, exampleText, { date = new Date().toISOString().slice(0, 10) } = {}) {
  const eol = envText.includes("\r\n") ? "\r\n" : "\n";
  const lines = envText.split(/\r?\n/);
  const active = new Map(), mentioned = new Set();
  lines.forEach((line, index) => {
    const set = line.match(ACTIVE);
    if (set) {
      active.set(set[1], { indexes: [...(active.get(set[1])?.indexes ?? []), index], value: value(set[2]) });
      mentioned.add(set[1]);
    }
    const commented = line.match(COMMENTED);
    if (commented) mentioned.add(commented[1]);
  });

  const blocks = exampleBlocks(exampleText);
  const known = new Set(blocks.flatMap((b) => b.settings.map((s) => s.key)));
  /** @type {Plan} */
  const plan = { removed: [], renamed: [], check: [], added: [], unknown: [], text: "", changed: false };
  const replace = new Map();
  const commentOut = (key, why) => {
    for (const index of active.get(key).indexes) replace.set(index, [`# ${why}:`, `# ${lines[index].trimStart()}`]);
  };

  for (const m of MIGRATIONS) {
    const current = active.get(m.key);
    if (!current) continue;
    if (!m.renamed) {
      plan.removed.push(m);
      commentOut(m.key, `Removed in ${m.since}: ${m.note}`);
    } else if (m.when(current.value)) {
      plan.renamed.push(m);
      if (active.has(m.renamed)) commentOut(m.key, `Replaced by ${m.renamed} in ${m.since}`);
      else for (const index of current.indexes) replace.set(index, [lines[index].replace(m.key, m.renamed)]);
      mentioned.add(m.renamed);
      mentioned.delete(m.key); // the old name has a new meaning, offered below like any new setting
    } else if (!mentioned.has(m.renamed)) {
      plan.check.push(m);
    }
  }

  const migrated = new Set(MIGRATIONS.map((m) => m.key));
  plan.unknown = [...active.keys()].filter((key) => !known.has(key) && !migrated.has(key));

  const appended = [];
  let lastSection = null;
  for (const block of blocks) {
    const fresh = block.settings.filter((s) => !mentioned.has(s.key));
    if (!fresh.length) continue;
    for (const s of fresh) mentioned.add(s.key);
    plan.added.push(...fresh.map((s) => ({ key: s.key, section: block.section })));
    appended.push("");
    if (block.section && block.section !== lastSection) appended.push(block.section, "");
    lastSection = block.section;
    appended.push(...block.comments, ...fresh.flatMap((s) => s.lines.map((l) => (l.startsWith("#") ? l : `# ${l}`))));
  }

  const out = lines.flatMap((line, index) => replace.get(index) ?? [line]);
  if (appended.length) {
    while (out.length && !out.at(-1).trim()) out.pop();
    out.push("", `# ==== New in .env.example, added by npm run env:upgrade (${date}). ====`,
      "# All commented out: nothing changes until you uncomment a setting.", ...appended, "");
  }
  plan.text = out.join(eol);
  plan.changed = plan.text !== envText;
  return plan;
}

export function report(plan, { envPath = ".env", write = false } = {}) {
  const out = [];
  const list = (title, rows) => { if (rows.length) out.push("", title, ...rows.map((r) => `  ${r}`)); };
  list(write ? "Commented out (removed settings):" : "Removed, comment these out:",
    plan.removed.map((m) => `${m.key}  (removed in ${m.since}: ${m.note})`));
  list(write ? "Renamed:" : "Rename:", plan.renamed.map((m) => `${m.key} -> ${m.renamed}  (${m.since}: ${m.note})`));
  list("Check by hand:", plan.check.map((m) =>
    `${m.key}  (${m.since}: ${m.note}. If it points at this repo's agent server, rename it to ${m.renamed}.)`));
  const bySection = new Map();
  for (const { key, section } of plan.added) {
    const name = section?.replace(/^#\s*---\s*|\s*---\s*$/g, "") ?? "General";
    bySection.set(name, [...(bySection.get(name) ?? []), key]);
  }
  list(write ? `New in .env.example, appended to ${envPath} commented out:` : `New in .env.example, not in ${envPath}:`,
    [...bySection].map(([name, keys]) => `${name}: ${keys.join(", ")}`));
  list("Set in your .env but not in .env.example (yours, or no longer used):", plan.unknown);
  if (!plan.changed && !plan.check.length && !plan.unknown.length) return `${envPath} is up to date with .env.example.`;
  if (!write && plan.changed) out.push("", `Run \`npm run env:upgrade\` to apply this (${envPath} is backed up first).`);
  return out.join("\n").trimStart();
}
