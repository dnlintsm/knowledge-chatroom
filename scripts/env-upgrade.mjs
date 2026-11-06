#!/usr/bin/env node
// npm run env:check / env:upgrade: compares .env with .env.example (see
// env-upgrade-plan.mjs). --write backs up .env and applies the plan.
// Options: --env <path> (default .env), --example <path> (default .env.example).
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { planUpgrade, report } from "./env-upgrade-plan.mjs";

const argv = process.argv.slice(2);
const arg = (name, fallback) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : fallback; };
const envPath = arg("--env", ".env"), examplePath = arg("--example", ".env.example");
const write = argv.includes("--write");

if (!existsSync(examplePath)) {
  console.error(`${examplePath} not found.`);
  process.exit(2);
}
if (!existsSync(envPath)) {
  console.error(`${envPath} not found. Start from the example: cp ${examplePath} ${envPath}`);
  process.exit(2);
}
const plan = planUpgrade(readFileSync(envPath, "utf8"), readFileSync(examplePath, "utf8"));
if (write && plan.changed) {
  const backup = `${envPath}.backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  copyFileSync(envPath, backup);
  writeFileSync(envPath, plan.text);
  console.log(`Backed up ${envPath} to ${backup}.\n`);
}
console.log(report(plan, { envPath, write }));
