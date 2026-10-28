import { test, expect } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { exampleBlocks, planUpgrade, report } from "../../scripts/env-upgrade-plan.mjs";

const example = `# --- Starter ---

# Your API key (required).
ANTHROPIC_API_KEY=

# This repo's agent server (optional).
# LOCAL_AGENT_URL=http://localhost:8000

# A remote backend for the chat (optional).
# AGENT_URL=http://localhost:9000

# --- Login (optional) ---
# AUTH_MODE=local: no login, one built-in user owns everything.
# AUTH_MODE=oidc
# AUTH_SECRET=              # openssl rand -hex 32
# S3_PUBLIC_URL=http://localhost:8333 # the store as browsers reach it
#                                     # downloads then use signed links
`;

const old = `ANTHROPIC_API_KEY="sk-secret-value"
AGENT_URL=http://localhost:8000
IDENTITY_FORMAT=v1
MY_OWN=1
`;

test("example blocks keep explanations with their settings and skip prose that looks like one", () => {
  const blocks = exampleBlocks(example);
  expect(blocks.map((b) => b.settings.map((s) => s.key))).toEqual([["ANTHROPIC_API_KEY"], ["LOCAL_AGENT_URL"], ["AGENT_URL"], ["AUTH_MODE", "AUTH_SECRET", "S3_PUBLIC_URL"]]);
  expect(blocks[3].comments[0]).toContain("AUTH_MODE=local: no login");
  expect(blocks[3].settings[2].lines).toHaveLength(2);
  expect(blocks[3].section).toBe("# --- Login (optional) ---");
});

test("an old .env gets removals commented out, AGENT_URL renamed and new settings appended commented out", () => {
  const plan = planUpgrade(old, example, { date: "2026-10-28" });
  expect(plan.removed.map((m) => m.key)).toEqual(["IDENTITY_FORMAT"]);
  expect(plan.renamed.map((m) => m.key)).toEqual(["AGENT_URL"]);
  expect(plan.unknown).toEqual(["MY_OWN"]);
  expect(plan.added.map((a) => a.key)).toEqual(["AGENT_URL", "AUTH_MODE", "AUTH_SECRET", "S3_PUBLIC_URL"]);
  const lines = plan.text.split("\n");
  expect(lines.slice(0, 5)).toEqual(['ANTHROPIC_API_KEY="sk-secret-value"', "LOCAL_AGENT_URL=http://localhost:8000", expect.stringMatching(/^# Removed in 0\.2\.1: /), "# IDENTITY_FORMAT=v1", "MY_OWN=1"]);
  expect(lines).toContain("# AGENT_URL=http://localhost:9000");
  expect(lines).toContain("# --- Login (optional) ---");
  expect(lines.filter((l) => /^[A-Z]/.test(l))).toEqual(['ANTHROPIC_API_KEY="sk-secret-value"', "LOCAL_AGENT_URL=http://localhost:8000", "MY_OWN=1"]);
  expect(report(plan)).not.toContain("sk-secret-value");
  const again = planUpgrade(plan.text, example);
  expect(again.changed).toBe(false);
  expect(again.added).toEqual([]);
});

test("AGENT_URL is only renamed in a pre-0.1.2 .env pointing at the agent server's port", () => {
  const remote = planUpgrade("AGENT_URL=https://backend.example.com\n", example);
  expect(remote.renamed).toEqual([]);
  expect(remote.check.map((m) => m.key)).toEqual(["AGENT_URL"]);
  const current = planUpgrade("# LOCAL_AGENT_URL=http://localhost:8000\nAGENT_URL=https://backend.example.com\n", example);
  expect(current.check).toEqual([]);
  const twice = planUpgrade("IDENTITY_FORMAT=v1\nIDENTITY_FORMAT=v2\n", example);
  expect(twice.text.split("\n").filter((l) => l.startsWith("IDENTITY_FORMAT"))).toEqual([]);
  for (const local of ["LOCAL_AGENT_URL=http://localhost:8000", "# LOCAL_AGENT_URL=http://localhost:8000"]) {
    const migrated = planUpgrade(`${local}\nAGENT_URL=http://remote-backend:8000\n`, example);
    expect(migrated.renamed).toEqual([]);
    expect(migrated.text).toContain("\nAGENT_URL=http://remote-backend:8000\n");
  }
});

test("a .env made from the current example is up to date, and CRLF line endings survive", () => {
  expect(report(planUpgrade(example, example))).toBe(".env is up to date with .env.example.");
  const plan = planUpgrade(old.replace(/\n/g, "\r\n"), example);
  expect(plan.text).toContain("LOCAL_AGENT_URL=http://localhost:8000\r\n");
  expect(plan.text.replace(/\r\n/g, "")).not.toContain("\n");
});

test("--write backs up .env first and leaves it alone when nothing changes", () => {
  const directory = mkdtempSync(join(tmpdir(), "env-upgrade-test-"));
  const env = join(directory, ".env"), exampleFile = join(directory, ".env.example");
  const run = (...args: string[]) => spawnSync(process.execPath, [resolve("scripts/env-upgrade.mjs"), "--env", env, "--example", exampleFile, ...args], { encoding: "utf8" });
  try {
    writeFileSync(exampleFile, example);
    expect(run().status).toBe(2);
    writeFileSync(env, old);
    const check = run();
    expect(check.status).toBe(0);
    expect(check.stdout).toContain("npm run env:upgrade");
    expect(check.stdout).not.toContain("sk-secret-value");
    expect(readFileSync(env, "utf8")).toBe(old);
    expect(run("--write").status).toBe(0);
    const backups = readdirSync(directory).filter((f) => f.startsWith(".env.backup-"));
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(directory, backups[0]), "utf8")).toBe(old);
    expect(readFileSync(env, "utf8")).toContain("LOCAL_AGENT_URL=http://localhost:8000");
    run("--write");
    expect(readdirSync(directory).filter((f) => f.startsWith(".env.backup-"))).toHaveLength(1);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
