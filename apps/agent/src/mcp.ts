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
 * - memoryAccess (http/sse): in runs where memory is on (MEMORY=on, not
 *   incognito), each run also sends an X-Knowledge-Memory token for that
 *   chat, which the server passes on to the agent's /memory/agent API to
 *   read the user's memory and propose changes to it, as Claude does in the
 *   chat (issue #93). Changes always wait in the user's Memory inbox.
 *
 * - ui (http/sse): shows the server in the chat's "+" menu (issue #151):
 *     "ui": {"label": "Search papers", "chip": "Papers", "icon": "book-open",
 *            "description": "...", "mode": "auto", "tools": ["search_papers"]}
 *   Picking it puts a chip in the message box; while it's on, each run is told
 *   to use this server's tools (forwardedProps.knowledge_chatroom.tools).
 *   mode "auto" (default): Claude has the tools in every run; "manual": only
 *   in runs with the chip on. `tools` lists the tools the app's buttons may
 *   call directly (POST /tools/<server>/<tool>, ./tools-api.ts) for the
 *   signed-in user; the others stay Claude's only.
 *
 * Every tool of a configured server is pre-approved. A server that is down or
 * misconfigured leaves its tools out of the run; the chat carries on.
 */

import { readFileSync } from "node:fs";

import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";

import { IDENTITY_HEADER, MEMORY_HEADER, STORAGE_HEADER } from "./storage/identity";

type Env = Record<string, string | undefined>;

/** How a server shows in the chat's "+" menu (the `ui` block). */
export interface ToolUi {
  label: string;
  /** The chip's text in the message box. */
  chip: string;
  description: string | null;
  /** A lucide icon name, e.g. "book-open"; the app falls back to a wrench. */
  icon: string | null;
  mode: "auto" | "manual";
  /** Tools the app may call directly for the signed-in user. */
  tools: string[];
}

export interface ExternalServer {
  config: McpServerConfig;
  forwardIdentity: boolean;
  storageAccess: boolean;
  memoryAccess: boolean;
  /** Set when the server is in the "+" menu. */
  ui?: ToolUi;
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

const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;

function parseUi(raw: unknown): ToolUi {
  if (!record(raw)) throw new Error("ui must be an object");
  const text = (key: string, max: number): string | null => {
    const value = raw[key];
    if (value === undefined || value === null) return null;
    if (typeof value !== "string" || !value.trim() || value.length > max) {
      throw new Error(`ui.${key} must be a string of at most ${max} characters`);
    }
    return value.trim();
  };
  const label = text("label", 40);
  if (!label) throw new Error("ui needs a label");
  const mode = raw.mode ?? "auto";
  if (mode !== "auto" && mode !== "manual") throw new Error('ui.mode must be "auto" or "manual"');
  const tools = raw.tools ?? [];
  if (!Array.isArray(tools) || !tools.every((t) => typeof t === "string" && TOOL_NAME.test(t))) {
    throw new Error("ui.tools must be a list of tool names");
  }
  return {
    label,
    chip: text("chip", 24) ?? label,
    description: text("description", 200),
    icon: text("icon", 40),
    mode,
    tools: [...new Set(tools as string[])],
  };
}

function parseServer(name: string, raw: unknown, env: Env): ExternalServer {
  if (!NAME.test(name)) throw new Error("names may use letters, digits, _ and - only");
  if (RESERVED.has(name)) throw new Error("that name is the agent's own tool server");
  if (!record(raw)) throw new Error("must be an object");
  const type = raw.type ?? "http";
  const forwardIdentity = raw.forwardIdentity === true;
  const storageAccess = raw.storageAccess === true;
  const memoryAccess = raw.memoryAccess === true;
  if (type === "stdio") {
    if (typeof raw.command !== "string" || !raw.command) throw new Error("stdio needs a command");
    if (raw.args !== undefined && !(Array.isArray(raw.args) && raw.args.every((a) => typeof a === "string"))) {
      throw new Error("args must be a list of strings");
    }
    if (forwardIdentity || storageAccess || memoryAccess || raw.ui !== undefined) {
      throw new Error("forwardIdentity, storageAccess, memoryAccess and ui need an http or sse server");
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
      memoryAccess,
    };
  }
  if (type !== "http" && type !== "sse") throw new Error(`unknown type ${JSON.stringify(type)}`);
  if (typeof raw.url !== "string" || !/^https?:\/\//.test(raw.url)) {
    throw new Error("needs an http(s) url");
  }
  const headers = strings(raw.headers, env, `${name}.headers`);
  for (const header of [IDENTITY_HEADER, STORAGE_HEADER, MEMORY_HEADER]) {
    if (headers && Object.keys(headers).some((h) => h.toLowerCase() === header)) {
      throw new Error(`${header} is set by the agent (forwardIdentity, storageAccess, memoryAccess)`);
    }
  }
  const ui = raw.ui === undefined ? undefined : parseUi(raw.ui);
  return {
    // alwaysLoad: the agent has no tool search, so tools must not be deferred.
    config: { type, url: raw.url, ...(headers ? { headers } : {}), alwaysLoad: true },
    forwardIdentity,
    storageAccess,
    memoryAccess,
    ...(ui && { ui }),
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

/**
 * Signs the run's user for one server: its identity, a storage token, or a
 * memory token; null when the run has none of that kind (no login; memory
 * off in this chat).
 */
export type RunTokens = (server: string, kind?: "identity" | "storage" | "memory") => string | null;

/**
 * The SDK configs for one run: servers with forwardIdentity carry the run's
 * user, signed for that server, those with storageAccess a storage token and
 * those with memoryAccess a memory token, when the run has them.
 */
export function serverConfigs(
  servers: ExternalServers,
  tokens?: RunTokens,
): Record<string, McpServerConfig> {
  return Object.fromEntries(
    Object.entries(servers).map(([name, { config, forwardIdentity, storageAccess, memoryAccess }]) => {
      if (!tokens || (config.type !== "http" && config.type !== "sse")) return [name, config];
      const wanted: [string, boolean, "identity" | "storage" | "memory"][] = [
        [IDENTITY_HEADER, forwardIdentity, "identity"],
        [STORAGE_HEADER, storageAccess, "storage"],
        [MEMORY_HEADER, memoryAccess, "memory"],
      ];
      const added: Record<string, string> = {};
      for (const [header, on, kind] of wanted) {
        const token = on ? tokens(name, kind) : null;
        if (token) added[header] = token;
      }
      return [name, Object.keys(added).length ? { ...config, headers: { ...config.headers, ...added } } : config];
    }),
  );
}

/**
 * The chips the user has on in this chat: forwardedProps.knowledge_chatroom.tools
 * (apps/web/src/lib/chatroom-props.ts), kept to servers that are in the "+" menu. The
 * browser says it; a chip only steers Claude toward tools the run may use anyway.
 */
export function chipsFrom(forwardedProps: unknown, servers: ExternalServers): string[] {
  const place = record(forwardedProps) ? forwardedProps.knowledge_chatroom : undefined;
  const tools = record(place) ? place.tools : undefined;
  if (!Array.isArray(tools)) return [];
  return [...new Set(tools.filter((name): name is string => typeof name === "string" && Boolean(servers[name]?.ui)))];
}

interface ChipOptions {
  systemPrompt?: unknown;
  mcpServers?: Record<string, unknown>;
  allowedTools?: string[];
}

/**
 * A run's options with the chat's chips applied: each chip adds a line to the
 * prompt, and "manual" servers without their chip leave the run.
 */
export function withToolChips<T extends ChipOptions>(options: T, chips: string[], servers: ExternalServers): T {
  const off = Object.entries(servers)
    .filter(([name, server]) => server.ui?.mode === "manual" && !chips.includes(name))
    .map(([name]) => name);
  if (!chips.length && !off.length) return options;
  const lines = chips.map((name) => {
    const ui = servers[name].ui!;
    return `- The user turned on "${ui.chip}" (${ui.label}) for this chat: answer with the mcp__${name}__ tools, and say so if they find nothing.`;
  });
  const prompt = typeof options.systemPrompt === "string" || options.systemPrompt === undefined;
  return {
    ...options,
    ...(lines.length && prompt && { systemPrompt: `${(options.systemPrompt as string | undefined) ?? ""}\n${lines.join("\n")}` }),
    ...(off.length && {
      mcpServers: Object.fromEntries(Object.entries(options.mcpServers ?? {}).filter(([name]) => !off.includes(name))),
      allowedTools: (options.allowedTools ?? []).filter((rule) => !off.some((name) => rule === allowServer(name) || rule.startsWith(`${allowServer(name)}__`))),
    }),
  };
}
