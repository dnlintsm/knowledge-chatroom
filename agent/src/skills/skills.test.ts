import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  builtinSkills,
  effectiveMode,
  parseFrontMatter,
  skillFromFiles,
  workspaceSkills,
  mergeSkills,
  type Skill,
} from "./catalog";
import { guardSlashCommand, materialize, skillOptions, type SkillUse } from "./run";
import { InvalidModeError, SkillService, UnknownSkillError } from "./service";

const enc = (text: string) => new TextEncoder().encode(text);
const skillMd = (front: string, body = "Steps.") => enc(`---\n${front}\n---\n\n${body}\n`);

test("front matter: plain and quoted values, keys lowercased", () => {
  assert.deepEqual(
    parseFrontMatter('---\nname: pdf\nDescription: "Fill forms: fast"\nargument-hint: \'[file]\'\n---\nbody'),
    { name: "pdf", description: "Fill forms: fast", "argument-hint": "[file]" },
  );
  assert.deepEqual(parseFrontMatter("# no front matter"), {});
});

test("a skill takes its name from the front matter, else its folder", () => {
  const named = skillFromFiles("folder", [{ path: "SKILL.md", bytes: skillMd("name: real-name\ndescription: d") }], "workspace", null);
  assert.equal(named?.name, "real-name");
  const unnamed = skillFromFiles("my-folder", [{ path: "SKILL.md", bytes: enc("# Title\n\nDo it.") }], "workspace", null);
  assert.equal(unnamed?.name, "my-folder");
  assert.equal(unnamed?.description, "Title");
  // No SKILL.md, or no usable name: not a skill.
  assert.equal(skillFromFiles("x", [{ path: "notes.md", bytes: enc("x") }], "workspace", null), null);
  assert.equal(skillFromFiles("Bad Name", [{ path: "SKILL.md", bytes: enc("x") }], "workspace", null), null);
});

test("invocation flags and scripts", () => {
  const skill = skillFromFiles(
    "s",
    [
      { path: "SKILL.md", bytes: skillMd("name: s\ndisable-model-invocation: true\nuser-invocable: false") },
      { path: "scripts/run.py", bytes: enc("print(1)") },
    ],
    "workspace",
    null,
  )!;
  assert.equal(skill.modelInvocable, false);
  assert.equal(skill.userInvocable, false);
  assert.equal(skill.needsExecution, true);
});

test("workspace skills come from skills/<folder>/ and replace built-ins of the same name", () => {
  const ws = workspaceSkills([
    { path: "skills/tldr/SKILL.md", bytes: skillMd("name: tldr\ndescription: mine") },
    { path: "skills/tldr/reference/style.md", bytes: enc("style") },
    { path: "skills/other/README.md", bytes: enc("no SKILL.md") },
    { path: "notes/skills.md", bytes: enc("not a skill") },
  ]);
  assert.deepEqual(ws.map((s) => [s.name, s.path, s.files.map((f) => f.path)]), [
    ["tldr", "skills/tldr/SKILL.md", ["SKILL.md", "reference/style.md"]],
  ]);
  const merged = mergeSkills(builtinSkills(), ws);
  assert.equal(merged.find((s) => s.name === "tldr")?.source, "workspace");
  assert.ok(merged.some((s) => s.name === "write-skill" && s.source === "builtin"));
});

test("modes: a skill Claude may not invoke is never auto; one without /name is never manual", () => {
  const base = builtinSkills().find((s) => s.name === "tldr")!;
  assert.equal(effectiveMode(base, undefined), "auto");
  assert.equal(effectiveMode(base, "manual"), "manual");
  const manualOnly = { ...base, modelInvocable: false };
  assert.equal(effectiveMode(manualOnly, undefined), "manual");
  assert.equal(effectiveMode(manualOnly, "auto"), "manual");
  assert.equal(effectiveMode({ ...base, userInvocable: false }, "manual"), "off");
});

test("the built-in skills load", () => {
  const names = builtinSkills().map((s) => s.name);
  assert.deepEqual(names, ["tldr", "write-skill"]);
  assert.equal(builtinSkills().find((s) => s.name === "write-skill")?.modelInvocable, false);
});

test("without storage: built-in skills, modes kept in memory", async () => {
  const service = new SkillService(() => null);
  const before = await service.list(null);
  assert.equal(before.find((s) => s.name === "tldr")?.mode, "auto");
  const updated = await service.setMode(null, "tldr", "off");
  assert.equal(updated.mode, "off");
  assert.equal((await service.list(null)).find((s) => s.name === "tldr")?.mode, "off");
  assert.ok(!(await service.forRun(null)).some((s) => s.skill.name === "tldr"));
  await assert.rejects(service.setMode(null, "tldr", "sometimes"), InvalidModeError);
  await assert.rejects(service.setMode(null, "nope", "auto"), UnknownSkillError);
});

const userSkill = (name: string, mode: "auto" | "manual", extra: Partial<Skill> = {}) => ({
  skill: {
    ...skillFromFiles(name, [{ path: "SKILL.md", bytes: skillMd(`name: ${name}\ndescription: ${name}`) }], "builtin", null)!,
    ...extra,
  },
  mode,
});

test("materialize writes the run's skills once per set, in a folder per user", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skills-test-"));
  const a = await materialize("alice", [userSkill("one", "auto"), userSkill("two", "manual")], root);
  const dir = path.join(a.cwd, ".claude", "skills");
  assert.deepEqual((await readdir(dir)).sort(), [".fingerprint", "one", "two"]);
  assert.match(await readFile(path.join(dir, "one", "SKILL.md"), "utf8"), /name: one/);

  // Same set: left as is. A changed set replaces the folder's contents.
  await writeFile(path.join(dir, "one", "marker"), "x");
  await materialize("alice", [userSkill("one", "auto"), userSkill("two", "manual")], root);
  assert.ok((await readdir(path.join(dir, "one"))).includes("marker"));
  const b = await materialize("alice", [userSkill("one", "auto")], root);
  assert.equal(b.cwd, a.cwd);
  assert.deepEqual((await readdir(dir)).sort(), [".fingerprint", "one"]);

  const bob = await materialize("bob", [], root);
  assert.notEqual(bob.cwd, a.cwd);
});

test("runs starting together for one user all get their skills", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skills-test-"));
  const sets = [[userSkill("one", "auto")], [userSkill("two", "auto")], [userSkill("one", "auto")]];
  const runs = await Promise.all(sets.map((set) => materialize("carol", set, root)));
  assert.equal(new Set(runs.map((r) => r.cwd)).size, 1);
  // The last one written wins, and each run returned without an error.
  assert.deepEqual((await readdir(path.join(runs[0].cwd, ".claude", "skills"))).sort(), [".fingerprint", "one"]);
});

test("skill options: modes become SDK overrides, uses are reported", async () => {
  const run = { cwd: "/tmp/x", skills: [userSkill("one", "auto"), userSkill("two", "manual")] };
  const uses: SkillUse[] = [];
  const options = skillOptions(run, (use) => uses.push(use));
  assert.equal(options.cwd, "/tmp/x");
  assert.deepEqual(options.settingSources, ["project"]);
  assert.deepEqual(options.skills, ["one", "two"]);
  const settings = options.settings as { skillOverrides: Record<string, string>; disableSkillShellExecution: boolean };
  assert.deepEqual(settings.skillOverrides, { one: "on", two: "user-invocable-only" });
  assert.equal(settings.disableSkillShellExecution, true);

  const call = (event: "PreToolUse" | "UserPromptExpansion", input: object) =>
    options.hooks![event]![0].hooks[0](input as never, undefined, { signal: new AbortController().signal });
  await call("PreToolUse", { tool_input: { skill: "one" } });
  await call("UserPromptExpansion", { command_name: "two" });
  await call("UserPromptExpansion", { command_name: "compact" }); // not one of ours
  assert.deepEqual(uses, [
    { skill: "one", source: "builtin", trigger: "model" },
    { skill: "two", source: "builtin", trigger: "slash" },
  ]);
});

test("slash commands: only the run's own skills", () => {
  const run = { cwd: "/tmp/x", skills: [userSkill("tldr", "auto"), userSkill("hidden", "auto", { userInvocable: false })] };
  assert.equal(guardSlashCommand("/tldr focus on cost", run), "/tldr focus on cost");
  assert.equal(guardSlashCommand("/clear", run), " /clear");
  assert.equal(guardSlashCommand("/hidden", run), " /hidden");
  assert.equal(guardSlashCommand("/tldr", null), " /tldr");
  assert.equal(guardSlashCommand("hello /tldr", run), "hello /tldr");
  assert.equal(guardSlashCommand("/usr/bin is a path", run), " /usr/bin is a path");
});
