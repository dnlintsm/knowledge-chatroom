/**
 * The signed identity tokens that say who a request is for (X-Knowledge-User),
 * made and checked the same way by the Next.js app and the agent (issue #88).
 *
 * - `v2.<payload>.<Ed25519 signature>` (default): signed with a key pair
 *   derived from AUTH_SECRET. Outside services (remote backends, MCP servers)
 *   verify with the public key alone, so they can't sign for anyone.
 * - `v1.<payload>.<HMAC-SHA256>`: the old format, checked with AUTH_SECRET
 *   itself. Still accepted, and made when IDENTITY_FORMAT=v1, for one release
 *   so services that verify v1 keep working while they move to the public key.
 *
 * The payload is base64url JSON {sub, email?, name?, exp, aud?}; `exp` is in
 * seconds since the epoch.
 */

import {
  createHmac,
  createPrivateKey,
  createPublicKey,
  hkdfSync,
  sign,
  timingSafeEqual,
  verify,
  type KeyObject,
} from "node:crypto";

export interface IdentityClaims {
  sub: string;
  email?: string;
  name?: string;
  exp: number;
  aud?: string;
}

export type IdentityFormat = "v1" | "v2";

type Env = Record<string, string | undefined>;

/** The format new tokens are made in: v2 unless IDENTITY_FORMAT=v1. */
export function identityFormat(env: Env = process.env): IdentityFormat {
  const value = env.IDENTITY_FORMAT?.trim().toLowerCase() || "v2";
  if (value !== "v1" && value !== "v2") {
    throw new Error(`IDENTITY_FORMAT must be "v1" or "v2", not "${env.IDENTITY_FORMAT}"`);
  }
  return value;
}

// PKCS#8 DER header of an Ed25519 private key; the 32-byte seed follows it.
const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

const keyPairs = new Map<string, { privateKey: KeyObject; publicKey: KeyObject }>();

function keyPair(secret: string) {
  let pair = keyPairs.get(secret);
  if (!pair) {
    const seed = Buffer.from(hkdfSync("sha256", secret, "knowledge-chatroom", "x-knowledge-user v2", 32));
    const privateKey = createPrivateKey({
      key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]),
      format: "der",
      type: "pkcs8",
    });
    pair = { privateKey, publicKey: createPublicKey(privateKey) };
    keyPairs.set(secret, pair);
  }
  return pair;
}

/** The public key for AUTH_SECRET: the raw 32-byte Ed25519 key, base64url. */
export function identityPublicKey(secret: string): string {
  const spki = keyPair(secret).publicKey.export({ format: "der", type: "spki" });
  return spki.subarray(spki.length - 32).toString("base64url");
}

const b64 = (data: Buffer | string) => Buffer.from(data).toString("base64url");
const mac = (secret: string, data: string) => createHmac("sha256", secret).update(data).digest();

export function signIdentityToken(
  claims: IdentityClaims,
  secret: string,
  format: IdentityFormat = identityFormat(),
): string {
  const body = `${format}.${b64(JSON.stringify(claims))}`;
  const signature =
    format === "v1" ? mac(secret, body) : sign(null, Buffer.from(body), keyPair(secret).privateKey);
  return `${body}.${b64(signature)}`;
}

/**
 * The claims of a token signed for AUTH_SECRET in either format, or null when
 * it is malformed, forged or expired. Callers check `sub` and `aud`.
 */
export function readIdentityToken(
  token: string | undefined,
  secret: string,
  now = Date.now(),
): IdentityClaims | null {
  const parts = token?.split(".") ?? [];
  if (parts.length !== 3) return null;
  const body = `${parts[0]}.${parts[1]}`;
  const given = Buffer.from(parts[2], "base64url");
  if (parts[0] === "v1") {
    const expected = mac(secret, body);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  } else if (parts[0] === "v2") {
    if (given.length !== 64 || !verify(null, Buffer.from(body), keyPair(secret).publicKey, given)) return null;
  } else {
    return null;
  }
  try {
    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as IdentityClaims;
    if (!claims || typeof claims !== "object") return null;
    if (typeof claims.exp !== "number" || claims.exp * 1000 < now) return null;
    return claims;
  } catch {
    return null;
  }
}
