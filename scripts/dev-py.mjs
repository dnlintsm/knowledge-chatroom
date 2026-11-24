/**
 * Runs a Python service of services/ for `pnpm dev`, with the repository's
 * .env (variables already set win). Needs uv
 * (https://docs.astral.sh/uv/).
 *
 *   node scripts/dev-py.mjs api-py      # `pnpm dev:api`: the API server on :8000,
 *                                       # serving the API directly
 *   node scripts/dev-py.mjs agent-py    # `pnpm dev:agent-py`: the Python chat agent on :9300
 *
 * `pnpm dev` / `pnpm dev:python` run the UI, api-py and agent-py. No TypeScript
 * agent server is started; AGENT_URL points at agent-py (docs/remote-agent.md).
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

// The Python services refuse to start until AUTH_MODE says whether people sign
// in. In development, a .env that sets no login at all means none.
if (!env.AUTH_MODE && !env.AUTH_SECRET && !env.KNOWLEDGE_PUBLIC_KEY) env.AUTH_MODE = "local";

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
