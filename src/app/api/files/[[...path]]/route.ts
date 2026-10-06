import type { NextRequest } from "next/server";

/**
 * Forwards /api/files/* to the agent server's file API (agent/src/storage),
 * so the browser talks to one origin and the agent port stays private.
 */

const AGENT_URL = (process.env.AGENT_URL || "http://localhost:8000").replace(
  /\/+$/,
  "",
);

const FORWARDED_REQUEST_HEADERS = ["content-type", "if-none-match"];
const FORWARDED_RESPONSE_HEADERS = [
  "content-type",
  "content-length",
  "etag",
  "last-modified",
  "x-file-author",
  "cache-control",
];

async function proxy(
  req: NextRequest,
  { params }: { params: Promise<{ path?: string[] }> },
) {
  const { path = [] } = await params;
  const target = new URL(
    `${AGENT_URL}/files/${path.map(encodeURIComponent).join("/")}`,
  );
  target.search = req.nextUrl.search;

  const headers = new Headers();
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = req.headers.get(name);
    if (value) headers.set(name, value);
  }

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: req.method,
      headers,
      body: req.method === "PUT" ? await req.arrayBuffer() : undefined,
      cache: "no-store",
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
}

export { proxy as GET, proxy as PUT, proxy as DELETE };
