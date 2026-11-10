// Runs the storage API conformance suite (packages/contracts/conformance) against
// this agent: resets the test database, starts the agent on it, waits for storage,
// runs the suite, and stops the agent.
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import postgres from "postgres";

const missing = ["TEST_DATABASE_URL", "S3_ENDPOINT"].filter((name) => !process.env[name]);
if (missing.length) {
  console.error(`Storage conformance tests require: ${missing.join(", ")}.`);
  console.error("Use a disposable test database: this suite resets its public schema.");
  process.exit(1);
}

const agentDir = fileURLToPath(new URL("../", import.meta.url));
const contractsDir = fileURLToPath(new URL("../../../packages/contracts/", import.meta.url));
const tsx = (dir) => join(dir, "node_modules/tsx/dist/cli.mjs");

// The suite's first user must become the workspace owner, so start from nothing.
const reset = postgres(process.env.TEST_DATABASE_URL, { onnotice: () => {} });
await reset`DROP SCHEMA public CASCADE`;
await reset`CREATE SCHEMA public`;
await reset.end();

const port = await new Promise((resolve) => {
  const probe = createServer().listen(0, () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});
const base = `http://127.0.0.1:${port}`;
const authSecret = randomBytes(32).toString("hex");

const agent = spawn(process.execPath, [tsx(agentDir), "src/server.ts"], {
  cwd: agentDir,
  env: {
    ...process.env,
    DATABASE_URL: process.env.TEST_DATABASE_URL,
    S3_BUCKET: process.env.S3_BUCKET || "knowledge-conformance",
    AUTH_SECRET: authSecret,
    AGENT_PORT: String(port),
    // Full-text search is enough here; search by meaning has its own tests.
    EMBEDDING_MODEL: "off",
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || "conformance-no-model-calls",
  },
  stdio: ["ignore", "inherit", "inherit"],
});
let agentExited = false;
agent.once("exit", () => { agentExited = true; });

async function waitForStorage() {
  const end = Date.now() + 60_000;
  while (Date.now() < end && !agentExited) {
    // 401 once storage is up; 503 while it starts; no answer before the server listens.
    const status = await fetch(`${base}/nodes`).then((r) => r.status, () => 0);
    if (status === 401) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

let status = 1;
if (await waitForStorage()) {
  const result = spawnSync(process.execPath, [tsx(contractsDir), "--test", "conformance/storage.test.ts"], {
    cwd: contractsDir,
    env: { ...process.env, STORAGE_URL: base, AUTH_SECRET: authSecret },
    stdio: "inherit",
  });
  if (result.error) console.error(result.error.message);
  status = result.status ?? 1;
} else {
  console.error(agentExited ? "The agent exited before storage was ready." : "Storage didn't start within 60 s.");
}
agent.kill("SIGTERM");
process.exit(status);
