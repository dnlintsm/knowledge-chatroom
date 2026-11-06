import { test, expect } from "@playwright/test";
import { NextRequest } from "next/server";
import { agentProxy } from "../../src/lib/agent-proxy";
import { IDENTITY_HEADER, SESSION_COOKIE, sessionCookie } from "../../src/lib/auth";

test.describe("agentProxy", () => {
  const originalFetch = globalThis.fetch;

  test.afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("returns 502 with error message when agent server is unreachable", async () => {
    globalThis.fetch = async () => {
      throw new TypeError("fetch failed");
    };

    const proxy = agentProxy("files");
    const req = new NextRequest("http://localhost:3000/api/files/doc.md");
    const res = await proxy(req, { params: Promise.resolve({ path: ["doc.md"] }) });

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "Agent server unreachable" });
  });

  test("forwards GET request with target URL, query params, and forwarded headers", async () => {
    let capturedUrl: URL | string | null = null;
    let capturedInit: RequestInit | null = null;

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = input as URL | string;
      capturedInit = init ?? null;
      return new Response("file content", {
        status: 200,
        headers: {
          "content-type": "text/plain",
          "etag": '"12345"',
          "x-ignored-header": "ignore-me",
        },
      });
    }) as typeof fetch;

    const proxy = agentProxy("files");
    const req = new NextRequest("http://localhost:3000/api/files/nested/item.txt?watch=true&v=1", {
      method: "GET",
      headers: {
        accept: "text/plain",
        "if-none-match": '"00000"',
        "x-read-only": "true",
        "x-custom-browser-header": "dropped",
      },
    });

    const res = await proxy(req, {
      params: Promise.resolve({ path: ["nested", "item.txt"] }),
    });

    expect(capturedUrl).not.toBeNull();
    const url = new URL(capturedUrl!.toString());
    expect(url.pathname).toBe("/files/nested/item.txt");
    expect(url.search).toBe("?watch=true&v=1");

    expect(capturedInit).not.toBeNull();
    const init = capturedInit!;
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();

    const forwardedReqHeaders = new Headers(init.headers);
    expect(forwardedReqHeaders.get("accept")).toBe("text/plain");
    expect(forwardedReqHeaders.get("if-none-match")).toBe('"00000"');
    expect(forwardedReqHeaders.get("x-read-only")).toBe("true");
    expect(forwardedReqHeaders.get("x-custom-browser-header")).toBeNull();

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain");
    expect(res.headers.get("etag")).toBe('"12345"');
    expect(res.headers.get("x-ignored-header")).toBeNull();
    expect(await res.text()).toBe("file content");
  });

  test("forwards request body for non-GET/HEAD/DELETE methods", async () => {
    let capturedInit: RequestInit | null = null;

    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedInit = init ?? null;
      return new Response(JSON.stringify({ ok: true }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const proxy = agentProxy("files");
    const req = new NextRequest("http://localhost:3000/api/files/new.json", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hello: "world" }),
    });

    const res = await proxy(req, {
      params: Promise.resolve({ path: ["new.json"] }),
    });

    expect(res.status).toBe(201);
    expect(capturedInit).not.toBeNull();
    const init = capturedInit!;
    expect(init.method).toBe("POST");
    expect(init.body).toBeInstanceOf(ArrayBuffer);
    const bodyText = new TextDecoder().decode(init.body as ArrayBuffer);
    expect(JSON.parse(bodyText)).toEqual({ hello: "world" });
  });

  test("handles empty path parameter defaults to empty path segments", async () => {
    let capturedUrl: URL | string | null = null;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      capturedUrl = input as URL | string;
      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    const proxy = agentProxy("proposals");
    const req = new NextRequest("http://localhost:3000/api/proposals");
    const res = await proxy(req, { params: Promise.resolve({}) });

    expect(res.status).toBe(200);
    const url = new URL(capturedUrl!.toString());
    expect(url.pathname).toBe("/proposals/");
  });
});

test.describe("agentProxy with authentication", () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };

  test.beforeAll(() => {
    process.env.AUTH_MODE = "oidc";
    process.env.AUTH_SECRET = "unit-test-secret-0123456789abcdef0123456789";
    process.env.OIDC_ISSUER = "https://login.example.com";
    process.env.OIDC_CLIENT_ID = "knowledge-chatroom";
  });

  test.afterAll(() => {
    process.env = originalEnv;
  });

  test.afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("returns 401 when request is not signed in", async () => {
    const proxy = agentProxy("files");
    const req = new NextRequest("http://localhost:3000/api/files/secret.txt");
    const res = await proxy(req, { params: Promise.resolve({ path: ["secret.txt"] }) });

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Sign in first" });
  });

  test("attaches identity header when request has valid session cookie", async () => {
    let capturedInit: RequestInit | null = null;

    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedInit = init ?? null;
      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    const proxy = agentProxy("files");
    const dummyReq = new NextRequest("http://localhost:3000");
    const cookie = sessionCookie(dummyReq, {
      sub: "https://login.example.com|alice",
      email: "alice@example.com",
      name: "Alice",
    });

    const req = new NextRequest("http://localhost:3000/api/files/secret.txt", {
      headers: {
        cookie: `${SESSION_COOKIE}=${cookie.value}`,
      },
    });

    const res = await proxy(req, { params: Promise.resolve({ path: ["secret.txt"] }) });
    expect(res.status).toBe(200);

    expect(capturedInit).not.toBeNull();
    const headers = new Headers(capturedInit!.headers);
    expect(headers.has(IDENTITY_HEADER)).toBe(true);
    const idToken = headers.get(IDENTITY_HEADER);
    expect(typeof idToken).toBe("string");
  });
});
