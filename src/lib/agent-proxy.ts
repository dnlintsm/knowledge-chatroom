import type { NextRequest } from "next/server";

import { IDENTITY_HEADER, authSecret, identityHeader, sessionFrom } from "./auth";

/**
 * Forwards a route group to the agent server (agent/src/storage/http.ts), so
 * the browser talks to one origin and the agent port stays private. Responses
 * stream through, which carries the /files?watch change stream too. With
 * login on, each request says who it is for (see ./auth.ts).
 */

const AGENT_URL = (process.env.AGENT_URL || "http://localhost:8000").replace(
  /\/+$/,
  "",
);

const FORWARDED_REQUEST_HEADERS = ["accept", "content-type", "if-none-match"];
const FORWARDED_RESPONSE_HEADERS = [
  "content-type",
  "content-length",
  "etag",
  "last-modified",
  "x-file-author",
  "cache-control",
];

/** A route handler forwarding /api/<prefix>/* to AGENT_URL/<prefix>/*. */
export function agentProxy(prefix: string) {
  return async function proxy(
    req: NextRequest,
    { params }: { params: Promise<{ path?: string[] }> },
  ) {
    const user = authSecret() ? sessionFrom(req) : null;
    if (authSecret() && !user) {
      return Response.json({ error: "Sign in first" }, { status: 401 });
    }
    const { path = [] } = await params;
    const target = new URL(
      `${AGENT_URL}/${prefix}/${path.map(encodeURIComponent).join("/")}`,
    );
    target.search = req.nextUrl.search;

    const headers = new Headers();
    for (const name of FORWARDED_REQUEST_HEADERS) {
      const value = req.headers.get(name);
      if (value) headers.set(name, value);
    }
    if (user) headers.set(IDENTITY_HEADER, identityHeader(user));

    let upstream: Response;
    try {
      upstream = await fetch(target, {
        method: req.method,
        headers,
        body: ["GET", "HEAD", "DELETE"].includes(req.method)
          ? undefined
          : await req.arrayBuffer(),
        cache: "no-store",
        // Closing the browser's request (e.g. an EventSource) closes ours.
        signal: req.signal,
      });
    } catch {
      return Response.json({ error: "Agent server unreachable" }, { status: 502 });
    }

    const out = new Headers();
    for (const name of FORWARDED_RESPONSE_HEADERS) {
      const value = upstream.headers.get(name);
      if (value) out.set(name, value);
    }
    return new Response(upstream.body, { status: upstream.status, headers: out });
  };
}
