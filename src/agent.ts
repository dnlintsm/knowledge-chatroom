import { HttpAgent } from "@ag-ui/client";

// Strip any trailing slash so a user-set AGENT_URL like "http://host:8000/"
// does not produce a double slash.
const agentUrl = () => (process.env.AGENT_URL || "http://localhost:8000").replace(/\/+$/, "");

/** Builds the AG-UI client the CopilotKit runtime uses to reach the agent server. */
export function createDefaultAgent(): HttpAgent {
  return new HttpAgent({ url: `${agentUrl()}/` });
}

/**
 * The chat's follow-up chips after a reply: the agent server's `/suggest`
 * answers with one small-model call (agent/src/suggest.ts).
 */
export function createSuggesterAgent(): HttpAgent {
  return new HttpAgent({ url: `${agentUrl()}/suggest` });
}

/** CHAT_SUGGESTIONS=static keeps the first-round chips after replies instead. */
export function dynamicSuggestions(): boolean {
  return process.env.CHAT_SUGGESTIONS?.trim().toLowerCase() !== "static";
}
