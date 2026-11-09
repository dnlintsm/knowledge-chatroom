import { test, expect } from "@playwright/test";
import { NextRequest } from "next/server";
import { appUrl } from "../../apps/web/src/lib/auth";

test.describe("appUrl", () => {
  const originalAppUrl = process.env.APP_URL;

  test.afterEach(() => {
    if (originalAppUrl === undefined) {
      delete process.env.APP_URL;
    } else {
      process.env.APP_URL = originalAppUrl;
    }
  });

  test("uses req.nextUrl.origin when APP_URL is unset or empty", () => {
    delete process.env.APP_URL;
    const req = new NextRequest("http://localhost:3000/api/auth/login?foo=bar");
    expect(appUrl(req)).toBe("http://localhost:3000");

    process.env.APP_URL = "";
    const req2 = new NextRequest("https://chat.example.com/some/path");
    expect(appUrl(req2)).toBe("https://chat.example.com");
  });

  test("uses APP_URL when set, ignoring req.nextUrl.origin", () => {
    process.env.APP_URL = "https://app.example.com";
    const req = new NextRequest("http://localhost:3000/api/auth/callback");
    expect(appUrl(req)).toBe("https://app.example.com");
  });

  test("strips trailing slashes from APP_URL", () => {
    process.env.APP_URL = "https://app.example.com/";
    const req = new NextRequest("http://localhost:3000");
    expect(appUrl(req)).toBe("https://app.example.com");

    process.env.APP_URL = "https://app.example.com///";
    expect(appUrl(req)).toBe("https://app.example.com");

    process.env.APP_URL = "https://app.example.com/prefix/";
    expect(appUrl(req)).toBe("https://app.example.com/prefix");

    process.env.APP_URL = "https://app.example.com/prefix////";
    expect(appUrl(req)).toBe("https://app.example.com/prefix");
  });

  test("strips trailing slashes when falling back to req.nextUrl.origin or mock object", () => {
    delete process.env.APP_URL;

    // Standard NextRequest origin does not have trailing slash
    const req = new NextRequest("https://my-app.internal:8080/nested/path");
    expect(appUrl(req)).toBe("https://my-app.internal:8080");

    // Mock request where nextUrl.origin has trailing slashes
    const mockReq = {
      nextUrl: {
        origin: "https://my-app.internal:8080///",
      },
    } as unknown as NextRequest;
    expect(appUrl(mockReq)).toBe("https://my-app.internal:8080");
  });
});
