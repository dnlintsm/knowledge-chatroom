import { agentProxy } from "@/lib/agent-proxy";

/** Runs of experiments: forwards to the API server's /runs API. */
const proxy = agentProxy("runs");

export { proxy as GET, proxy as POST, proxy as PATCH, proxy as DELETE };
