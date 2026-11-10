/**
 * Tokens for a remote backend's outside MCP servers (issue #176, step 5).
 *
 * A remote backend's chat agent (AGENT_URL, e.g. services/agent-py) connects
 * to the servers in its own MCP_SERVERS, and forwards the user to them as this
 * agent does (./mcp.ts): an identity token signed for "mcp:<name>"
 * (forwardIdentity), a storage token via "mcp:<name>" (storageAccess) and a
 * memory token via "mcp:<name>" for the chat (memoryAccess). It never holds
 * AUTH_SECRET, so it trades the run's own tokens for them here:
 *
 *   POST /identity/mcp-tokens   {servers: {<name>: ["identity" | "storage" | "memory", ...]}}
 *     with the run's X-Knowledge-Storage (and X-Knowledge-Memory) tokens, both
 *     `via` "remote" as the app makes them, answers {tokens: {<name>: {<kind>: token}}}
 *
 * Each token it makes reaches no further than the one it came from: the same
 * user (and chat), expiring no later, and a server's memory changes always
 * wait in the user's inbox. Tokens made for an outside service (`via`
 * "mcp:...") can't be traded. Without login there are no identity or storage
 * tokens, and memory tokens are the unsigned local form.
 */

import { STORAGE_AUDIENCE } from "@knowledge-chatroom/contracts/identity-token";

import {
  localMemoryToken,
  MEMORY_AUDIENCE,
  MEMORY_HEADER,
  REMOTE_VIA,
  signIdentity,
  STORAGE_HEADER,
  verifyIdentity,
  type Identity,
} from "./storage/identity";

export type TokenKind = "identity" | "storage" | "memory";
const KINDS = new Set<TokenKind>(["identity", "storage", "memory"]);
const NAME = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_SERVERS = 32;
/** As long as the agent's own identity tokens for MCP servers last. */
const IDENTITY_SECONDS = 60 * 60;

type Headers = Record<string, string | string[] | undefined>;
type Answer = { status: number; body: unknown };

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The servers and kinds asked for; null when the body isn't that shape. */
export function parseRequest(body: unknown): Map<string, Set<TokenKind>> | null {
  const servers = record(body) ? body.servers : undefined;
  if (!record(servers) || Object.keys(servers).length > MAX_SERVERS) return null;
  const wanted = new Map<string, Set<TokenKind>>();
  for (const [name, kinds] of Object.entries(servers)) {
    if (!NAME.test(name) || !Array.isArray(kinds) || !kinds.every((k) => KINDS.has(k as TokenKind))) return null;
    wanted.set(name, new Set(kinds as TokenKind[]));
  }
  return wanted;
}

const header = (headers: Headers, name: string) => {
  const value = headers[name];
  return typeof value === "string" ? value : undefined;
};

/** A local memory token's claims, when it is one made for the remote chat agent. */
function localMemory(token: string | undefined): { thread: string; node: string | null } | null {
  if (!token?.startsWith("local.")) return null;
  try {
    const claims = JSON.parse(Buffer.from(token.slice("local.".length), "base64url").toString("utf8")) as Record<string, unknown>;
    if (claims.via !== REMOTE_VIA || typeof claims.thread !== "string" || !claims.thread) return null;
    return { thread: claims.thread, node: typeof claims.node === "string" ? claims.node : null };
  } catch {
    return null;
  }
}

/** Answers POST /identity/mcp-tokens; `secret` is AUTH_SECRET (null without login). */
export function mcpTokens(headers: Headers, body: unknown, secret: string | null, now = Date.now()): Answer {
  const wanted = parseRequest(body);
  if (!wanted) return { status: 400, body: { error: 'Send {servers: {<name>: ["identity" | "storage" | "memory"]}}' } };
  const seconds = Math.floor(now / 1000);
  const tokens: Record<string, Partial<Record<TokenKind, string>>> = {};

  if (!secret) {
    // No login: everyone is the local user, and only memory has a token.
    const memory = localMemory(header(headers, MEMORY_HEADER));
    for (const [name, kinds] of wanted) {
      tokens[name] = memory && kinds.has("memory") ? { memory: localMemoryToken({ via: `mcp:${name}`, ...memory }) } : {};
    }
    return { status: 200, body: { tokens } };
  }

  const storageToken = header(headers, STORAGE_HEADER);
  const storage = storageToken ? verifyIdentity(storageToken, secret, now, STORAGE_AUDIENCE) : null;
  if (!storage || storage.via !== REMOTE_VIA) {
    return { status: 401, body: { error: "This needs the run's X-Knowledge-Storage token, as the app sends it to a remote backend" } };
  }
  const memoryToken = header(headers, MEMORY_HEADER);
  const memory = memoryToken ? verifyIdentity(memoryToken, secret, now, MEMORY_AUDIENCE) : null;
  const chat = memory && memory.via === REMOTE_VIA && memory.sub === storage.sub && memory.thread ? memory : null;
  const user = { sub: storage.sub, email: storage.email, name: storage.name };
  const until = (token: Identity, limit: number) => Math.min(token.exp, seconds + limit);

  for (const [name, kinds] of wanted) {
    const via = `mcp:${name}`;
    const made: Partial<Record<TokenKind, string>> = {};
    if (kinds.has("identity")) {
      made.identity = signIdentity({ ...user, aud: via, exp: until(storage, IDENTITY_SECONDS) }, secret);
    }
    if (kinds.has("storage")) {
      made.storage = signIdentity({ ...user, aud: STORAGE_AUDIENCE, via, exp: storage.exp }, secret);
    }
    if (kinds.has("memory") && chat) {
      made.memory = signIdentity(
        { ...user, aud: MEMORY_AUDIENCE, via, thread: chat.thread, node: chat.node ?? null, exp: Math.min(chat.exp, storage.exp) },
        secret,
      );
    }
    tokens[name] = made;
  }
  return { status: 200, body: { tokens } };
}
