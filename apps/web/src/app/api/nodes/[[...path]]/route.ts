import { agentProxy } from "@/lib/agent-proxy";

/** The knowledge tree: forwards to the API server's /nodes API. */
const proxy = agentProxy("nodes", { pipelineKeys: true });

export { proxy as GET, proxy as POST, proxy as PUT, proxy as PATCH, proxy as DELETE };
