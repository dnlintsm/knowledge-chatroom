import { test, expect } from "@playwright/test";
import { NextRequest } from "next/server";
import { GET } from "../../apps/web/src/app/api/rules/route";
import { SESSION_COOKIE, sessionCookie } from "../../apps/web/src/lib/auth";

/** GET /api/rules (apps/web/src/app/api/rules/route.ts): who may ask, and what is forwarded. */

const LOGIN_ENV = {
  AUTH_MODE: "oidc",
  AUTH_SECRET: "unit-test-secret-0123456789abcdef0123456789",
  OIDC_ISSUER: "https://login.example.com",
  OIDC_CLIENT_ID: "knowledge-chatroom",
};
const KEYS = [...Object.keys(LOGIN_ENV), "RULES_API_URL"];
const URL_ = "http://localhost:3000/api/rules?run=Run%201&experiment=x1";

test.describe("GET /api/rules", () => {
  const saved: Record<string, string | undefined> = {};
  const originalFetch = globalThis.fetch;
  let asked: string[] = [];

  test.beforeEach(() => {
    for (const key of KEYS) saved[key] = process.env[key];
    asked = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      asked.push(input.toString());
      return Response.json({ rules: [] });
    }) as typeof fetch;
  });

  test.afterEach(() => {
    globalThis.fetch = originalFetch;
    for (const key of KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  test("with login on, a request without a session is refused before the rules API is asked", async () => {
    Object.assign(process.env, LOGIN_ENV, { RULES_API_URL: "https://rules.example.com/v1" });

    const res = await GET(new NextRequest(URL_));

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Sign in first" });
    expect(asked).toEqual([]);
  });

  test("with login on, a signed-in request reaches the rules API", async () => {
    Object.assign(process.env, LOGIN_ENV, { RULES_API_URL: "https://rules.example.com/v1" });
    const cookie = sessionCookie(new NextRequest(URL_), { sub: "kc|alice", name: "Alice" });

    const res = await GET(
      new NextRequest(URL_, { headers: { cookie: `${SESSION_COOKIE}=${cookie.value}` } }),
    );

    expect(res.status).toBe(200);
    expect(asked).toEqual(["https://rules.example.com/v1?run=Run+1&experiment=x1"]);
  });

  test("without login, the built-in user needs no session", async () => {
    process.env.AUTH_MODE = "local";
    delete process.env.AUTH_SECRET;
    delete process.env.RULES_API_URL;

    const res = await GET(new NextRequest(URL_));

    expect(res.status).toBe(200);
    expect(asked).toEqual([]); // the built-in mock answered
  });
});
