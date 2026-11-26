import { agentProxy } from "@/lib/agent-proxy";

/**
 * Pipelines and their keys: forwards to the API server's /pipelines
 * (docs/pipeline-identities.md). Only a signed-in person manages them.
 */
const proxy = agentProxy("pipelines");

export { proxy as GET, proxy as POST, proxy as PATCH, proxy as DELETE };
