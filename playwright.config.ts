import { defineConfig, devices } from "@playwright/test";

/**
 * UI preview run: boots the app, walks the key screens, and saves screenshots
 * (preview/screenshots) plus a video per test (test-results). CI uploads both
 * and links them from a PR comment; see .github/workflows/ui-preview.yml.
 *
 * Without ANTHROPIC_API_KEY the agent is replaced by e2e/mock-agent.mjs, a
 * canned AG-UI server, so the preview never needs a real key.
 */
const useRealAgent = Boolean(process.env.ANTHROPIC_API_KEY);

export default defineConfig({
  testDir: "./e2e",
  timeout: 120_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: "http://localhost:3000",
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
    {
      command: useRealAgent
        ? "npm --prefix agent start"
        : "node e2e/mock-agent.mjs",
      url: "http://localhost:8000/health",
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      // CI builds first and serves the production build; locally, dev mode.
      command: process.env.CI ? "npx next start -p 3000" : "npm run dev:ui",
      url: "http://localhost:3000",
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
    },
  ],
});
