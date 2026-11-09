import { agentProxy } from "@/lib/agent-proxy";

/** The knowledge tree: forwards to the agent server's /nodes API. */
const proxy = agentProxy("nodes");

export { proxy as GET, proxy as POST, proxy as PATCH, proxy as DELETE };
