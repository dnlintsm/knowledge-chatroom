/**
 * The signed identity tokens that say who a request is for (X-Knowledge-User),
 * made and checked the same way by the Next.js app and the agent (issue #88).
 *
 * Tokens are `v2.<payload>.<Ed25519 signature>`, signed with a key pair
 * derived from AUTH_SECRET. Outside services (remote backends, MCP servers)
 * verify with the public key alone, so they can't sign for anyone. The old
 * `v1` HMAC format was accepted for one release (0.2.0) and is gone.
 *
 * The payload is base64url JSON {sub, email?, name?, exp, aud?, via?}; `exp`
 * is in seconds since the epoch.
 *
 * Storage tokens (X-Knowledge-Storage) are the same tokens with aud "storage"
 * and `via` naming the outside service they were made for ("mcp:<name>",
 * "remote"). Only the storage API accepts them, and it treats their requests
 * as Claude acting for the user: node writes must be proposals, and nothing
 * is deleted or shared (agent/src/storage/http.ts).
 *
 * Memory tokens (X-Knowledge-Memory) have aud "memory", `via`, and the run's
 * `thread` and `node`: an outside MCP server uses the user's memory for that
 * chat through the agent's /memory/agent API, as Claude does in it (issue #93).
 */

import {
  createPrivateKey,
  createPublicKey,
  hkdfSync,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";

export interface IdentityClaims {
  sub: string;
  email?: string;
  name?: string;
  exp: number;
  aud?: string;
  /** Storage and memory tokens: the outside service acting for the user. */
  via?: string;
  /** Memory tokens: the chat and the knowledge node the run is in. */
  thread?: string;
  node?: string | null;
}

export const STORAGE_HEADER = "x-knowledge-storage";
export const STORAGE_AUDIENCE = "storage";
export const MEMORY_HEADER = "x-knowledge-memory";
export const MEMORY_AUDIENCE = "memory";

/** How long a storage token lasts: STORAGE_TOKEN_SECONDS, default an hour (a long run). */
export function storageTokenSeconds(env: Env = process.env): number {
  const value = env.STORAGE_TOKEN_SECONDS?.trim();
  if (!value) return 3600;
  const seconds = Number(value);
  if (!Number.isInteger(seconds) || seconds < 60 || seconds > 24 * 3600) {
    throw new Error(`STORAGE_TOKEN_SECONDS must be whole seconds from 60 to 86400, not "${value}"`);
  }
  return seconds;
}

type Env = Record<string, string | undefined>;

/**
 * Refuses a leftover IDENTITY_FORMAT=v1 at startup: v1 tokens are no longer
 * made or accepted, so a service still verifying them would fail on every
 * request. Better to stop here with the reason.
 */
export function checkIdentityFormat(env: Env = process.env): void {
  const value = env.IDENTITY_FORMAT?.trim().toLowerCase();
  if (!value || value === "v2") return;
  throw new Error(
    `IDENTITY_FORMAT=${env.IDENTITY_FORMAT} is no longer supported: identity tokens are always v2 ` +
      "(Ed25519). Unset it, and have outside services verify with the public key from " +
      "GET /identity/public-key (docs/remote-agent.md).",
  );
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

export function signIdentityToken(claims: IdentityClaims, secret: string): string {
  const body = `v2.${b64(JSON.stringify(claims))}`;
  return `${body}.${b64(sign(null, Buffer.from(body), keyPair(secret).privateKey))}`;
}

/**
 * The claims of a token signed for AUTH_SECRET, or null when it is malformed,
 * forged, expired or in another format (including the retired v1). Callers
 * check `sub` and `aud`.
 */
export function readIdentityToken(
  token: string | undefined,
  secret: string,
  now = Date.now(),
): IdentityClaims | null {
  const parts = token?.split(".") ?? [];
  if (parts.length !== 3 || parts[0] !== "v2") return null;
  const body = `${parts[0]}.${parts[1]}`;
  const given = Buffer.from(parts[2], "base64url");
  if (given.length !== 64 || !verify(null, Buffer.from(body), keyPair(secret).publicKey, given)) return null;
  try {
    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as IdentityClaims;
    if (!claims || typeof claims !== "object") return null;
    if (typeof claims.exp !== "number" || claims.exp * 1000 < now) return null;
    return claims;
  } catch {
    return null;
  }
}
