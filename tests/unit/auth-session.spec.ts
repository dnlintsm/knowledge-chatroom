import { test, expect } from "@playwright/test";
import { NextRequest } from "next/server";
import {
  SESSION_COOKIE,
  sessionCookie,
  sessionFromRequest,
  sessionFrom,
  SessionUser,
} from "../../src/lib/auth";

const SECRET = "0123456789abcdef0123456789abcdef";
const ALICE: SessionUser = { sub: "test|alice", email: "alice@example.com", name: "Alice" };

test.describe("sessionFromRequest and cookie handling", () => {
  const originalEnv = { ...process.env };

  test.beforeEach(() => {
    process.env.AUTH_MODE = "oidc";
    process.env.AUTH_SECRET = SECRET;
    process.env.OIDC_ISSUER = "https://login.example.com";
    process.env.OIDC_CLIENT_ID = "kc";
    process.env.APP_URL = "https://app.example.com";
  });

  test.afterEach(() => {
    process.env = { ...originalEnv };
  });

  test("returns null when cookie header is missing", () => {
    const req = new Request("https://app.example.com/api/copilotkit");
    expect(req.headers.get("cookie")).toBeNull();
    expect(sessionFromRequest(req)).toBeNull();
  });

  test("returns null when cookie header is empty or whitespace", () => {
    const reqEmpty = new Request("https://app.example.com/api/copilotkit", {
      headers: { cookie: "" },
    });
    expect(sessionFromRequest(reqEmpty)).toBeNull();

    const reqWhitespace = new Request("https://app.example.com/api/copilotkit", {
      headers: { cookie: "   ;  " },
    });
    expect(sessionFromRequest(reqWhitespace)).toBeNull();
  });

  test("returns null when other cookies are present but SESSION_COOKIE is missing", () => {
    const req = new Request("https://app.example.com/api/copilotkit", {
      headers: { cookie: "theme=dark; other_session=xyz123; foo=bar" },
    });
    expect(sessionFromRequest(req)).toBeNull();
  });

  test("returns user when valid session cookie is the only cookie", () => {
    const dummyNextReq = new NextRequest("https://app.example.com");
    const cookie = sessionCookie(dummyNextReq, ALICE);

    const req = new Request("https://app.example.com/api/copilotkit", {
      headers: { cookie: `${SESSION_COOKIE}=${cookie.value}` },
    });
    expect(sessionFromRequest(req)).toEqual(ALICE);
  });

  test("returns user when valid session cookie is surrounded by other cookies and whitespace", () => {
    const dummyNextReq = new NextRequest("https://app.example.com");
    const cookie = sessionCookie(dummyNextReq, ALICE);

    const req = new Request("https://app.example.com/api/copilotkit", {
      headers: {
        cookie: `unrelated=123;  ${SESSION_COOKIE}=${encodeURIComponent(cookie.value)} ;  theme=light; other=abc`,
      },
    });
    expect(sessionFromRequest(req)).toEqual(ALICE);
  });

  test("returns null when session cookie is expired or tampered", () => {
    const dummyNextReq = new NextRequest("https://app.example.com");
    const cookie = sessionCookie(dummyNextReq, ALICE);

    const tamperedValue = cookie.value.slice(0, -5) + "abcde";
    const reqTampered = new Request("https://app.example.com/api/copilotkit", {
      headers: { cookie: `${SESSION_COOKIE}=${tamperedValue}` },
    });
    expect(sessionFromRequest(reqTampered)).toBeNull();

    const reqInvalid = new Request("https://app.example.com/api/copilotkit", {
      headers: { cookie: `${SESSION_COOKIE}=s1.invalid.payload` },
    });
    expect(sessionFromRequest(reqInvalid)).toBeNull();
  });

  test("returns null in local mode even when a cookie is present", () => {
    delete process.env.AUTH_SECRET;
    process.env.AUTH_MODE = "local";

    const dummyNextReq = new NextRequest("https://app.example.com");
    // Generate cookie under OIDC secret first
    process.env.AUTH_SECRET = SECRET;
    process.env.AUTH_MODE = "oidc";
    const cookie = sessionCookie(dummyNextReq, ALICE);

    // Switch to local mode
    delete process.env.AUTH_SECRET;
    process.env.AUTH_MODE = "local";

    const req = new Request("https://app.example.com/api/copilotkit", {
      headers: { cookie: `${SESSION_COOKIE}=${cookie.value}` },
    });
    expect(sessionFromRequest(req)).toBeNull();
  });

  test("sessionFrom (NextRequest) matches sessionFromRequest (Request)", () => {
    const nextReq = new NextRequest("https://app.example.com/api/copilotkit");
    const cookie = sessionCookie(nextReq, ALICE);

    const reqWithCookie = new NextRequest("https://app.example.com/api/copilotkit", {
      headers: { cookie: `${SESSION_COOKIE}=${cookie.value}` },
    });
    const standardReq = new Request("https://app.example.com/api/copilotkit", {
      headers: { cookie: `${SESSION_COOKIE}=${cookie.value}` },
    });

    expect(sessionFrom(reqWithCookie)).toEqual(ALICE);
    expect(sessionFromRequest(standardReq)).toEqual(ALICE);

    const emptyNextReq = new NextRequest("https://app.example.com/api/copilotkit");
    const emptyStandardReq = new Request("https://app.example.com/api/copilotkit");
    expect(sessionFrom(emptyNextReq)).toBeNull();
    expect(sessionFromRequest(emptyStandardReq)).toBeNull();
  });
});
