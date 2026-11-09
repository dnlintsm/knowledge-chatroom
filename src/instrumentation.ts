/**
 * Runs once when the server starts: incomplete login settings stop it here
 * instead of on the first request (packages/contracts/src/auth-mode.ts, issue #64).
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { authSettings, checkOidcSettings } = await import("@knowledge-chatroom/contracts/auth-mode");
  const { mode } = authSettings();
  if (mode === "oidc") checkOidcSettings();
}
