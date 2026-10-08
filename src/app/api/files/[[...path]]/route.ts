import { agentProxy } from "@/lib/agent-proxy";

/** Workspace files: forwards to the agent server's /files API. */
const proxy = agentProxy("files");

export { proxy as GET, proxy as PUT, proxy as DELETE };
