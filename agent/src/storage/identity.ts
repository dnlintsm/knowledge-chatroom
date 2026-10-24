import type { IncomingMessage } from "node:http";

import {
  MEMORY_AUDIENCE,
  MEMORY_HEADER,
  STORAGE_AUDIENCE,
  STORAGE_HEADER,
  readIdentityToken,
  signIdentityToken,
} from "../../../shared/identity-token";

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
export { MEMORY_AUDIENCE, MEMORY_HEADER, STORAGE_HEADER };

export interface Identity {
  /** Stable id from the login provider, e.g. "<issuer>|<sub>". */
  sub: string;
  email?: string;
  name?: string;
  /** Expiry, seconds since the epoch. */
  exp: number;
  /**
   * Who the token is for; unset = this agent. Tokens forwarded to outside MCP
   * servers carry "mcp:<server>" so the agent never accepts them back, and
   * storage tokens "storage".
   */
  aud?: string;
  /** Storage and memory tokens: the outside service acting for the user, e.g. "mcp:lab". */
  via?: string;
  /** Memory tokens: the chat and knowledge node of the run. */
  thread?: string;
  node?: string | null;
}

/** A signed token for `identity`. */
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

/**
 * The principal for a request, or null when login is on and it carries no
 * valid identity. With `storageTokens` (the storage API only), a valid
 * X-Knowledge-Storage token wins over X-Knowledge-User: Claude acting for its
 * user through the outside service it names (`via`).
 */
export async function identify(
  req: Pick<IncomingMessage, "headers">,
  storage: Storage,
  actor: Principal["actor"] = "user",
  { storageTokens = false } = {},
): Promise<Principal | null> {
  const secret = storage.config.authSecret;
  if (!secret) return { userId: await storage.access.localUserId(), actor };
  const storageHeader = storageTokens ? req.headers[STORAGE_HEADER] : undefined;
  if (storageHeader !== undefined) {
    const identity =
      typeof storageHeader === "string"
        ? verifyIdentity(storageHeader, secret, Date.now(), STORAGE_AUDIENCE)
        : null;
    if (!identity || typeof identity.via !== "string" || !identity.via) return null;
    return { userId: await userFor(storage, identity), actor: "agent", via: identity.via };
  }
  const header = req.headers[IDENTITY_HEADER];
  const identity = typeof header === "string" ? verifyIdentity(header, secret) : null;
  if (!identity) return null;
  return { userId: await userFor(storage, identity), actor };
}

const userFor = (storage: Storage, identity: Identity) =>
  storage.access.userForSubject(identity.sub, { email: identity.email, name: identity.name });

/** What an X-Knowledge-Memory token lets an outside server do: the user's memory in one chat. */
export interface MemoryGrant {
  userId: string;
  via: string;
  thread: string;
  node: string | null;
}

const UUID = /^[0-9a-f-]{36}$/i;

/**
 * Without login there is nothing to sign with, and every request is the local
 * user's anyway: the memory "token" is `local.<base64url JSON>` with the same
 * claims, and only accepted then.
 */
export function localMemoryToken(claims: { via: string; thread: string; node: string | null }): string {
  return `local.${Buffer.from(JSON.stringify(claims)).toString("base64url")}`;
}

/** The memory grant an X-Knowledge-Memory header carries, or null when it carries none. */
export async function identifyMemory(req: Pick<IncomingMessage, "headers">, storage: Storage): Promise<MemoryGrant | null> {
  const header = req.headers[MEMORY_HEADER];
  if (typeof header !== "string") return null;
  const secret = storage.config.authSecret;
  let claims: Partial<Identity> | null = null;
  if (secret) {
    claims = verifyIdentity(header, secret, Date.now(), MEMORY_AUDIENCE);
  } else if (header.startsWith("local.")) {
    try {
      claims = JSON.parse(Buffer.from(header.slice("local.".length), "base64url").toString("utf8")) as Partial<Identity>;
    } catch {
      return null;
    }
  }
  if (!claims || typeof claims.via !== "string" || !claims.via || typeof claims.thread !== "string" || !claims.thread) return null;
  const node = typeof claims.node === "string" && UUID.test(claims.node) ? claims.node : null;
  const userId = secret ? await userFor(storage, claims as Identity) : await storage.access.localUserId();
  return { userId, via: claims.via, thread: claims.thread, node };
}
