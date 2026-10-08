import { agentProxy } from "@/lib/agent-proxy";

/** Experiments on knowledge nodes: forwards to the agent server's /experiments API. */
const proxy = agentProxy("experiments");

export { proxy as GET, proxy as POST, proxy as PATCH, proxy as DELETE };
