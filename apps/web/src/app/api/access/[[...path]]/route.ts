import { agentProxy } from "@/lib/agent-proxy";

/** Users, groups, grants and the audit log: forwards to the agent server's /access API. */
const proxy = agentProxy("access");

export { proxy as GET, proxy as POST, proxy as PUT, proxy as PATCH, proxy as DELETE };
