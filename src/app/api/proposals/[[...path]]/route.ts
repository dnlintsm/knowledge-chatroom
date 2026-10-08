import { agentProxy } from "@/lib/agent-proxy";

/** Proposed versions of files: forwards to the agent server's /proposals API. */
const proxy = agentProxy("proposals");

export { proxy as GET, proxy as POST };
