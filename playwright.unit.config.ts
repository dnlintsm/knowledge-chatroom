import { defineConfig } from "@playwright/test";

// Pure logic tests: deliberately no webServer or browser fixtures.
export default defineConfig({
  testDir: "./tests/unit",
  workers: 1,
  reporter: "list",
});
