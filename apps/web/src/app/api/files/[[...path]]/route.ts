import { agentProxy } from "@/lib/agent-proxy";

/** Workspace files: forwards to the API server's /files API. */
const proxy = agentProxy("files", { pipelineKeys: true });

export { proxy as GET, proxy as PUT, proxy as PATCH, proxy as DELETE };
