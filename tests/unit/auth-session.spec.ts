import { createHmac } from "node:crypto";
import { test, expect } from "@playwright/test";
import { NextRequest } from "next/server";
import {
  SESSION_COOKIE,
  readSession,
  sessionCookie,
  sessionFrom,
  sessionFromRequest,
  type SessionUser,
} from "../../src/lib/auth";

/** Reading and verifying signed session cookies (src/lib/auth.ts). */

const SECRET = "unit-test-secret-0123456789abcdef0123456789";
const LOGIN_ENV = {
  AUTH_MODE: "oidc",
  AUTH_SECRET: SECRET,
  OIDC_ISSUER: "https://login.example.com",
  OIDC_CLIENT_ID: "knowledge-chatroom",
};

const b64 = (data: Buffer | string) => Buffer.from(data).toString("base64url");
const mac = (secret: string, data: string) =>
  createHmac("sha256", secret).update(data).digest();

function makeCookie(
  kind: string,
  payload: object | string,
  secret: string = SECRET,
): string {
  const payloadStr =
    typeof payload === "string" ? payload : JSON.stringify(payload);
  const body = `${kind}.${b64(payloadStr)}`;
  return `${body}.${b64(mac(secret, body))}`;
}

test.describe("readSession when login is disabled (local mode / no secret)", () => {
  const saved: Record<string, string | undefined> = {};

  test.beforeEach(() => {
    saved.AUTH_MODE = process.env.AUTH_MODE;
    saved.AUTH_SECRET = process.env.AUTH_SECRET;
    saved.NODE_ENV = process.env.NODE_ENV;

    process.env.AUTH_MODE = "local";
    delete process.env.AUTH_SECRET;
    (process.env as Record<string, string | undefined>).NODE_ENV = "development";
  });

  test.afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test("returns null even if given a validly sealed token", () => {
    const user: SessionUser = { sub: "kc|user1", name: "User One" };
    const validCookie = makeCookie("s1", {
      ...user,
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    expect(readSession(validCookie)).toBeNull();
    expect(readSession(undefined)).toBeNull();
    expect(readSession("")).toBeNull();
  });
});

test.describe("readSession when login is enabled", () => {
  const saved: Record<string, string | undefined> = {};

  test.beforeAll(() => {
    for (const [key, value] of Object.entries(LOGIN_ENV)) {
      saved[key] = process.env[key];
      process.env[key] = value;
    }
  });

  test.afterAll(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test("reads valid session created via sessionCookie", () => {
    const user: SessionUser = {
      sub: "https://login.example.com|alice",
      email: "alice@example.com",
      name: "Alice Example",
    };
    const req = new NextRequest("http://localhost:3000/");
    const cookie = sessionCookie(req, user);

    const parsed = readSession(cookie.value);
    expect(parsed).toEqual(user);
  });

  test("reads valid session with only sub present", () => {
    const user: SessionUser = { sub: "provider|minimal-sub" };
    const req = new NextRequest("http://localhost:3000/");
    const cookie = sessionCookie(req, user);

    const parsed = readSession(cookie.value);
    expect(parsed).toEqual({
      sub: "provider|minimal-sub",
      email: undefined,
      name: undefined,
    });
  });

  test("returns null for undefined, empty, or non-token values", () => {
    expect(readSession(undefined)).toBeNull();
    expect(readSession("")).toBeNull();
    expect(readSession("not-a-token")).toBeNull();
    expect(readSession("part1.part2")).toBeNull();
    expect(readSession("part1.part2.part3.part4")).toBeNull();
  });

  test("returns null when kind is not s1", () => {
    const user = {
      sub: "provider|bob",
      exp: Math.floor(Date.now() / 1000) + 3600,
    };
    const loginCookieValue = makeCookie("l1", user);
    expect(readSession(loginCookieValue)).toBeNull();

    const otherKind = makeCookie("other", user);
    expect(readSession(otherKind)).toBeNull();
  });

  test("returns null for forged or tampered tokens", () => {
    const user = {
      sub: "provider|alice",
      exp: Math.floor(Date.now() / 1000) + 3600,
    };
    const valid = makeCookie("s1", user);
    const [kind, , sig] = valid.split(".");

    // Tampered payload
    const forgedPayload = b64(
      JSON.stringify({
        sub: "provider|eve",
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
    );
    expect(readSession(`${kind}.${forgedPayload}.${sig}`)).toBeNull();

    // Invalid signature
    expect(readSession(`${kind}.${forgedPayload}.invalidsignature`)).toBeNull();

    // Signed with different secret
    const signedWithDifferentSecret = makeCookie(
      "s1",
      user,
      "different-secret-0123456789abcdef0123456789",
    );
    expect(readSession(signedWithDifferentSecret)).toBeNull();
  });

  test("returns null for expired sessions", () => {
    const expiredUser = {
      sub: "provider|alice",
      exp: Math.floor(Date.now() / 1000) - 10, // 10 seconds ago
    };
    const expiredCookie = makeCookie("s1", expiredUser);
    expect(readSession(expiredCookie)).toBeNull();
  });

  test("returns null when payload is malformed or missing sub", () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;

    // Payload is not valid JSON
    const malformedBody = `s1.${b64("{not: valid: json")}`;
    const malformedCookie = `${malformedBody}.${b64(mac(SECRET, malformedBody))}`;
    expect(readSession(malformedCookie)).toBeNull();

    // Missing sub
    expect(readSession(makeCookie("s1", { exp, email: "no-sub@example.com" }))).toBeNull();

    // Empty string sub
    expect(readSession(makeCookie("s1", { exp, sub: "" }))).toBeNull();

    // Non-string sub
    expect(readSession(makeCookie("s1", { exp, sub: 12345 }))).toBeNull();

    // Non-numeric or missing exp
    expect(readSession(makeCookie("s1", { sub: "user-no-exp" }))).toBeNull();
    expect(readSession(makeCookie("s1", { sub: "user-str-exp", exp: "2099-01-01" }))).toBeNull();
  });

  test("sessionFrom extracts session from NextRequest cookies", () => {
    const user: SessionUser = { sub: "provider|next-user", name: "Next User" };
    const req = new NextRequest("http://localhost:3000/");
    const cookie = sessionCookie(req, user);

    // Request with cookie
    const reqWithCookie = new NextRequest("http://localhost:3000/", {
      headers: { cookie: `${SESSION_COOKIE}=${cookie.value}` },
    });
    expect(sessionFrom(reqWithCookie)).toEqual(user);

    // Request without cookie
    const reqWithoutCookie = new NextRequest("http://localhost:3000/");
    expect(sessionFrom(reqWithoutCookie)).toBeNull();
  });

  test("sessionFromRequest extracts session from standard Request cookies header", () => {
    const user: SessionUser = { sub: "provider|plain-user", name: "Plain User" };
    const nextReq = new NextRequest("http://localhost:3000/");
    const cookie = sessionCookie(nextReq, user);

    // Single cookie
    const plainReq1 = new Request("http://localhost:3000/", {
      headers: { cookie: `${SESSION_COOKIE}=${cookie.value}` },
    });
    expect(sessionFromRequest(plainReq1)).toEqual(user);

    // Multiple cookies with whitespace
    const plainReq2 = new Request("http://localhost:3000/", {
      headers: {
        cookie: `other_pref=dark; ${SESSION_COOKIE}=${cookie.value}; another=123`,
      },
    });
    expect(sessionFromRequest(plainReq2)).toEqual(user);

    // URL encoded cookie value
    const encodedValue = encodeURIComponent(cookie.value);
    const plainReq3 = new Request("http://localhost:3000/", {
      headers: { cookie: `${SESSION_COOKIE}=${encodedValue}` },
    });
    expect(sessionFromRequest(plainReq3)).toEqual(user);

    // Request with no cookie header
    const plainReq4 = new Request("http://localhost:3000/");
    expect(sessionFromRequest(plainReq4)).toBeNull();

    // Request with different cookies only
    const plainReq5 = new Request("http://localhost:3000/", {
      headers: { cookie: "other=foo; bar=baz" },
    });
    expect(sessionFromRequest(plainReq5)).toBeNull();
  });
});

test.describe("sessionFromRequest edge cases", () => {
  const saved: Record<string, string | undefined> = {};
  const ALICE: SessionUser = { sub: "test|alice", email: "alice@example.com", name: "Alice" };
  const withCookie = (cookie: string) =>
    new Request("https://app.example.com/api/copilotkit", { headers: { cookie } });

  test.beforeEach(() => {
    for (const [key, value] of Object.entries(LOGIN_ENV)) {
      saved[key] = process.env[key];
      process.env[key] = value;
    }
  });

  test.afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test("returns null for an empty or whitespace-only cookie header", () => {
    expect(sessionFromRequest(withCookie(""))).toBeNull();
    expect(sessionFromRequest(withCookie("   ;  "))).toBeNull();
  });

  test("finds the session cookie with extra whitespace around separators", () => {
    const cookie = sessionCookie(new NextRequest("https://app.example.com"), ALICE);
    const header = `unrelated=123;  ${SESSION_COOKIE}=${encodeURIComponent(cookie.value)} ;  theme=light`;
    expect(sessionFromRequest(withCookie(header))).toEqual(ALICE);
  });

  test("returns null for an expired, correctly signed session cookie", () => {
    const expired = makeCookie("s1", { ...ALICE, exp: Math.floor(Date.now() / 1000) - 10 });
    expect(sessionFromRequest(withCookie(`${SESSION_COOKIE}=${expired}`))).toBeNull();
    // The same cookie, still valid, is accepted: only the expiry differs.
    const valid = makeCookie("s1", { ...ALICE, exp: Math.floor(Date.now() / 1000) + 3600 });
    expect(sessionFromRequest(withCookie(`${SESSION_COOKIE}=${valid}`))).toEqual(ALICE);
  });

  test("returns null for a tampered or malformed session cookie", () => {
    const cookie = sessionCookie(new NextRequest("https://app.example.com"), ALICE);
    const tampered = cookie.value.slice(0, -5) + "abcde";
    expect(sessionFromRequest(withCookie(`${SESSION_COOKIE}=${tampered}`))).toBeNull();
    expect(sessionFromRequest(withCookie(`${SESSION_COOKIE}=s1.invalid.payload`))).toBeNull();
  });

  test("returns null in local mode even with a cookie signed while login was on", () => {
    const cookie = sessionCookie(new NextRequest("https://app.example.com"), ALICE);
    process.env.AUTH_MODE = "local";
    delete process.env.AUTH_SECRET;
    expect(sessionFromRequest(withCookie(`${SESSION_COOKIE}=${cookie.value}`))).toBeNull();
  });
});
