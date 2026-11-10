import { HttpAgent, type RunAgentInput } from "@ag-ui/client";
import { chatAgentUrl, localAgentUrl, localSuggester, remoteAgentUrl } from "@/lib/agent-target";
import { IDENTITY_HEADER, MEMORY_HEADER, authSecret, memoryHeader, readIdentityHeader, type SessionUser } from "@/lib/auth";
import { CHATROOM_PROPS, LOCAL_USER, withChatroomUser, type ChatroomUser } from "@/lib/chatroom-props";

/**
 * An AG-UI client that puts the run's user into
 * `forwardedProps.knowledge_chatroom.user` (src/lib/chatroom-props.ts). The
 * runtime gives each request its own clone of the agent, carrying that
 * request's x-* headers, so the user comes from the identity route.ts signed
 * into X-Knowledge-User, never from the browser.
 *
 * A remote backend's chat agent also gets an X-Knowledge-Memory token for the
 * run's chat (and knowledge node), to use the user's memory there through the
 * agent server's /memory/agent (docs/remote-agent.md).
 */
class ChatroomAgent extends HttpAgent {
  protected override requestInit(input: RunAgentInput): RequestInit {
    const signedIn = this.signedInUser();
    const user: ChatroomUser | null = !authSecret()
      ? LOCAL_USER
      : signedIn && { id: signedIn.sub, email: signedIn.email ?? null, name: signedIn.name ?? null, signed_in: true };
    const init = super.requestInit(withChatroomUser(input, user));
    if (!user || !input.threadId || !remoteAgentUrl() || this.url !== chatAgentUrl()) return init;
    const headers = new Headers(init.headers);
    headers.set(MEMORY_HEADER, memoryHeader(signedIn, input.threadId, runNode(input)));
    return { ...init, headers };
  }

  /** With login, the user route.ts signed into X-Knowledge-User. */
  private signedInUser(): SessionUser | null {
    const header = Object.entries(this.headers).find(([name]) => name.toLowerCase() === IDENTITY_HEADER)?.[1];
    return readIdentityHeader(header);
  }
}

/** The knowledge node the run's chat is in, from the browser's chatroom props (null = the root). */
function runNode(input: RunAgentInput): string | null {
  const props = input.forwardedProps as Record<string, unknown> | undefined;
  const place = props?.[CHATROOM_PROPS] as { node?: { id?: unknown } | null } | undefined;
  return typeof place?.node?.id === "string" ? place.node.id : null;
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
 * `/suggest` answers with one small-model call (apps/agent/src/suggest.ts).
 */
export function createSuggesterAgent(): HttpAgent {
  return new ChatroomAgent({ url: `${localAgentUrl()}/suggest` });
}

/** Follow-up chips from the suggester: off with AGENT_URL or CHAT_SUGGESTIONS=static. */
export function dynamicSuggestions(): boolean {
  return localSuggester();
}
