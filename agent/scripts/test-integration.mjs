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
// One file at a time: each resets the test database. The real embedding model
// downloads about 120 MB, so it's checked only on request.
const files = ["src/storage/storage.test.ts", "src/storage/memory.test.ts", "src/storage/shared-memory.test.ts", "src/storage/memory-packs.test.ts", "src/storage/memory-agent.test.ts", "src/storage/memory-recall.test.ts"];
if (process.env.EMBEDDING_TEST) files.push("src/storage/embeddings.test.ts");
const result = spawnSync(process.execPath, [cli, "--test", "--test-concurrency=1", ...files], {
  cwd: root,
  stdio: "inherit",
});
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
