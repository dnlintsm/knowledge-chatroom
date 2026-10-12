import { agentProxy } from "@/lib/agent-proxy";

/** Skills and their modes: forwards to the agent server's /skills API. */
const proxy = agentProxy("skills");

export { proxy as GET, proxy as PUT };
