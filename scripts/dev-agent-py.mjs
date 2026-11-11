/**
 * `pnpm dev:agent-py`: the Python chat agent (services/agent-py) on
 * http://127.0.0.1:9300, with the repository's .env as `pnpm dev:agent` reads
 * it (variables already set win). Needs uv (https://docs.astral.sh/uv/).
 *
 * `pnpm dev:python` runs it beside the app and the agent server, with the
 * app's AGENT_URL pointing at it (docs/remote-agent.md).
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

const root = new URL("../", import.meta.url);
const env = { ...process.env };
const file = fileURLToPath(new URL(".env", root));
if (existsSync(file)) {
  for (const [name, value] of Object.entries(parseEnv(readFileSync(file, "utf8")))) {
    if (env[name] === undefined) env[name] = value;
  }
}

const child = spawn("uv", ["run", "python", "-m", "agent_py.app"], {
  cwd: fileURLToPath(new URL("services/agent-py/", root)),
  env,
  stdio: "inherit",
});
child.on("error", (err) => {
  console.error(`[agent-py] couldn't start uv (${err.message}); install it from https://docs.astral.sh/uv/`);
  process.exit(1);
});
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
