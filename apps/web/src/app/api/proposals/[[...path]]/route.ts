import { agentProxy } from "@/lib/agent-proxy";

/** Proposed versions of files: forwards to the API server's /proposals API. */
const proxy = agentProxy("proposals", { pipelineKeys: true });

export { proxy as GET, proxy as POST };
