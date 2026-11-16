import { agentProxy } from "@/lib/agent-proxy";

/** Your workspaces and their members: forwards to the API server's /workspaces (issue #226). */
const proxy = agentProxy("workspaces");

export { proxy as GET, proxy as POST };
