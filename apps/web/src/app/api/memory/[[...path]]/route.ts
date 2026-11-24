import { agentProxy } from "@/lib/agent-proxy";

/** Your personalized memory: notes, settings, undo and .zip export. Forwards to the API server's /memory API. */
const proxy = agentProxy("memory");

export { proxy as GET, proxy as POST, proxy as PUT, proxy as DELETE };
