import { agentProxy } from "@/lib/agent-proxy";

/** The skill hub: forwards to the agent server's /hub API. */
const proxy = agentProxy("hub");

export { proxy as GET, proxy as POST, proxy as PUT, proxy as DELETE };
