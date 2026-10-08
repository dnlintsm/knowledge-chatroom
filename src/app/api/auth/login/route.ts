import { NextResponse, type NextRequest } from "next/server";
import * as oidc from "openid-client";

import { appUrl, authSecret, loginCookie, oidcConfig, safeReturnTo } from "@/lib/auth";

/** Starts a sign-in: sends the browser to the login provider. */
export async function GET(req: NextRequest) {
  const returnTo = safeReturnTo(req.nextUrl.searchParams.get("returnTo"));
  if (!authSecret()) return NextResponse.redirect(new URL(returnTo, appUrl(req)));

  let config: oidc.Configuration;
  try {
    config = await oidcConfig();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[auth] login provider unavailable: ${message}`);
    return new NextResponse(`Sign-in is not available: ${message}`, { status: 503 });
  }

  const verifier = oidc.randomPKCECodeVerifier();
  const state = oidc.randomState();
  const nonce = oidc.randomNonce();
  const url = oidc.buildAuthorizationUrl(config, {
    redirect_uri: `${appUrl(req)}/api/auth/callback`,
    scope: "openid email profile",
    code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
    code_challenge_method: "S256",
    state,
    nonce,
  });
  const res = NextResponse.redirect(url);
  res.cookies.set(loginCookie(req, { verifier, state, nonce, returnTo }));
  return res;
}
