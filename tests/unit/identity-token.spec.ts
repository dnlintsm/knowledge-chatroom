import { createHmac, createPublicKey, verify } from "node:crypto";

import { test, expect } from "@playwright/test";

import {
  checkIdentityFormat,
  identityPublicKey,
  readIdentityToken,
  signIdentityToken,
  storageTokenSeconds,
} from "../../shared/identity-token";

/** Identity tokens shared by the app, the agent and outside services (shared/identity-token.ts, issue #88). */

const SECRET = "0123456789abcdef0123456789abcdef";
const EXP = 4102444800; // 2100-01-01
const ALICE = { sub: "test|alice", email: "alice@example.com", name: "Alice", exp: EXP };

// The same values are in examples/python-agent/tests: the Python verifier must
// accept what this code signs.
const PUBLIC_KEY = "Z1iN8KqPV0u2Dk95GsXXFlHQE05RT15l2-1TzD3XDI8";

test("the key pair is derived from AUTH_SECRET", () => {
  expect(identityPublicKey(SECRET)).toBe(PUBLIC_KEY);
  expect(identityPublicKey("another-secret-0123456789abcdefgh")).not.toBe(PUBLIC_KEY);
});

test("v2 tokens verify with the public key alone", () => {
  const token = signIdentityToken({ ...ALICE, aud: "mcp:lab" }, SECRET);
  const [kind, payload, signature] = token.split(".");
  expect(kind).toBe("v2");
  const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: PUBLIC_KEY }, format: "jwk" });
  expect(verify(null, Buffer.from(`v2.${payload}`), key, Buffer.from(signature, "base64url"))).toBe(true);
  expect(readIdentityToken(token, SECRET)).toEqual({ ...ALICE, aud: "mcp:lab" });
});

test("forged, re-signed, expired and unknown tokens are refused", () => {
  const token = signIdentityToken(ALICE, SECRET);
  const [, , signature] = token.split(".");
  const bob = Buffer.from(JSON.stringify({ ...ALICE, sub: "test|bob" })).toString("base64url");
  expect(readIdentityToken(`v2.${bob}.${signature}`, SECRET)).toBeNull();
  expect(readIdentityToken(token, "another-secret-0123456789abcdefgh")).toBeNull();
  // A v2 payload with an HMAC signature (the old v1 scheme) doesn't pass.
  const payload = token.split(".")[1];
  const hmac = createHmac("sha256", SECRET).update(`v2.${payload}`).digest("base64url");
  expect(readIdentityToken(`v2.${payload}.${hmac}`, SECRET)).toBeNull();
  expect(readIdentityToken(signIdentityToken({ ...ALICE, exp: 1 }, SECRET), SECRET)).toBeNull();
  expect(readIdentityToken(token.replace(/^v2/, "v3"), SECRET)).toBeNull();
  expect(readIdentityToken("garbage", SECRET)).toBeNull();
  expect(readIdentityToken(undefined, SECRET)).toBeNull();
});

test("v1 tokens are no longer accepted, and a leftover IDENTITY_FORMAT=v1 stops startup", () => {
  const body = `v1.${Buffer.from(JSON.stringify(ALICE)).toString("base64url")}`;
  const v1 = `${body}.${createHmac("sha256", SECRET).update(body).digest("base64url")}`;
  expect(readIdentityToken(v1, SECRET)).toBeNull();
  expect(signIdentityToken(ALICE, SECRET)).toMatch(/^v2\./);
  expect(() => checkIdentityFormat({})).not.toThrow();
  expect(() => checkIdentityFormat({ IDENTITY_FORMAT: "v2" })).not.toThrow();
  expect(() => checkIdentityFormat({ IDENTITY_FORMAT: "V1" })).toThrow(/IDENTITY_FORMAT.*no longer supported/);
  expect(() => checkIdentityFormat({ IDENTITY_FORMAT: "jwt" })).toThrow(/IDENTITY_FORMAT/);
});

test("storage tokens last an hour unless STORAGE_TOKEN_SECONDS says otherwise", () => {
  expect(storageTokenSeconds({})).toBe(3600);
  expect(storageTokenSeconds({ STORAGE_TOKEN_SECONDS: "7200" })).toBe(7200);
  for (const bad of ["10", "1.5", "two hours", "999999"]) {
    expect(() => storageTokenSeconds({ STORAGE_TOKEN_SECONDS: bad })).toThrow(/STORAGE_TOKEN_SECONDS/);
  }
});
