/**
 * The chat's "+" menu of outside tools, and calls to them from the app's
 * buttons (issue #151). The servers come from MCP_SERVERS (./mcp.ts); only
 * those with a `ui` block show up here.
 *
 *   GET  /tools                     {tools: [{server, label, chip, description,
 *                                   icon, mode, callable}]}: the "+" menu
 *   POST /tools/<server>/<tool>     {arguments} → {result, text} or 4xx/502
 *                                   {error}: one call of a tool in that
 *                                   server's ui.tools, as the signed-in user
 *
 * A call goes to the server like a chat run's: with the user's identity
 * (forwardIdentity) and a storage token (storageAccess), so the server sees
 * the same person whether Claude or a button asked. With AGENT_URL set this
 * server still answers these routes: the menu and buttons work with a remote
 * chat backend too.
 *
 * services/api-py/api_py/tools.py serves these routes too (issue #190, step
 * 7b) when api-py has MCP_SERVERS; keep the two in step.
 */

import type http from "node:http";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import { serverConfigs, type ExternalServers, type RunTokens } from "./mcp";

const CALL_TIMEOUT_MS = Number.parseInt(process.env.TOOLS_CALL_TIMEOUT_MS || "120000", 10);
const MAX_BODY_BYTES = 64 * 1024;

export interface ToolMenuItem {
  server: string;
  label: string;
  chip: string;
  description: string | null;
  icon: string | null;
  mode: "auto" | "manual";
  /** Tools the app may call with POST /tools/<server>/<tool>. */
  callable: string[];
}

export function toolMenu(servers: ExternalServers): ToolMenuItem[] {
  return Object.entries(servers).flatMap(([server, { ui }]) =>
    ui
      ? [{ server, label: ui.label, chip: ui.chip, description: ui.description, icon: ui.icon, mode: ui.mode, callable: ui.tools }]
      : [],
  );
}

/** What a tool call answered: its structured content (or the JSON in its text), and its text. */
export interface ToolCallAnswer {
  result: unknown;
  text: string;
  isError: boolean;
}

/** Calls one tool of one server; the default transport for http/sse configs. */
export type CallTool = (server: string, tool: string, args: Record<string, unknown>, tokens?: RunTokens) => Promise<ToolCallAnswer>;

export function mcpCaller(servers: ExternalServers): CallTool {
  return async (server, tool, args, tokens) => {
    const config = serverConfigs({ [server]: servers[server] }, tokens)[server];
    if (config.type !== "http" && config.type !== "sse") throw new Error(`${server} isn't an http or sse server`);
    const init = { headers: config.headers ?? {} };
    const transport: Transport =
      config.type === "sse"
        ? new SSEClientTransport(new URL(config.url), { requestInit: init, eventSourceInit: { fetch: withHeaders(init.headers) } })
        : new StreamableHTTPClientTransport(new URL(config.url), { requestInit: init });
    const client = new Client({ name: "knowledge-chatroom", version: "1.0.0" });
    try {
      await client.connect(transport, { timeout: CALL_TIMEOUT_MS });
      const answer = await client.callTool({ name: tool, arguments: args }, undefined, { timeout: CALL_TIMEOUT_MS });
      const blocks = Array.isArray(answer.content) ? answer.content : [];
      const text = blocks
        .map((block) => (block && typeof block === "object" && block.type === "text" ? String(block.text) : ""))
        .filter(Boolean)
        .join("\n");
      return { result: answer.structuredContent ?? parseJson(text), text, isError: answer.isError === true };
    } finally {
      await client.close().catch(() => {});
    }
  };
}

function withHeaders(headers: Record<string, string>) {
  return (url: string | URL, init?: RequestInit) =>
    fetch(url, { ...init, headers: { ...(init?.headers as Record<string, string> | undefined), ...headers } });
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function json(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) return undefined;
    chunks.push(chunk as Buffer);
  }
  try {
    return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf-8")) : {};
  } catch {
    return undefined;
  }
}

/** The path's parts after /tools, or null when one has a malformed %-escape. */
function decodePath(pathname: string): string[] | null {
  try {
    return pathname.split("/").slice(2).map(decodeURIComponent);
  } catch {
    return null;
  }
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The /tools routes. `tokens` signs the request's user for a server (null
 * after answering 401 when the request isn't signed in, as `signedIn` does).
 */
export function createToolsHandler(
  servers: ExternalServers,
  tokens: (req: http.IncomingMessage, res: http.ServerResponse) => RunTokens | undefined | null,
  call: CallTool = mcpCaller(servers),
) {
  const menu = toolMenu(servers);
  return async (req: http.IncomingMessage, res: http.ServerResponse, url: URL) => {
    const parts = decodePath(url.pathname);
    if (!parts) return json(res, 400, { error: "Bad path" });
    const [server, tool, ...extra] = parts;
    if (!server) {
      if (req.method !== "GET") return json(res, 405, { error: "Method not allowed" });
      if (tokens(req, res) === null) return;
      return json(res, 200, { tools: menu });
    }
    if (!tool || extra.length) return json(res, 404, { error: "Not found" });
    if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" });
    const ui = servers[server]?.ui;
    if (!ui) return json(res, 404, { error: `No tool server ${JSON.stringify(server)} in the menu` });
    if (!ui.tools.includes(tool)) {
      return json(res, 403, { error: `${tool} isn't one of ${server}'s tools the app may call (ui.tools)` });
    }
    const signed = tokens(req, res);
    if (signed === null) return;
    const body = await readJson(req);
    const args = record(body) ? (body.arguments ?? {}) : undefined;
    if (!record(args)) return json(res, 400, { error: "Expected {arguments: {...}}" });
    try {
      const answer = await call(server, tool, args, signed);
      if (answer.isError) {
        // Python MCP servers prefix their errors; the user only needs the reason.
        const reason = answer.text.replace(/^Error executing tool [\w-]+: /, "");
        return json(res, 422, { error: reason || `${tool} failed` });
      }
      return json(res, 200, { result: answer.result, text: answer.text });
    } catch (err) {
      console.error(`[tools] ${server}/${tool}: ${err instanceof Error ? err.message : err}`);
      return json(res, 502, { error: `${ui.label} isn't reachable right now` });
    }
  };
}
