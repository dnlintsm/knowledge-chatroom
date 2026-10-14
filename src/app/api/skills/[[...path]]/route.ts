import { agentProxy } from "@/lib/agent-proxy";

/** Skills, their modes, deleting them, and .zip import/export: forwards to the agent server's /skills API. */
const proxy = agentProxy("skills");

export { proxy as GET, proxy as POST, proxy as PUT, proxy as DELETE };
