import {
  CopilotRuntime,
  CopilotKitIntelligence,
  createCopilotEndpoint,
} from "@copilotkit/runtime/v2";
import { createDefaultAgent, createSuggesterAgent, dynamicSuggestions } from "@/agent";
import { handle } from "hono/vercel";
import {
  IDENTITY_HEADER,
  STORAGE_HEADER,
  authSecret,
  identityHeader,
  sessionFrom,
  sessionFromRequest,
  storageHeader,
} from "@/lib/auth";
import { remoteAgentUrl } from "@/lib/agent-target";
import { handleChatRoute } from "@/lib/chat-routes";
import { ChatRunner } from "@/lib/chat-runner";
import { AutoChatStore } from "@/lib/chat-store";
import type { NextRequest } from "next/server";

// Claude Agent SDK: the agent runs as its own server and speaks AG-UI directly
// over HTTP, so we connect to it with HttpAgent from @ag-ui/client (not
// LangGraphAgent/LangGraphHttpAgent — those target LangGraph-shaped
// endpoints). With AGENT_URL set that server is a remote backend's
// `/agent/report`, else this repo's agent (src/lib/agent-target.ts). Everything
// else — runtime config, v2 endpoint wiring, MCP apps, openGenerativeUI,
// a2ui — mirrors the canonical demo.
const defaultAgent = createDefaultAgent();

// Each user's chats, kept by the agent server in Postgres when it has
// storage, else in memory (issue #91, src/lib/chat-runner.ts). Not used with
// CopilotKit Intelligence, which keeps threads itself.
const intelligence = Boolean(process.env.CPK_INTELLIGENCE_API_KEY);
const chats = new AutoChatStore();
const chatRunner = new ChatRunner(chats);
const BASE_PATH = "/api/copilotkit";

// "suggester" writes the chat's follow-up chips; without it (a remote backend,
// or CHAT_SUGGESTIONS=static) the browser keeps the first-round chips
// (src/components/workspace/use-chat-suggestions.ts).
const runtime = new CopilotRuntime({
  agents: dynamicSuggestions()
    ? { default: defaultAgent, suggester: createSuggesterAgent() }
    : { default: defaultAgent },
  // --- copilotkit:intelligence (remove this block to opt out) ---
  ...(process.env.CPK_INTELLIGENCE_API_KEY
    ? {
        intelligence: new CopilotKitIntelligence({
          apiKey: process.env.CPK_INTELLIGENCE_API_KEY,
          ...(process.env.INTELLIGENCE_API_URL
            ? { apiUrl: process.env.INTELLIGENCE_API_URL }
            : {}),
          ...(process.env.INTELLIGENCE_GATEWAY_WS_URL
            ? { wsUrl: process.env.INTELLIGENCE_GATEWAY_WS_URL }
            : {}),
        }),
        // With login on, each signed-in person has their own thread history
        // (the id is their stable login subject); the id must correspond to a
        // user CopilotKit Intelligence knows. Without login everyone is the
        // demo user and shares one history.
        identifyUser: (req: Request) => {
          if (!authSecret()) return { id: "demo-user", name: "Demo User" };
          const user = sessionFromRequest(req);
          if (!user) throw new Error("Sign in first");
          return { id: user.sub, name: user.name ?? user.email ?? user.sub };
        },
      }
    : { runner: chatRunner }),
  // --- /copilotkit:intelligence ---
  openGenerativeUI: true,
  a2ui: {
    injectA2UITool: false,
  },
  mcpApps: {
    servers: [
      {
        type: "http",
        url: process.env.MCP_SERVER_URL || "https://mcp.excalidraw.com/mcp",
        serverId: "example_mcp_app",
      },
    ],
  },
});

const app = createCopilotEndpoint({
  runtime,
  basePath: BASE_PATH,
});

const handler = handle(app);

// The runtime forwards x-* request headers to the agent, so the agent server
// learns who a run is for from the signed X-Knowledge-User header set here
// (never one the browser sent), and src/agent.ts copies that user into the
// run's forwardedProps. With login on, chat needs a signed-in user. A remote
// backend also gets an X-Knowledge-Storage token, to reach the user's files
// through the storage API for the whole run (issue #88). Without
// Intelligence, the history routes come from the user's own chats
// (src/lib/chat-routes.ts), and only a run's own user may stop it.
async function withUser(req: NextRequest) {
  const headers = new Headers(req.headers);
  headers.delete(IDENTITY_HEADER);
  headers.delete(STORAGE_HEADER);
  const user = authSecret() ? sessionFrom(req) : null;
  if (authSecret()) {
    if (!user) return Response.json({ error: "Sign in first" }, { status: 401 });
    headers.set(IDENTITY_HEADER, identityHeader(user));
    if (remoteAgentUrl()) headers.set(STORAGE_HEADER, storageHeader(user, "remote"));
  }
  if (!intelligence) {
    const path = req.nextUrl.pathname.slice(BASE_PATH.length);
    const answered = await handleChatRoute(req, path, user, chats, (id) => chatRunner.discard(id, user));
    if (answered) return answered;
    const stop = path.match(/^\/agent\/[^/]+\/stop\/([^/]+)\/?$/);
    if (stop) {
      let threadId = stop[1];
      try {
        threadId = decodeURIComponent(threadId);
      } catch {
        // the runtime answers malformed ids itself
      }
      const owner = chatRunner.liveOwner(threadId);
      if (owner && owner !== (user?.sub ?? "local")) {
        return Response.json({ error: "Thread not found" }, { status: 404 });
      }
    }
  }
  return handler(new Request(req, { headers }));
}

export const GET = withUser;
export const POST = withUser;
export const PATCH = withUser;
export const DELETE = withUser;
