import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

import type { Principal } from "./access";
import type { Storage } from "./index";

/**
 * Who a request is from. Without AUTH_SECRET there is no login: every request
 * is the built-in local user, who owns the workspace. With it, the Next.js app
 * (which handles login) signs the user into an X-Knowledge-User header, and
 * requests without a valid one are refused. The agent port must stay private
 * either way; the header is only as trustworthy as the network in front of it.
 */

export const IDENTITY_HEADER = "x-knowledge-user";

export interface Identity {
  /** Stable id from the login provider, e.g. "<issuer>|<sub>". */
  sub: string;
  email?: string;
  name?: string;
  /** Expiry, seconds since the epoch. */
  exp: number;
}

const b64 = (data: Buffer | string) => Buffer.from(data).toString("base64url");
const mac = (secret: string, data: string) =>
  createHmac("sha256", secret).update(data).digest();

/** `v1.<payload>.<hmac>`; the Next.js app makes the same token. */
export function signIdentity(identity: Identity, secret: string): string {
  const body = `v1.${b64(JSON.stringify(identity))}`;
  return `${body}.${b64(mac(secret, body))}`;
}

export function verifyIdentity(token: string, secret: string, now = Date.now()): Identity | null {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return null;
  const expected = mac(secret, `${parts[0]}.${parts[1]}`);
  const given = Buffer.from(parts[2], "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const identity = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Identity;
    if (typeof identity.sub !== "string" || !identity.sub || identity.sub === "local") return null;
    if (typeof identity.exp !== "number" || identity.exp * 1000 < now) return null;
    return identity;
  } catch {
    return null;
  }
}

/** The principal for a request, or null when login is on and it carries no valid identity. */
export async function identify(
  req: Pick<IncomingMessage, "headers">,
  storage: Storage,
  actor: Principal["actor"] = "user",
): Promise<Principal | null> {
  const secret = storage.config.authSecret;
  if (!secret) return { userId: await storage.access.localUserId(), actor };
  const header = req.headers[IDENTITY_HEADER];
  const identity = typeof header === "string" ? verifyIdentity(header, secret) : null;
  if (!identity) return null;
  const userId = await storage.access.userForSubject(identity.sub, {
    email: identity.email,
    name: identity.name,
  });
  return { userId, actor };
}
