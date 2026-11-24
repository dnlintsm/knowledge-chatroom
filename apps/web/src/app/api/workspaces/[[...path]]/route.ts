import { agentProxy } from "@/lib/agent-proxy";

/**
 * Your workspaces and their members: forwards to the API server's /workspaces,
 * with renaming, archiving, role changes and removals.
 */
const proxy = agentProxy("workspaces");

export { proxy as GET, proxy as POST, proxy as PATCH, proxy as DELETE };
