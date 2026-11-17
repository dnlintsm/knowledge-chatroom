/**
 * Which agent the chat talks to (docs/remote-agent.md):
 *
 * - AGENT_URL set: a backend's agent at `${AGENT_URL}/agent/report`. The API
 *   server's `/suggest` still writes the follow-up chips, since that needs only
 *   the messages.
 * - AGENT_URL unset: the Python chat agent (services/agent-py) at its default
 *   address, http://127.0.0.1:9300 (issue #264).
 * - AGENT_URL=local: the retired TypeScript agent server's own chat at
 *   LOCAL_AGENT_URL, for legacy comparisons only (`pnpm dev:ts`).
 *
 * Storage, skills and the skill hub are always this repo's agent server, at
 * LOCAL_AGENT_URL (default http://localhost:8000), in both cases.
 */

type Env = Record<string, string | undefined>;

/** The remote backend's agent route, below AGENT_URL. */
export const REMOTE_AGENT_PATH = "/agent/report";

/** The Python chat agent's default address (services/agent-py, AGENT_PY_PORT). */
export const DEFAULT_AGENT_URL = "http://127.0.0.1:9300";

/** AGENT_URL=local: chat on the legacy TypeScript agent server at LOCAL_AGENT_URL. */
export const LOCAL_CHAT = "local";

const DEFAULT_LOCAL_AGENT_URL = "http://localhost:8000";

// Strip any trailing slash so "http://host:8000/" doesn't give a double slash.
const base = (value: string | undefined) => value?.trim().replace(/\/+$/, "") || null;

/** The chat backend's base URL, or null for the legacy agent server's own chat. */
export function remoteAgentUrl(env: Env = process.env): string | null {
  const value = base(env.AGENT_URL);
  if (value?.toLowerCase() === LOCAL_CHAT) return null;
  return value ?? DEFAULT_AGENT_URL;
}

/** The API server: storage, skills, the hub, memory and follow-up chips (and chat with AGENT_URL=local). */
export function localAgentUrl(env: Env = process.env): string {
  return base(env.LOCAL_AGENT_URL) ?? DEFAULT_LOCAL_AGENT_URL;
}

/** The AG-UI endpoint the chat's runs are posted to. */
export function chatAgentUrl(env: Env = process.env): string {
  const remote = remoteAgentUrl(env);
  return remote ? `${remote}${REMOTE_AGENT_PATH}` : `${localAgentUrl(env)}/`;
}

/**
 * Whether the follow-up chips come from this repo's `/suggest`, with or
 * without a remote backend: not with CHAT_SUGGESTIONS=static. Without it the
 * browser keeps the first-round chips (src/components/workspace/use-chat-suggestions.ts).
 */
export function localSuggester(env: Env = process.env): boolean {
  return env.CHAT_SUGGESTIONS?.trim().toLowerCase() !== "static";
}
