import { NextResponse, type NextRequest } from "next/server";

import { SESSION_COOKIE, clearCookie } from "@/lib/auth";

/**
 * Signs out of this app. The login provider may still remember the user, so
 * this shows a page instead of sending them straight back into a sign-in.
 */
export async function POST(req: NextRequest) {
  const res = new NextResponse(
    `<!doctype html><meta charset="utf-8"><title>Signed out</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>body{font:15px system-ui,sans-serif;display:grid;place-items:center;height:90vh;margin:0}</style>
<main><p>You're signed out.</p><p><a href="/api/auth/login">Sign in again</a></p></main>`,
    { headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
  res.cookies.set(clearCookie(req, SESSION_COOKIE));
  return res;
}
