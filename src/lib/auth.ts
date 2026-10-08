import { createHmac, timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";
import * as oidc from "openid-client";

/**
 * Login, for deployments that set AUTH_SECRET (the agent server must have the
 * same value). Users sign in with any OpenID Connect provider (Keycloak,
 * Authentik, Google, Entra ID, ...), and the app keeps who they are in a
 * signed cookie. Every request it forwards to the agent server carries a
 * short-lived signed X-Knowledge-User header (agent/src/storage/identity.ts
 * checks it), so the agent knows whose access rules apply.
 *
 * Without AUTH_SECRET there is no login and everyone is the local user.
 */

export const SESSION_COOKIE = "kc_session";
export const LOGIN_COOKIE = "kc_login";
export const IDENTITY_HEADER = "x-knowledge-user";

const SESSION_SECONDS = 7 * 24 * 3600;
const LOGIN_SECONDS = 10 * 60;
// Long enough for one request to the agent, short enough to be useless if logged.
const HEADER_SECONDS = 5 * 60;

export interface SessionUser {
  /** "<issuer>|<subject>": stable per person and provider. */
  sub: string;
  email?: string;
  name?: string;
}

export function authSecret(): string | null {
  const secret = process.env.AUTH_SECRET;
  if (!secret) return null;
  if (secret.length < 32) {
    throw new Error("AUTH_SECRET must be at least 32 characters (e.g. openssl rand -hex 32)");
  }
  return secret;
}

const now = () => Math.floor(Date.now() / 1000);
const b64 = (data: Buffer | string) => Buffer.from(data).toString("base64url");
const mac = (secret: string, data: string) => createHmac("sha256", secret).update(data).digest();

/**
 * `<kind>.<payload>.<hmac>`. The kind is signed too, so a cookie can't be
 * replayed as an identity header or the other way around.
 */
function seal(kind: string, data: object, secret: string): string {
  const body = `${kind}.${b64(JSON.stringify(data))}`;
  return `${body}.${b64(mac(secret, body))}`;
}

function unseal<T extends { exp: number }>(kind: string, token: string | undefined, secret: string): T | null {
  const parts = token?.split(".") ?? [];
  if (parts.length !== 3 || parts[0] !== kind) return null;
  const expected = mac(secret, `${parts[0]}.${parts[1]}`);
  const given = Buffer.from(parts[2], "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const data = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as T;
    return typeof data.exp === "number" && data.exp > now() ? data : null;
  } catch {
    return null;
  }
}

export function readSession(cookie: string | undefined): SessionUser | null {
  const secret = authSecret();
  if (!secret) return null;
  const data = unseal<SessionUser & { exp: number }>("s1", cookie, secret);
  return data && typeof data.sub === "string" && data.sub
    ? { sub: data.sub, email: data.email, name: data.name }
    : null;
}

export const sessionFrom = (req: NextRequest) => readSession(req.cookies.get(SESSION_COOKIE)?.value);

/** The X-Knowledge-User value for a request made for `user`. */
export function identityHeader(user: SessionUser): string {
  return seal("v1", { ...user, exp: now() + HEADER_SECONDS }, authSecret()!);
}

/** The origin users reach the app at; set APP_URL when behind a proxy. */
export function appUrl(req: NextRequest): string {
  return (process.env.APP_URL || req.nextUrl.origin).replace(/\/+$/, "");
}

const cookieOptions = (req: NextRequest, maxAge: number, path = "/") => ({
  httpOnly: true,
  sameSite: "lax" as const,
  secure: appUrl(req).startsWith("https:"),
  path,
  maxAge,
});

export const sessionCookie = (req: NextRequest, user: SessionUser) => ({
  name: SESSION_COOKIE,
  value: seal("s1", { ...user, exp: now() + SESSION_SECONDS }, authSecret()!),
  ...cookieOptions(req, SESSION_SECONDS),
});

// The login cookie only goes to /api/auth, where the callback reads it.
export const loginCookie = (req: NextRequest, data: LoginState) => ({
  name: LOGIN_COOKIE,
  value: seal("l1", { ...data, exp: now() + LOGIN_SECONDS }, authSecret()!),
  ...cookieOptions(req, LOGIN_SECONDS, "/api/auth"),
});

export const clearCookie = (req: NextRequest, name: string, path = "/") => ({
  name,
  value: "",
  ...cookieOptions(req, 0, path),
});

/** What the callback needs to finish a sign-in this browser started. */
export interface LoginState {
  verifier: string;
  state: string;
  nonce: string;
  returnTo: string;
}

export const readLogin = (req: NextRequest) =>
  unseal<LoginState & { exp: number }>("l1", req.cookies.get(LOGIN_COOKIE)?.value, authSecret()!);

/** Only paths on this app, so a link can't send users elsewhere after login. */
export function safeReturnTo(value: string | null): string {
  return value && value.startsWith("/") && !value.startsWith("//") && !value.startsWith("/\\")
    ? value
    : "/";
}

let provider: Promise<oidc.Configuration> | null = null;

/** The provider's settings, discovered once from OIDC_ISSUER. */
export function oidcConfig(): Promise<oidc.Configuration> {
  const issuer = process.env.OIDC_ISSUER;
  const clientId = process.env.OIDC_CLIENT_ID;
  if (!issuer || !clientId) {
    return Promise.reject(
      new Error("Login is on (AUTH_SECRET) but OIDC_ISSUER and OIDC_CLIENT_ID are not set"),
    );
  }
  const secret = process.env.OIDC_CLIENT_SECRET;
  const url = new URL(issuer);
  provider ??= oidc
    .discovery(
      url,
      clientId,
      secret ? { client_secret: secret } : undefined,
      // Without a secret this is a public client; PKCE protects the code.
      secret ? undefined : oidc.None(),
      // Plain http only for a provider on this machine (development).
      url.protocol === "http:" ? { execute: [oidc.allowInsecureRequests] } : undefined,
    )
    .catch((err) => {
      provider = null;
      throw err;
    });
  return provider;
}

/** The person a finished sign-in names. */
export function userFromClaims(claims: oidc.IDToken): SessionUser {
  const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
  return {
    sub: `${claims.iss}|${claims.sub}`,
    email: str(claims.email),
    name: str(claims.name) ?? str(claims.preferred_username) ?? str(claims.email),
  };
}
