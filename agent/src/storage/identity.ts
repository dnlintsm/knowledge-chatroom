import type { IncomingMessage } from "node:http";

import { readIdentityToken, signIdentityToken } from "../../../shared/identity-token";

import type { Principal } from "./access";
import type { Storage } from "./index";

/**
 * Who a request is from. Without AUTH_SECRET there is no login: every request
 * is the built-in local user, who owns the workspace. With it, the Next.js app
 * (which handles login) signs the user into an X-Knowledge-User header, and
 * requests without a valid one are refused. The agent port must stay private
 * either way; the header is only as trustworthy as the network in front of it.
 * Tokens are made and checked by shared/identity-token.ts (v2: Ed25519, so
 * outside services verify them with the public key alone).
 */

export const IDENTITY_HEADER = "x-knowledge-user";

export interface Identity {
  /** Stable id from the login provider, e.g. "<issuer>|<sub>". */
  sub: string;
  email?: string;
  name?: string;
  /** Expiry, seconds since the epoch. */
  exp: number;
  /**
   * Who the token is for; unset = this agent. Tokens forwarded to outside MCP
   * servers carry "mcp:<server>" so the agent never accepts them back.
   */
  aud?: string;
}

/** A token for `identity`, in the IDENTITY_FORMAT the deployment uses. */
export function signIdentity(identity: Identity, secret: string): string {
  return signIdentityToken(identity, secret);
}

export function verifyIdentity(
  token: string,
  secret: string,
  now = Date.now(),
  audience?: string,
): Identity | null {
  const identity = readIdentityToken(token, secret, now);
  if (!identity) return null;
  if (typeof identity.sub !== "string" || !identity.sub || identity.sub === "local") return null;
  if (identity.aud !== audience) return null;
  return identity;
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
