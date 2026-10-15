import { test, expect } from "@playwright/test";
import { authSettings, checkOidcSettings, httpAllowed } from "../../shared/auth-mode";

/** How the app and the agent decide whether people sign in (shared/auth-mode.ts, issue #64). */

const SECRET = "0123456789abcdef0123456789abcdef";
const OIDC = { OIDC_ISSUER: "https://login.example.com", OIDC_CLIENT_ID: "kc" };

test("development without settings runs without login", () => {
  expect(authSettings({})).toEqual({ mode: "local" });
  expect(authSettings({ NODE_ENV: "development" })).toEqual({ mode: "local" });
});

test("production refuses to guess when nothing is set", () => {
  expect(() => authSettings({ NODE_ENV: "production" })).toThrow(/Login is not configured/);
  expect(() => authSettings({ NODE_ENV: "production", AUTH_SECRET: "" })).toThrow(/Login is not configured/);
  expect(authSettings({ NODE_ENV: "production", AUTH_MODE: "local" })).toEqual({ mode: "local" });
});

test("AUTH_SECRET alone still means login, and explicit modes are checked", () => {
  expect(authSettings({ NODE_ENV: "production", AUTH_SECRET: SECRET })).toEqual({ mode: "oidc", secret: SECRET });
  expect(authSettings({ AUTH_MODE: "OIDC", AUTH_SECRET: SECRET })).toEqual({ mode: "oidc", secret: SECRET });
  expect(() => authSettings({ AUTH_MODE: "oidc" })).toThrow(/needs AUTH_SECRET/);
  expect(() => authSettings({ AUTH_MODE: "local", AUTH_SECRET: SECRET })).toThrow(/must not be set/);
  expect(() => authSettings({ AUTH_MODE: "none" })).toThrow(/AUTH_MODE must be/);
  expect(() => authSettings({ AUTH_SECRET: "short" })).toThrow(/too short/);
});

test("http is only for this machine unless explicitly allowed", () => {
  expect(httpAllowed(new URL("https://login.example.com"), {})).toBe(true);
  expect(httpAllowed(new URL("http://localhost:9400"), {})).toBe(true);
  expect(httpAllowed(new URL("http://127.0.0.1:9400"), {})).toBe(true);
  expect(httpAllowed(new URL("http://[::1]:9400"), {})).toBe(true);
  expect(httpAllowed(new URL("http://keycloak:8080"), {})).toBe(false);
  expect(httpAllowed(new URL("http://localhost.example.com"), {})).toBe(false);
  expect(httpAllowed(new URL("http://keycloak:8080"), { AUTH_ALLOW_HTTP: "true" })).toBe(true);
  expect(httpAllowed(new URL("http://keycloak:8080"), { AUTH_ALLOW_HTTP: "true", NODE_ENV: "production" })).toBe(false);
  expect(httpAllowed(new URL("http://localhost:9400"), { NODE_ENV: "production" })).toBe(true);
});

test("sign-in settings are complete and use https", () => {
  expect(() => checkOidcSettings({ ...OIDC, APP_URL: "https://kc.example.com", NODE_ENV: "production" })).not.toThrow();
  expect(() => checkOidcSettings({ ...OIDC })).not.toThrow();
  expect(() => checkOidcSettings({ ...OIDC, NODE_ENV: "production" })).toThrow(/APP_URL is not set/);
  expect(() => checkOidcSettings({ OIDC_CLIENT_ID: "kc" })).toThrow(/OIDC_ISSUER is not set/);
  expect(() => checkOidcSettings({ ...OIDC, OIDC_ISSUER: "http://login.example.com" })).toThrow(/OIDC_ISSUER must use https/);
  expect(() => checkOidcSettings({ ...OIDC, APP_URL: "http://kc.example.com" })).toThrow(/APP_URL must use https/);
  expect(() => checkOidcSettings({ ...OIDC, APP_URL: "not a url" })).toThrow(/APP_URL is not a URL/);
  // The mock provider and app in the login E2E run.
  expect(() =>
    checkOidcSettings({
      OIDC_ISSUER: "http://localhost:9400",
      OIDC_CLIENT_ID: "kc",
      APP_URL: "http://localhost:3000",
      NODE_ENV: "production",
    }),
  ).not.toThrow();
});
