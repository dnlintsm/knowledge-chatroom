// Runs the storage API conformance suite (packages/contracts/conformance) against
// the Python API server (services/api-py) alone, as `pnpm dev` and compose run it
// since issue #264: resets the test database, starts api-py on it with no
// TypeScript server behind it, waits for storage, runs the suite and stops it.
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

const contractsDir = fileURLToPath(new URL("../packages/contracts/", import.meta.url));
const tsx = (dir) => join(dir, "node_modules/tsx/dist/cli.mjs");

// The suite's first user must become the workspace owner, so start from nothing.
const reset = postgres(process.env.TEST_DATABASE_URL, { onnotice: () => {} });
await reset`DROP SCHEMA public CASCADE`;
await reset`CREATE SCHEMA public`;
await reset.end();

const freePort = () =>
  new Promise((resolve) => {
    const probe = createServer().listen(0, () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
const apiPort = await freePort();
const base = `http://127.0.0.1:${apiPort}`;
const authSecret = randomBytes(32).toString("hex");
// One "+" menu server, for the /tools routes (api-py serves them, issue #190 step 7).
// Nothing listens on port 9, so a call answers 502.
const mcpServers = JSON.stringify({
  conformance: { url: "http://127.0.0.1:9/mcp", forwardIdentity: true, ui: { label: "Conformance", tools: ["search"] } },
});

const servicesDir = fileURLToPath(new URL("../services/", import.meta.url));
const api = spawn("uv", ["run", "--locked", "python", "-m", "api_py.app"], {
  cwd: join(servicesDir, "api-py"),
  env: {
    ...process.env,
    DATABASE_URL: process.env.TEST_DATABASE_URL,
    S3_BUCKET: process.env.S3_BUCKET || "knowledge-conformance",
    AUTH_MODE: "oidc",
    AUTH_SECRET: authSecret,
    // No legacy forwarding: everything the suite calls is served in Python.
    TS_AGENT_URL: "",
    API_PY_PORT: String(apiPort),
    EMBEDDING_MODEL: "off",
    // The suite's owner moderates the skill hub (verify, dismiss reports).
    HUB_ADMINS: "conformance|alice",
    // The workspace inventory's admins (#255): api-py serves /platform alone.
    PLATFORM_ADMINS: "conformance|platform workspaces|platform",
    MCP_SERVERS: mcpServers,
    // api-py serves each user's own notes (step 8); nothing learns in the background.
    MEMORY: "on",
    MEMORY_LEARN: "off",
  },
  stdio: ["ignore", "inherit", "inherit"],
});
let apiExited = false;
api.once("exit", () => { apiExited = true; });
api.once("error", (err) => {
  console.error(`Couldn't start api-py (${err.message}): it needs uv (https://docs.astral.sh/uv/).`);
  apiExited = true;
});

async function waitForStorage() {
  const end = Date.now() + 60_000;
  while (Date.now() < end && !apiExited) {
    // 401 once storage is up; 503 while it starts; no answer before the server listens.
    const status = await fetch(`${base}/nodes`).then((r) => r.status, () => 0);
    if (status === 401) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

let status = 1;
if (await waitForStorage()) {
  // One file after the other, in this order: storage.test.ts's first user must
  // become the owner, and workspaces.test.ts (issue #226) relies on that owner.
  // One run, so CI reads one set of counts, in TAP (scripts/ci-tests.mjs reads
  // its "# tests" lines; Node 26 prints the spec reporter even when piped).
  const files = ["conformance/storage.test.ts", "conformance/workspaces.test.ts"];
  const result = spawnSync(process.execPath, [tsx(contractsDir), "--test", "--test-reporter=tap", "--test-concurrency=1", ...files], {
    cwd: contractsDir,
    env: { ...process.env, STORAGE_URL: base, AUTH_SECRET: authSecret },
    stdio: "inherit",
  });
  if (result.error) console.error(result.error.message);
  status = result.status ?? 1;
} else {
  console.error(apiExited ? "api-py exited before storage was ready." : "Storage didn't start within 60 s.");
}
api.kill("SIGTERM");
process.exit(status);
