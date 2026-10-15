/**
 * Runs once when the server starts: incomplete login settings stop it here
 * instead of on the first request (shared/auth-mode.ts, issue #64).
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { authSettings, checkOidcSettings } = await import("../shared/auth-mode");
  const { mode } = authSettings();
  if (mode === "oidc") checkOidcSettings();
  console.log(`[auth] ${mode === "oidc" ? "sign-in with OpenID Connect" : "no login (local mode)"}`);
}
