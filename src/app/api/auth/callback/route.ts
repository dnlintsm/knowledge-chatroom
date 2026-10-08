import { NextResponse, type NextRequest } from "next/server";
import * as oidc from "openid-client";

import {
  LOGIN_COOKIE,
  appUrl,
  authSecret,
  clearCookie,
  oidcConfig,
  readLogin,
  sessionCookie,
  userFromClaims,
} from "@/lib/auth";

const retry = (message: string, status = 400) =>
  new NextResponse(
    `<!doctype html><meta charset="utf-8"><title>Sign-in failed</title>
<p>${message.replace(/[<>&"]/g, (c) => `&#${c.charCodeAt(0)};`)}</p>
<p><a href="/api/auth/login">Try again</a></p>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );

/** The provider sends the browser back here with a code; trade it for who they are. */
export async function GET(req: NextRequest) {
  if (!authSecret()) return NextResponse.redirect(new URL("/", appUrl(req)));
  const login = readLogin(req);
  if (!login) return retry("This sign-in expired or was started in another browser.");

  // The URL the provider redirected to, as the user's browser saw it.
  const current = new URL(`${appUrl(req)}/api/auth/callback${req.nextUrl.search}`);
  let claims: oidc.IDToken | undefined;
  try {
    const tokens = await oidc.authorizationCodeGrant(await oidcConfig(), current, {
      pkceCodeVerifier: login.verifier,
      expectedState: login.state,
      expectedNonce: login.nonce,
      idTokenExpected: true,
    });
    claims = tokens.claims();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[auth] sign-in failed: ${message}`);
    return retry(`Sign-in failed: ${message}`);
  }
  if (!claims) return retry("The login provider didn't say who you are.");

  const res = NextResponse.redirect(new URL(login.returnTo, appUrl(req)));
  res.cookies.set(sessionCookie(req, userFromClaims(claims)));
  res.cookies.set(clearCookie(req, LOGIN_COOKIE, "/api/auth"));
  return res;
}
