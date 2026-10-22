/**
 * Outside MCP servers the agent connects to beside its own tools, e.g. a
 * Python FastMCP server holding tools from an existing agent (issue #60).
 *
 * MCP_SERVERS is JSON, or a path to a JSON file, in the shape of Claude's
 * .mcp.json: `{"mcpServers": {"<name>": {...}}}` (the bare map works too).
 *
 *   {"mcpServers": {
 *     "lab": {"url": "http://lab-tools:9000/mcp", "forwardIdentity": true},
 *     "local": {"type": "stdio", "command": "python", "args": ["tools.py"]}
 *   }}
 *
 * - type: "http" (default), "sse" or "stdio".
 * - headers / env: values may use ${VAR} to take secrets from the agent's
 *   environment instead of writing them into the config.
 * - forwardIdentity (http/sse): each run sends the signed-in user as an
 *   X-Knowledge-User header so the server can tell who is calling. Verify it
 *   with AUTH_SECRET as in ./storage/identity.ts and check `aud` is
 *   "mcp:<name>": it is signed for that server only, and the agent refuses it.
 *   Without login there is no header and the run is the local user's.
 * - storageAccess (http/sse): each run also sends an X-Knowledge-Storage
 *   token, which the server passes on unchanged to the storage API (the agent
 *   server's /files, /nodes, ...) to read and write files as Claude acting for
 *   that user (issue #88): only what the user can reach, node writes as
 *   proposals, recorded as Claude's via "mcp:<name>". Only the storage API
 *   accepts it.
 *
 * Every tool of a configured server is pre-approved. A server that is down or
 * misconfigured leaves its tools out of the run; the chat carries on.
 */

import { readFileSync } from "node:fs";

import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";

import { IDENTITY_HEADER, STORAGE_HEADER } from "./storage/identity";

type Env = Record<string, string | undefined>;

export interface ExternalServer {
  config: McpServerConfig;
  forwardIdentity: boolean;
  storageAccess: boolean;
}

export type ExternalServers = Record<string, ExternalServer>;

/** Names the agent's own tool server already uses. */
const RESERVED = new Set(["copilotkit"]);
const NAME = /^[A-Za-z0-9_-]{1,64}$/;

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** `${VAR}` → the agent's environment value (empty when unset, with a warning). */
function expand(value: string, env: Env, where: string): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => {
    const found = env[name];
    if (found === undefined) console.warn(`[mcp] ${where} uses \${${name}}, which isn't set`);
    return found ?? "";
  });
}

function strings(value: unknown, env: Env, where: string): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!record(value) || Object.values(value).some((v) => typeof v !== "string")) {
    throw new Error(`${where} must map names to strings`);
  }
  return Object.fromEntries(
    Object.entries(value).map(([k, v]) => [k, expand(v as string, env, `${where}.${k}`)]),
  );
}

function parseServer(name: string, raw: unknown, env: Env): ExternalServer {
  if (!NAME.test(name)) throw new Error("names may use letters, digits, _ and - only");
  if (RESERVED.has(name)) throw new Error("that name is the agent's own tool server");
  if (!record(raw)) throw new Error("must be an object");
  const type = raw.type ?? "http";
  const forwardIdentity = raw.forwardIdentity === true;
  const storageAccess = raw.storageAccess === true;
  if (type === "stdio") {
    if (typeof raw.command !== "string" || !raw.command) throw new Error("stdio needs a command");
    if (raw.args !== undefined && !(Array.isArray(raw.args) && raw.args.every((a) => typeof a === "string"))) {
      throw new Error("args must be a list of strings");
    }
    if (forwardIdentity || storageAccess) {
      throw new Error("forwardIdentity and storageAccess need an http or sse server");
    }
    const envVars = strings(raw.env, env, `${name}.env`);
    return {
      config: {
        type: "stdio",
        command: raw.command,
        ...(raw.args ? { args: raw.args as string[] } : {}),
        ...(envVars ? { env: envVars } : {}),
      },
      forwardIdentity,
      storageAccess,
    };
  }
  if (type !== "http" && type !== "sse") throw new Error(`unknown type ${JSON.stringify(type)}`);
  if (typeof raw.url !== "string" || !/^https?:\/\//.test(raw.url)) {
    throw new Error("needs an http(s) url");
  }
  const headers = strings(raw.headers, env, `${name}.headers`);
  for (const header of [IDENTITY_HEADER, STORAGE_HEADER]) {
    if (headers && Object.keys(headers).some((h) => h.toLowerCase() === header)) {
      throw new Error(`${header} is set by the agent (forwardIdentity, storageAccess)`);
    }
  }
  return {
    // alwaysLoad: the agent has no tool search, so tools must not be deferred.
    config: { type, url: raw.url, ...(headers ? { headers } : {}), alwaysLoad: true },
    forwardIdentity,
    storageAccess,
  };
}

/** The configured servers; bad entries are logged and left out. */
export function externalServersFromEnv(env: Env = process.env): ExternalServers {
  const setting = env.MCP_SERVERS?.trim();
  if (!setting) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(setting.startsWith("{") ? setting : readFileSync(setting, "utf8"));
  } catch (err) {
    console.error(`[mcp] MCP_SERVERS isn't readable JSON; no outside MCP servers: ${err instanceof Error ? err.message : err}`);
    return {};
  }
  const map = record(parsed) && record(parsed.mcpServers) ? parsed.mcpServers : parsed;
  if (!record(map)) {
    console.error("[mcp] MCP_SERVERS must be an object of servers; no outside MCP servers");
    return {};
  }
  const servers: ExternalServers = {};
  for (const [name, raw] of Object.entries(map)) {
    try {
      servers[name] = parseServer(name, raw, env);
    } catch (err) {
      console.error(`[mcp] skipping MCP server ${JSON.stringify(name)}: ${err instanceof Error ? err.message : err}`);
    }
  }
  return servers;
}

/** Permission rule that approves every tool of a server. */
export const allowServer = (name: string) => `mcp__${name}`;

/** Signs the run's user for one server: its identity, or (storage) a storage token. */
export type RunTokens = (server: string, kind?: "identity" | "storage") => string;

/**
 * The SDK configs for one run: servers with forwardIdentity carry the run's
 * user, signed for that server, and those with storageAccess a storage token,
 * when the run has a user.
 */
export function serverConfigs(
  servers: ExternalServers,
  tokens?: RunTokens,
): Record<string, McpServerConfig> {
  return Object.fromEntries(
    Object.entries(servers).map(([name, { config, forwardIdentity, storageAccess }]) => {
      if (!tokens || (config.type !== "http" && config.type !== "sse")) return [name, config];
      const added = {
        ...(forwardIdentity ? { [IDENTITY_HEADER]: tokens(name, "identity") } : {}),
        ...(storageAccess ? { [STORAGE_HEADER]: tokens(name, "storage") } : {}),
      };
      return [name, Object.keys(added).length ? { ...config, headers: { ...config.headers, ...added } } : config];
    }),
  );
}
