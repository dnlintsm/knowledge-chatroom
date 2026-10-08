import { defineConfig, devices } from "@playwright/test";

// Mode is explicit: adding credentials must not change required mock coverage.
// Direct `playwright test` defaults to the browser-only mock suite.
const mode = process.env.E2E_MODE ?? "browser";
if (!["browser", "storage", "login", "live"].includes(mode)) {
  throw new Error(`Unknown E2E_MODE: ${mode}`);
}
const useRealAgent = mode === "live";
const withStorage = mode === "storage" || mode === "login" || (useRealAgent && Boolean(process.env.DATABASE_URL));
const withLogin = mode === "login";
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
const OIDC_PORT = port("E2E_OIDC_PORT", 9400);
const baseURL = `http://localhost:${UI_PORT}`;
process.env.AGENT_URL = `http://localhost:${AGENT_PORT}`;
process.env.AGENT_PORT = String(AGENT_PORT);
if (!useRealAgent) {
  process.env.ANTHROPIC_API_KEY = "";
  process.env.CPK_INTELLIGENCE_API_KEY = "";
}
if (!withStorage) process.env.DATABASE_URL = "";
if (!withLogin) process.env.AUTH_SECRET = "";
if (withLogin) {
  // Always use the test provider and a public test signing key, not real login credentials.
  process.env.AUTH_SECRET = "preview-only-secret-0123456789abcdef0123456789";
  process.env.OIDC_ISSUER = `http://localhost:${OIDC_PORT}`;
  process.env.OIDC_CLIENT_ID = "knowledge-chatroom";
  process.env.OIDC_CLIENT_SECRET = "";
  process.env.APP_URL = baseURL;
}

const agentServers = useRealAgent
  ? [{ command: "npm --prefix agent start", url: `http://localhost:${AGENT_PORT}/health` }]
  : [
      ...(withStorage
        ? [
            {
              command: `AGENT_PORT=${STORAGE_PORT} npm --prefix agent start`,
              url: `http://localhost:${STORAGE_PORT}/health`,
            },
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
      ? { testMatch: "knowledge.spec.ts" }
      : { testIgnore: ["login.spec.ts", "knowledge.spec.ts"] }),
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
      command: process.env.CI ? `npx next start -p ${UI_PORT}` : `npm run dev:ui -- --port ${UI_PORT}`,
      url: baseURL,
      reuseExistingServer: false,
      timeout: 180_000,
    },
  ],
});
