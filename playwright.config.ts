import { defineConfig, devices } from "@playwright/test";

// Mode is explicit: adding credentials must not change required mock coverage.
// Direct `playwright test` defaults to the browser-only mock suite. "python"
// sends the chat to services/agent-py (AGENT_URL) running a real Claude Code
// engine against a scripted model (e2e/mock-anthropic.mjs); it needs uv.
const mode = process.env.E2E_MODE ?? "browser";
if (!["browser", "storage", "login", "live", "python"].includes(mode)) {
  throw new Error(`Unknown E2E_MODE: ${mode}`);
}
const useRealAgent = mode === "live";
const withStorage = mode === "storage" || mode === "login" || (useRealAgent && Boolean(process.env.DATABASE_URL));
const withLogin = mode === "login";
const withPython = mode === "python";
if (useRealAgent && !process.env.ANTHROPIC_API_KEY) {
  throw new Error("Live smoke tests require ANTHROPIC_API_KEY.");
}
if (withStorage && (!process.env.DATABASE_URL || !process.env.S3_ENDPOINT)) {
  throw new Error(`${mode} E2E requires DATABASE_URL and S3_ENDPOINT for a disposable test workspace.`);
}

function port(name: string, fallback: number) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error(`Invalid ${name}`);
  return value;
}
const UI_PORT = port("E2E_UI_PORT", 3000);
const AGENT_PORT = port("E2E_AGENT_PORT", 8000);
const STORAGE_PORT = port("E2E_STORAGE_PORT", 8001);
// The TypeScript agent server behind api-py (services/api-py, issue #190), which
// serves storage at STORAGE_PORT; E2E_API_PY=off serves it from TypeScript alone.
const TS_STORAGE_PORT = port("E2E_TS_STORAGE_PORT", 8002);
const withApiPy = process.env.E2E_API_PY !== "off";
const OIDC_PORT = port("E2E_OIDC_PORT", 9400);
const PY_AGENT_PORT = port("E2E_PY_AGENT_PORT", 9300);
const MODEL_PORT = port("E2E_MODEL_PORT", 9500);
const baseURL = `http://localhost:${UI_PORT}`;
process.env.LOCAL_AGENT_URL = `http://localhost:${AGENT_PORT}`;
// The chat goes to this repo's agent (or the mock), or in "python" mode to
// services/agent-py; never a remote backend from the environment.
process.env.AGENT_URL = withPython ? `http://localhost:${PY_AGENT_PORT}` : "";
process.env.AGENT_PORT = String(AGENT_PORT);
if (!useRealAgent) {
  process.env.ANTHROPIC_API_KEY = "";
  process.env.CPK_INTELLIGENCE_API_KEY = "";
}
if (!withStorage) process.env.DATABASE_URL = "";
// CI serves a production build, which needs the login mode spelled out.
process.env.AUTH_MODE = withLogin ? "oidc" : "local";
if (!withLogin) process.env.AUTH_SECRET = "";
if (withLogin) {
  // Always use the test provider and a public test signing key, not real login credentials.
  process.env.AUTH_SECRET = "preview-only-secret-0123456789abcdef0123456789";
  process.env.OIDC_ISSUER = `http://localhost:${OIDC_PORT}`;
  process.env.OIDC_CLIENT_ID = "knowledge-chatroom";
  process.env.OIDC_CLIENT_SECRET = "";
  process.env.APP_URL = baseURL;
}

// The Python chat agent with a real Claude Code engine and a scripted model;
// skills, follow-up chips and the "+" menu come from the mock agent server.
const pythonAgent = [
  "ANTHROPIC_API_KEY=mock-key",
  `ANTHROPIC_BASE_URL=http://localhost:${MODEL_PORT}`,
  "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1",
  "CLAUDE_MODEL= ANTHROPIC_MODEL= KNOWLEDGE_PUBLIC_KEY= MCP_SERVERS=",
  `LOCAL_AGENT_URL=http://localhost:${AGENT_PORT}`,
  `AGENT_PY_PORT=${PY_AGENT_PORT}`,
].join(" ");

const agentServers = useRealAgent
  ? [{ command: "pnpm -C apps/agent start", url: `http://localhost:${AGENT_PORT}/health` }]
  : withPython
    ? [
        { command: "node e2e/mock-agent.mjs", url: `http://localhost:${AGENT_PORT}/health` },
        { command: `MOCK_MODEL_PORT=${MODEL_PORT} node e2e/mock-anthropic.mjs`, url: `http://localhost:${MODEL_PORT}/health` },
        {
          command: `cd services/agent-py && ${pythonAgent} uv run --locked python -m agent_py.app`,
          url: `http://localhost:${PY_AGENT_PORT}/health`,
        },
      ]
    : [
      ...(withStorage
        ? [
            {
              // Scripts on only shows them as runnable, and memory only shows its API:
              // chat goes to the mock agent.
              // Behind api-py, which then runs the search indexer.
              command: `AGENT_PORT=${withApiPy ? `${TS_STORAGE_PORT} SEARCH_INDEXER=off MEMORY_LEARN=off` : STORAGE_PORT} SKILL_SCRIPTS=on MEMORY=on pnpm -C apps/agent start`,
              url: `http://localhost:${withApiPy ? TS_STORAGE_PORT : STORAGE_PORT}/health`,
            },
            ...(withApiPy
              ? [
                  {
                    // In front of it, as in `pnpm dev` and compose: the routes moved to Python so far.
                    command: `cd services/api-py && TS_AGENT_URL=http://localhost:${TS_STORAGE_PORT} API_PY_PORT=${STORAGE_PORT} SKILL_SCRIPTS=on MEMORY=on uv run --locked python -m api_py.app`,
                    url: `http://localhost:${STORAGE_PORT}/health`,
                  },
                ]
              : []),
          ]
        : []),
      {
        command: withStorage
          ? `STORAGE_URL=http://localhost:${STORAGE_PORT} node e2e/mock-agent.mjs`
          : "node e2e/mock-agent.mjs",
        url: `http://localhost:${AGENT_PORT}/health`,
      },
    ];

export default defineConfig({
  testDir: "./e2e",
  ...(withLogin
    ? { testMatch: "login.spec.ts" }
    : mode === "storage"
      ? { testMatch: ["knowledge.spec.ts", "runs.spec.ts", "sync-storage.spec.ts", "chat-history.spec.ts"] }
      : withPython
        ? { testMatch: "python-agent.spec.ts" }
        : {
            testIgnore: [
              "login.spec.ts",
              "knowledge.spec.ts",
              "runs.spec.ts",
              "sync-storage.spec.ts",
              "chat-history.spec.ts",
              "python-agent.spec.ts",
            ],
          }),
  timeout: 120_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL,
    viewport: { width: 1440, height: 900 },
    video: { mode: "on", size: { width: 1440, height: 900 } },
    trace: "retain-on-failure",
    colorScheme: "light",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 900 },
        // Lets a machine with a pre-installed Chromium skip `playwright install`.
        launchOptions: process.env.PLAYWRIGHT_CHROMIUM_PATH
          ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH }
          : {},
      },
    },
  ],
  webServer: [
    ...(withLogin
      ? [{ command: `OIDC_PORT=${OIDC_PORT} node e2e/mock-oidc.mjs`, url: `http://localhost:${OIDC_PORT}/health` }]
      : []),
    ...agentServers.map((server) => ({
      ...server,
      reuseExistingServer: false,
      timeout: 60_000,
    })),
    {
      // CI builds first and serves the production build; locally, dev mode.
      command: process.env.CI ? `pnpm -C apps/web exec next start -p ${UI_PORT}` : `pnpm -C apps/web dev --port ${UI_PORT}`,
      url: baseURL,
      reuseExistingServer: false,
      timeout: 180_000,
    },
  ],
});
