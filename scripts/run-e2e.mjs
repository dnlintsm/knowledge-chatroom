import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const [mode = "browser", ...args] = process.argv.slice(2);
if (!["browser", "storage", "login", "live"].includes(mode)) {
  console.error(`Unknown E2E mode: ${mode}`);
  process.exit(1);
}
const cli = fileURLToPath(new URL("../node_modules/@playwright/test/cli.js", import.meta.url));
const result = spawnSync(process.execPath, [cli, "test", ...args], {
  cwd: fileURLToPath(new URL("../", import.meta.url)),
  env: { ...process.env, E2E_MODE: mode },
  stdio: "inherit",
});
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
