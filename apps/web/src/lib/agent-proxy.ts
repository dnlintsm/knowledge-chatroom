import type { NextRequest } from "next/server";

import { localAgentUrl } from "./agent-target";
import { IDENTITY_HEADER, authSecret, identityHeader, sessionFrom } from "./auth";

/**
 * Forwards a route group to this repo's API server (services/api-py/api_py/storage_routes.py)
 * at LOCAL_AGENT_URL, also when the chat goes to a remote backend (AGENT_URL),
 * so the browser talks to one origin and the agent port stays private.
 * Responses stream through, which carries the /files?watch change stream too.
 * With login on, each request says who it is for (see ./auth.ts).
 */

const LOCAL_AGENT_URL = localAgentUrl();

// x-knowledge-workspace: the workspace the page is in (src/lib/workspace-request.ts),
// which the API server checks the user belongs to.
// if-match: a save names the version it replaces, so it can't overwrite someone else's.
const FORWARDED_REQUEST_HEADERS = ["accept", "content-type", "if-none-match", "if-match", "x-knowledge-workspace"];
const FORWARDED_RESPONSE_HEADERS = [
  "content-type",
  "content-length",
  "etag",
  "last-modified",
  "x-file-author",
  "cache-control",
  // Skill .zip exports download under the skill's name.
  "content-disposition",
  // Binary downloads may redirect to a signed object-store link.
  "location",
  // Stored files opened as pages stay sandboxed (services/api-py/api_py/storage_routes.py).
  "content-security-policy",
  "x-content-type-options",
];

// A pipeline's key (docs/pipeline-identities.md), forwarded to the API server, which looks it up.
export const PIPELINE_HEADER = "x-knowledge-pipeline";
const PIPELINE_KEY = /^Bearer\s+(kcp_\S+)$/i;

/** The pipeline key a request carries as `Authorization: Bearer kcp_...`, if any. */
export function pipelineKey(req: NextRequest): string | null {
  return PIPELINE_KEY.exec(req.headers.get("authorization") ?? "")?.[1] ?? null;
}

/**
 * A route handler forwarding /api/<prefix>/* to LOCAL_AGENT_URL/<prefix>/*.
 * With `pipelineKeys`, a request may come from a pipeline instead of a
 * session: its key goes on for the API server to check. A browser never
 * sends an Authorization header by itself, so a key can't ride on someone's
 * cookies. Elsewhere a key is refused.
 */
export function agentProxy(prefix: string, { pipelineKeys = false }: { pipelineKeys?: boolean } = {}) {
  return async function proxy(
    req: NextRequest,
    { params }: { params: Promise<{ path?: string[] }> },
  ) {
    const key = pipelineKey(req);
    const user = authSecret() ? sessionFrom(req) : null;
    if (key !== null) {
      if (!pipelineKeys) {
        return Response.json(
          { error: "Pipeline keys reach only /api/files, /api/nodes, /api/experiments, /api/runs, /api/search and /api/proposals" },
          { status: 401 },
        );
      }
      if (user) {
        return Response.json({ error: "Send a pipeline key or sign in, not both" }, { status: 400 });
      }
    } else if (authSecret() && !user) {
      return Response.json({ error: "Sign in first" }, { status: 401 });
    }
    const { path = [] } = await params;
    const target = new URL(
      `${LOCAL_AGENT_URL}/${prefix}/${path.map(encodeURIComponent).join("/")}`,
    );
    target.search = req.nextUrl.search;

    const headers = new Headers();
    for (const name of FORWARDED_REQUEST_HEADERS) {
      const value = req.headers.get(name);
      if (value) headers.set(name, value);
    }
    if (key !== null) headers.set(PIPELINE_HEADER, key);
    else if (user) headers.set(IDENTITY_HEADER, identityHeader(user));

    let upstream: Response;
    try {
      upstream = await fetch(target, {
        method: req.method,
        headers,
        body: ["GET", "HEAD", "DELETE"].includes(req.method)
          ? undefined
          : await req.arrayBuffer(),
        cache: "no-store",
        // Hand redirects to the browser instead of fetching the target here.
        redirect: "manual",
        // Closing the browser's request (e.g. an EventSource) closes ours.
        signal: req.signal,
      });
    } catch {
      return Response.json({ error: "API server unreachable" }, { status: 502 });
    }

    const out = new Headers();
    for (const name of FORWARDED_RESPONSE_HEADERS) {
      const value = upstream.headers.get(name);
      if (value) out.set(name, value);
    }
    return new Response(upstream.body, { status: upstream.status, headers: out });
  };
}
