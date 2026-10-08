import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const missing = ["TEST_DATABASE_URL", "S3_ENDPOINT"].filter((name) => !process.env[name]);
if (missing.length) {
  console.error(`Storage integration tests require: ${missing.join(", ")}.`);
  console.error("Use a disposable test database: this suite resets its public schema.");
  process.exit(1);
}

const root = fileURLToPath(new URL("../", import.meta.url));
const cli = fileURLToPath(new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url));
const result = spawnSync(process.execPath, [cli, "--test", "src/storage/storage.test.ts"], {
  cwd: root,
  stdio: "inherit",
});
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
