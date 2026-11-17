import { agentProxy } from "@/lib/agent-proxy";

/**
 * Your workspaces and their members: forwards to the API server's /workspaces
 * (issue #226), with renaming, archiving, role changes and removals (issue #255).
 */
const proxy = agentProxy("workspaces");

export { proxy as GET, proxy as POST, proxy as PATCH, proxy as DELETE };
