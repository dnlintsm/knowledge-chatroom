/**
 * Runs a Python service of services/ for `pnpm dev`, with the repository's
 * .env as `pnpm dev:agent` reads it (variables already set win). Needs uv
 * (https://docs.astral.sh/uv/).
 *
 *   node scripts/dev-py.mjs api-py      # `pnpm dev:api`: the API server on :8000,
 *                                       # in front of the agent server on :8100
 *   node scripts/dev-py.mjs agent-py    # `pnpm dev:agent-py`: the Python chat agent on :9300
 *
 * `pnpm dev` runs api-py beside the app and the agent server; `pnpm dev:python`
 * adds agent-py, with the app's AGENT_URL pointing at it (docs/remote-agent.md).
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

const SERVICES = { "api-py": "api_py.app", "agent-py": "agent_py.app" };
const name = process.argv[2];
if (!SERVICES[name]) {
  console.error(`usage: node scripts/dev-py.mjs ${Object.keys(SERVICES).join("|")}`);
  process.exit(2);
}

const root = new URL("../", import.meta.url);
const env = { ...process.env };
const file = fileURLToPath(new URL(".env", root));
if (existsSync(file)) {
  for (const [key, value] of Object.entries(parseEnv(readFileSync(file, "utf8")))) {
    if (env[key] === undefined) env[key] = value;
  }
}

const child = spawn("uv", ["run", "python", "-m", SERVICES[name]], {
  cwd: fileURLToPath(new URL(`services/${name}/`, root)),
  env,
  stdio: "inherit",
});
child.on("error", (err) => {
  console.error(`[${name}] couldn't start uv (${err.message}); install it from https://docs.astral.sh/uv/`);
  process.exit(1);
});
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
