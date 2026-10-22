import { createPublicKey, verify } from "node:crypto";

import { test, expect } from "@playwright/test";

import {
  identityFormat,
  identityPublicKey,
  readIdentityToken,
  signIdentityToken,
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
  const token = signIdentityToken({ ...ALICE, aud: "mcp:lab" }, SECRET, "v2");
  const [kind, payload, signature] = token.split(".");
  expect(kind).toBe("v2");
  const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: PUBLIC_KEY }, format: "jwk" });
  expect(verify(null, Buffer.from(`v2.${payload}`), key, Buffer.from(signature, "base64url"))).toBe(true);
  expect(readIdentityToken(token, SECRET)).toEqual({ ...ALICE, aud: "mcp:lab" });
});

test("forged, re-signed, expired and unknown tokens are refused", () => {
  const token = signIdentityToken(ALICE, SECRET, "v2");
  const [, , signature] = token.split(".");
  const bob = Buffer.from(JSON.stringify({ ...ALICE, sub: "test|bob" })).toString("base64url");
  expect(readIdentityToken(`v2.${bob}.${signature}`, SECRET)).toBeNull();
  expect(readIdentityToken(token, "another-secret-0123456789abcdefgh")).toBeNull();
  // A v2 payload with a v1 signature (or the other way) doesn't pass.
  const v1 = signIdentityToken(ALICE, SECRET, "v1");
  expect(readIdentityToken(`v2.${v1.split(".")[1]}.${v1.split(".")[2]}`, SECRET)).toBeNull();
  expect(readIdentityToken(signIdentityToken({ ...ALICE, exp: 1 }, SECRET, "v2"), SECRET)).toBeNull();
  expect(readIdentityToken(token.replace(/^v2/, "v3"), SECRET)).toBeNull();
  expect(readIdentityToken("garbage", SECRET)).toBeNull();
  expect(readIdentityToken(undefined, SECRET)).toBeNull();
});

test("v1 tokens are still accepted during the move, and IDENTITY_FORMAT=v1 makes them", () => {
  expect(readIdentityToken(signIdentityToken(ALICE, SECRET, "v1"), SECRET)).toEqual(ALICE);
  expect(identityFormat({})).toBe("v2");
  expect(identityFormat({ IDENTITY_FORMAT: "V1" })).toBe("v1");
  expect(() => identityFormat({ IDENTITY_FORMAT: "jwt" })).toThrow(/IDENTITY_FORMAT/);
  expect(signIdentityToken(ALICE, SECRET, identityFormat({ IDENTITY_FORMAT: "v1" }))).toMatch(/^v1\./);
});
