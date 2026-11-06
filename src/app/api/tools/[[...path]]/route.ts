import { agentProxy } from "@/lib/agent-proxy";

/** The chat's "+" menu of outside tools, and direct calls to them: forwards to the agent server's /tools API. */
const proxy = agentProxy("tools");

export { proxy as GET, proxy as POST };
