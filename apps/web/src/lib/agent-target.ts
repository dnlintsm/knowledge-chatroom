/**
 * Which agent the chat talks to (docs/remote-agent.md):
 *
 * - AGENT_URL set: a remote backend's agent at `${AGENT_URL}/agent/report`.
 *   This repo's own Claude agent is not used for chat or follow-up chips.
 * - AGENT_URL unset: this repo's agent server (agent/) at LOCAL_AGENT_URL.
 *
 * Storage, skills and the skill hub are always this repo's agent server, at
 * LOCAL_AGENT_URL (default http://localhost:8000), in both cases.
 */

type Env = Record<string, string | undefined>;

/** The remote backend's agent route, below AGENT_URL. */
export const REMOTE_AGENT_PATH = "/agent/report";

const DEFAULT_LOCAL_AGENT_URL = "http://localhost:8000";

// Strip any trailing slash so "http://host:8000/" doesn't give a double slash.
const base = (value: string | undefined) => value?.trim().replace(/\/+$/, "") || null;

/** The remote backend's base URL, or null to use this repo's agent. */
export function remoteAgentUrl(env: Env = process.env): string | null {
  return base(env.AGENT_URL);
}

/** This repo's agent server: storage, skills, the hub, and chat without AGENT_URL. */
export function localAgentUrl(env: Env = process.env): string {
  return base(env.LOCAL_AGENT_URL) ?? DEFAULT_LOCAL_AGENT_URL;
}

/** The AG-UI endpoint the chat's runs are posted to. */
export function chatAgentUrl(env: Env = process.env): string {
  const remote = remoteAgentUrl(env);
  return remote ? `${remote}${REMOTE_AGENT_PATH}` : `${localAgentUrl(env)}/`;
}

/**
 * Whether the follow-up chips come from this repo's `/suggest`: not with a
 * remote backend, and not with CHAT_SUGGESTIONS=static. Without it the browser
 * keeps the first-round chips (src/components/workspace/use-chat-suggestions.ts).
 */
export function localSuggester(env: Env = process.env): boolean {
  return !remoteAgentUrl(env) && env.CHAT_SUGGESTIONS?.trim().toLowerCase() !== "static";
}
