/**
 * Whether people sign in, decided the same way by the Next.js app and the
 * agent (issue #64). AUTH_MODE picks it:
 *
 * - `oidc`: sign in with an OpenID Connect provider; needs AUTH_SECRET.
 * - `local`: no login; one built-in user owns everything (demos, development).
 *
 * Left unset, AUTH_SECRET still means `oidc`. Without it, development runs as
 * `local`, but production (NODE_ENV=production) refuses to start, so a missing
 * secret can't quietly turn login off.
 */

export type AuthMode = "oidc" | "local";

export interface AuthSettings {
  mode: AuthMode;
  /** Set exactly when mode is `oidc`. */
  secret?: string;
}

type Env = Record<string, string | undefined>;

const SECRET_HINT = "(at least 32 characters, e.g. openssl rand -hex 32)";

export function authSettings(env: Env = process.env): AuthSettings {
  const requested = env.AUTH_MODE?.trim().toLowerCase() || undefined;
  const secret = env.AUTH_SECRET || undefined;
  if (requested && requested !== "oidc" && requested !== "local") {
    throw new Error(`AUTH_MODE must be "oidc" or "local", not "${env.AUTH_MODE}"`);
  }
  if (secret && secret.length < 32) throw new Error(`AUTH_SECRET is too short ${SECRET_HINT}`);

  if (requested === "local") {
    if (secret) {
      throw new Error("AUTH_MODE=local turns login off, so AUTH_SECRET must not be set; use AUTH_MODE=oidc for login");
    }
    return { mode: "local" };
  }
  if (secret) return { mode: "oidc", secret };
  if (requested === "oidc") throw new Error(`AUTH_MODE=oidc needs AUTH_SECRET ${SECRET_HINT}`);
  if (env.NODE_ENV === "production") {
    throw new Error(
      "Login is not configured. Set AUTH_MODE=oidc with AUTH_SECRET and OIDC_* for sign-in, " +
        "or AUTH_MODE=local to run without login (everyone is one user)",
    );
  }
  return { mode: "local" };
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Whether plain http is acceptable for `url`: only on this machine, or
 * anywhere when AUTH_ALLOW_HTTP=true (development and tests only).
 */
export function httpAllowed(url: URL, env: Env = process.env): boolean {
  if (url.protocol === "https:") return true;
  if (url.protocol !== "http:") return false;
  return LOOPBACK.has(url.hostname) || url.hostname.endsWith(".localhost") || env.AUTH_ALLOW_HTTP === "true";
}

/**
 * The settings sign-in needs, checked up front: an OIDC provider and, in
 * production, the APP_URL users reach the app at. Both must use https unless
 * httpAllowed() says otherwise.
 */
export function checkOidcSettings(env: Env = process.env): void {
  const problems: string[] = [];
  if (!env.OIDC_ISSUER) problems.push("OIDC_ISSUER is not set");
  if (!env.OIDC_CLIENT_ID) problems.push("OIDC_CLIENT_ID is not set");
  const urls: [string, string | undefined][] = [["OIDC_ISSUER", env.OIDC_ISSUER], ["APP_URL", env.APP_URL]];
  if (!env.APP_URL && env.NODE_ENV === "production") problems.push("APP_URL is not set");
  for (const [name, value] of urls) {
    if (!value) continue;
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      problems.push(`${name} is not a URL`);
      continue;
    }
    if (!httpAllowed(url, env)) {
      problems.push(`${name} must use https (http only for localhost, or with AUTH_ALLOW_HTTP=true in development)`);
    }
  }
  if (problems.length) throw new Error(`Login is on (AUTH_MODE=oidc) but ${problems.join("; ")}`);
}
