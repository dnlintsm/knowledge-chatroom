import { agentProxy } from "@/lib/agent-proxy";

/**
 * The workspace inventory and Owner recovery, for the deployment's admins:
 * forwards to the API server's /platform (docs/workspaces.md,
 * "Workspace inventory"). The server decides who may.
 */
const proxy = agentProxy("platform");

export { proxy as GET, proxy as POST };
