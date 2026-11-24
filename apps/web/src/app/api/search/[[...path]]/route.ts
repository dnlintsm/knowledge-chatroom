import { agentProxy } from "@/lib/agent-proxy";

/** Search over workspace files: forwards to the API server's /search API. */
const proxy = agentProxy("search");

export { proxy as GET };
