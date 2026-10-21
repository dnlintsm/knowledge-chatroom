import { HttpAgent, type RunAgentInput } from "@ag-ui/client";
import { chatAgentUrl, localAgentUrl, localSuggester } from "@/lib/agent-target";
import { IDENTITY_HEADER, authSecret, readIdentityHeader } from "@/lib/auth";
import { LOCAL_USER, withChatroomUser, type ChatroomUser } from "@/lib/chatroom-props";

/**
 * An AG-UI client that puts the run's user into
 * `forwardedProps.knowledge_chatroom.user` (src/lib/chatroom-props.ts). The
 * runtime gives each request its own clone of the agent, carrying that
 * request's x-* headers, so the user comes from the identity route.ts signed
 * into X-Knowledge-User, never from the browser.
 */
class ChatroomAgent extends HttpAgent {
  protected override requestInit(input: RunAgentInput): RequestInit {
    return super.requestInit(withChatroomUser(input, this.chatroomUser()));
  }

  private chatroomUser(): ChatroomUser | null {
    if (!authSecret()) return LOCAL_USER;
    const header = Object.entries(this.headers).find(([name]) => name.toLowerCase() === IDENTITY_HEADER)?.[1];
    const user = readIdentityHeader(header);
    return user ? { id: user.sub, email: user.email ?? null, name: user.name ?? null, signed_in: true } : null;
  }
}

/**
 * The chat's agent: a remote backend's `${AGENT_URL}/agent/report` when
 * AGENT_URL is set, else this repo's agent server (src/lib/agent-target.ts).
 */
export function createDefaultAgent(): HttpAgent {
  return new ChatroomAgent({ url: chatAgentUrl() });
}

/**
 * The chat's follow-up chips after a reply: this repo's agent server's
 * `/suggest` answers with one small-model call (agent/src/suggest.ts).
 */
export function createSuggesterAgent(): HttpAgent {
  return new ChatroomAgent({ url: `${localAgentUrl()}/suggest` });
}

/** Follow-up chips from the suggester: off with AGENT_URL or CHAT_SUGGESTIONS=static. */
export function dynamicSuggestions(): boolean {
  return localSuggester();
}
