import { test, expect } from "@playwright/test";
import { emailIsTrusted, userFromClaims } from "../../apps/web/src/lib/auth";

type IDToken = Parameters<typeof userFromClaims>[0];

/** Who a finished sign-in names (apps/web/src/lib/auth.ts), and which emails count. */

const claims = (extra: Record<string, unknown>) =>
  ({ iss: "https://login.example.com", sub: "u1", aud: "kc", iat: 0, exp: 1, ...extra }) as unknown as IDToken;

test("a verified email is kept, with the name the provider gives", () => {
  expect(userFromClaims(claims({ email: "alice@example.com", email_verified: true, name: "Alice" }), {})).toEqual({
    sub: "https://login.example.com|u1",
    email: "alice@example.com",
    name: "Alice",
  });
});

test("an email the provider does not vouch for is left out, also as the fallback name", () => {
  for (const extra of [{}, { email_verified: false }, { email_verified: "true" }]) {
    const user = userFromClaims(claims({ email: "admin@example.com", ...extra }), {});
    expect(user.email).toBeUndefined();
    expect(user.name).toBeUndefined();
    expect(JSON.stringify(user)).not.toContain("admin@example.com");
  }
  const named = userFromClaims(claims({ email: "admin@example.com", preferred_username: "mallory" }), {});
  expect(named).toEqual({ sub: "https://login.example.com|u1", email: undefined, name: "mallory" });
});

test("OIDC_ASSUME_EMAIL_VERIFIED covers a provider that sends no claim, never an explicit false", () => {
  const assume = { OIDC_ASSUME_EMAIL_VERIFIED: "true" };
  expect(userFromClaims(claims({ email: "bob@example.com" }), assume).email).toBe("bob@example.com");
  expect(userFromClaims(claims({ email: "bob@example.com", email_verified: false }), assume).email).toBeUndefined();
  expect(emailIsTrusted(claims({ email: "bob@example.com" }), { OIDC_ASSUME_EMAIL_VERIFIED: "1" })).toBe(false);
  expect(emailIsTrusted(claims({ email: "bob@example.com", email_verified: true }), {})).toBe(true);
});
