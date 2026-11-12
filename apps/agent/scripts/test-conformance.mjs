// Runs the storage API conformance suite (packages/contracts/conformance) against
// this agent: resets the test database, starts the agent on it with the Python
// API server (services/api-py, issue #190) in front, as `pnpm dev` and compose
// run them, waits for storage, runs the suite through api-py, and stops both.
// CONFORMANCE_TARGET=ts runs it against the TypeScript server alone.
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

const target = process.env.CONFORMANCE_TARGET || "api-py";
if (!["api-py", "ts"].includes(target)) {
  console.error(`CONFORMANCE_TARGET must be "api-py" or "ts", not "${target}".`);
  process.exit(1);
}

const freePort = () =>
  new Promise((resolve) => {
    const probe = createServer().listen(0, () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
const port = await freePort();
const apiPort = target === "api-py" ? await freePort() : null;
const base = `http://127.0.0.1:${apiPort ?? port}`;
const authSecret = randomBytes(32).toString("hex");

const agent = spawn(process.execPath, [tsx(agentDir), "src/server.ts"], {
  cwd: agentDir,
  env: {
    ...process.env,
    DATABASE_URL: process.env.TEST_DATABASE_URL,
    S3_BUCKET: process.env.S3_BUCKET || "knowledge-conformance",
    // Signed-in users, whatever AUTH_MODE the shell or the repository .env sets.
    AUTH_MODE: "oidc",
    AUTH_SECRET: authSecret,
    // The suite's owner moderates the skill hub (verify, dismiss reports).
    HUB_ADMINS: "conformance|alice",
    // Memory routes answer 404 unless memory is on; nothing learns in the background.
    MEMORY: "on",
    MEMORY_LEARN: "off",
    AGENT_PORT: String(port),
    // Full-text search is enough here; search by meaning has its own tests.
    EMBEDDING_MODEL: "off",
    // api-py in front runs the search indexer (issue #190, step 5).
    ...(apiPort && { SEARCH_INDEXER: "off" }),
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || "conformance-no-model-calls",
  },
  stdio: ["ignore", "inherit", "inherit"],
});
let agentExited = false;
agent.once("exit", () => { agentExited = true; });

const servicesDir = fileURLToPath(new URL("../../../services/", import.meta.url));
const api = apiPort
  ? spawn("uv", ["run", "--locked", "python", "-m", "api_py.app"], {
      cwd: join(servicesDir, "api-py"),
      env: {
        ...process.env,
        DATABASE_URL: process.env.TEST_DATABASE_URL,
        S3_BUCKET: process.env.S3_BUCKET || "knowledge-conformance",
        AUTH_MODE: "oidc",
        AUTH_SECRET: authSecret,
        TS_AGENT_URL: `http://127.0.0.1:${port}`,
        API_PY_PORT: String(apiPort),
        EMBEDDING_MODEL: "off",
        // The same hub admins as the agent: api-py serves the skill hub (step 7).
        HUB_ADMINS: "conformance|alice",
      },
      stdio: ["ignore", "inherit", "inherit"],
    })
  : null;
api?.once("exit", () => { agentExited = true; });
api?.once("error", (err) => {
  console.error(`Couldn't start api-py (${err.message}): it needs uv (https://docs.astral.sh/uv/).`);
  agentExited = true;
});

async function waitForStorage() {
  const end = Date.now() + 60_000;
  while (Date.now() < end && !agentExited) {
    // 401 once storage is up; 503 while it starts (502 from api-py before the
    // agent listens); no answer before the server listens.
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
  console.error(agentExited ? "The agent or api-py exited before storage was ready." : "Storage didn't start within 60 s.");
}
api?.kill("SIGTERM");
agent.kill("SIGTERM");
process.exit(status);
