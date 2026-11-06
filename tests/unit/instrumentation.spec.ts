import { test, expect } from "@playwright/test";
import { register } from "../../src/instrumentation";

test.describe("instrumentation register", () => {
  const originalEnv = { ...process.env };

  test.beforeEach(() => {
    process.env = { ...originalEnv };
  });

  test.afterEach(() => {
    process.env = { ...originalEnv };
  });

  test("skips check when NEXT_RUNTIME is not nodejs", async () => {
    process.env.NEXT_RUNTIME = "edge";
    process.env.AUTH_MODE = "oidc";
    process.env.AUTH_SECRET = "0123456789abcdef0123456789abcdef";
    delete process.env.OIDC_ISSUER;
    delete process.env.OIDC_CLIENT_ID;

    // Should not throw because NEXT_RUNTIME !== "nodejs"
    await expect(register()).resolves.toBeUndefined();
  });

  test("runs check and does not output to console.log in nodejs runtime", async () => {
    process.env.NEXT_RUNTIME = "nodejs";
    process.env.AUTH_MODE = "local";
    delete process.env.AUTH_SECRET;

    let logged = false;
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      logged = true;
      originalLog(...args);
    };

    try {
      await expect(register()).resolves.toBeUndefined();
      expect(logged).toBe(false);
    } finally {
      console.log = originalLog;
    }
  });

  test("throws when login settings are invalid in nodejs runtime", async () => {
    process.env.NEXT_RUNTIME = "nodejs";
    process.env.AUTH_MODE = "oidc";
    process.env.AUTH_SECRET = "0123456789abcdef0123456789abcdef";
    delete process.env.OIDC_ISSUER;
    delete process.env.OIDC_CLIENT_ID;

    await expect(register()).rejects.toThrow(/OIDC_ISSUER is not set/);
  });
});
