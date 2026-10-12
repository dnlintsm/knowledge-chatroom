import { randomBytes, timingSafeEqual } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { pipeline, Readable } from "node:stream";

/**
 * Keeps the server's Anthropic credentials away from skill scripts (step 5).
 * The SDK's Bash inherits the SDK's environment, so a run with scripts gets
 * a stand-in key instead: it talks to Anthropic through this proxy on
 * 127.0.0.1, which swaps the stand-in for the real key. Scripts run without
 * network, so even the stand-in is no use to them.
 *
 * (The SDK's own credential scrub, CLAUDE_CODE_SUBPROCESS_ENV_SCRUB, isn't
 * used: it swaps the sandbox settings for its own, which can write to /home,
 * /root, /tmp, /var and more.)
 */

export interface KeyRoute {
  /** ANTHROPIC_BASE_URL for the run. */
  baseUrl: string;
  /** ANTHROPIC_API_KEY for the run: only this proxy accepts it. */
  apiKey: string;
}

/** Headers not passed on: per hop, or recomputed when the body is sent again. */
const DROP = new Set([
  "host",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "content-length",
  "x-api-key",
  "authorization",
  "proxy-authorization",
]);

function upstreamAuth(): Record<string, string> {
  if (process.env.ANTHROPIC_API_KEY) return { "x-api-key": process.env.ANTHROPIC_API_KEY };
  if (process.env.ANTHROPIC_AUTH_TOKEN) return { authorization: `Bearer ${process.env.ANTHROPIC_AUTH_TOKEN}` };
  return {};
}

function same(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Starts a proxy to `upstream` that accepts only `apiKey`; resolves once it listens. */
export async function startKeyProxy(
  upstream = process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com",
): Promise<KeyRoute & { close(): Promise<void> }> {
  const apiKey = `sk-ant-run-${randomBytes(24).toString("hex")}`;
  const base = upstream.replace(/\/+$/, "");
  const server = http.createServer(async (req, res) => {
    const given =
      (req.headers["x-api-key"] as string | undefined) ??
      req.headers.authorization?.replace(/^Bearer\s+/i, "");
    if (!given || !same(given, apiKey)) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "unknown key" } }));
      return;
    }
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(req.headers)) {
        if (value !== undefined && !DROP.has(key)) headers[key] = Array.isArray(value) ? value.join(", ") : value;
      }
      const hasBody = req.method !== "GET" && req.method !== "HEAD";
      const answer = await fetch(base + (req.url ?? "/"), {
        method: req.method,
        headers: { ...headers, ...upstreamAuth() },
        body: hasBody ? Buffer.concat(chunks) : undefined,
      });
      const out: Record<string, string> = {};
      answer.headers.forEach((value, key) => {
        // fetch has already decoded the body.
        if (!DROP.has(key) && key !== "content-encoding") out[key] = value;
      });
      res.writeHead(answer.status, out);
      if (!answer.body) return void res.end();
      // An upstream reset mid-stream ends this response; it must not crash the server.
      pipeline(Readable.fromWeb(answer.body as never), res, (err) => {
        if (err) res.destroy();
      });
    } catch (err) {
      if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: "upstream unreachable" } }));
      console.error(`[skills] key proxy: ${err instanceof Error ? err.message : err}`);
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    apiKey,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

let shared: Promise<KeyRoute> | null = null;

/** The server's one proxy, started on first use. */
export function keyRoute(): Promise<KeyRoute> {
  shared ??= startKeyProxy().catch((err) => {
    shared = null;
    throw err;
  });
  return shared;
}
