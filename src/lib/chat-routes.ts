import { compactEvents, EventType, type BaseEvent, type Message } from "@ag-ui/client";

import { ChatStoreError, ChatTakenError, type ChatStore, type ChatSummary, type ChatUser } from "./chat-store";

/**
 * CopilotKit's thread routes (the history drawer's list, rename, archive and
 * delete, and the inspector's messages, events and state), answered from the
 * chat store for the signed-in user (issue #91). Without CopilotKit
 * Intelligence the runtime would answer them from one in-memory list shared
 * by everyone, and refuse the changes. Returns null for any other route.
 *
 * `path` is the part after the runtime's base path, e.g. "/threads/<id>".
 */
export async function handleChatRoute(
  req: Request,
  path: string,
  user: ChatUser,
  store: ChatStore,
): Promise<Response | null> {
  const segments = path.split("/").filter(Boolean);
  if (segments[0] !== "threads") return null;
  let id: string | undefined;
  try {
    id = segments[1] === undefined ? undefined : decodeURIComponent(segments[1]);
  } catch {
    return Response.json({ error: "Malformed thread id" }, { status: 400 });
  }
  const action = segments[2];
  const method = req.method.toUpperCase();
  const url = new URL(req.url);

  try {
    if (!id) {
      if (method !== "GET") return methodNotAllowed();
      const limit = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
      const { threads, nextCursor } = await store.list(user, {
        agentId: url.searchParams.get("agentId") || undefined,
        includeArchived: url.searchParams.get("includeArchived") === "true",
        limit: Number.isNaN(limit) ? undefined : limit,
        cursor: url.searchParams.get("cursor"),
      });
      return Response.json({ threads: threads.map(threadRecord), nextCursor });
    }
    // Clearing everyone's history from a page load is the in-memory demo's; never here.
    if (id === "clear" && !action) return new Response(null, { status: 204 });
    if (id === "subscribe" && !action) {
      return Response.json({ error: "Live thread updates need CopilotKit Intelligence" }, { status: 422 });
    }
    if (segments.length > 3) return notFound();

    switch (action) {
      case undefined:
        if (method === "PATCH") {
          const body = (await req.json().catch(() => null)) as { name?: unknown; archived?: unknown } | null;
          const changes: { name?: string | null; archived?: boolean } = {};
          if (typeof body?.name === "string") changes.name = body.name;
          if (typeof body?.archived === "boolean") changes.archived = body.archived;
          return (await store.update(user, id, changes)) ? Response.json({ threadId: id }) : notFound();
        }
        if (method === "DELETE") {
          return (await store.remove(user, id)) ? Response.json({ threadId: id, deleted: true }) : notFound();
        }
        return methodNotAllowed();
      case "archive":
        if (method !== "POST") return methodNotAllowed();
        return (await store.update(user, id, { archived: true }))
          ? Response.json({ threadId: id, archived: true })
          : notFound();
      case "messages": {
        if (method !== "GET") return methodNotAllowed();
        const chat = await store.get(user, id);
        return Response.json({ messages: (chat?.messages ?? []).map((m) => threadMessage(m as Message)) });
      }
      case "events":
      case "state": {
        if (method !== "GET") return methodNotAllowed();
        const runs = await store.runs(user, id);
        const events = compactEvents(runs.flatMap((run) => run.events as BaseEvent[]));
        if (action === "events") return Response.json({ events });
        const snapshot = events.findLast((e) => e.type === EventType.STATE_SNAPSHOT) as
          | (BaseEvent & { snapshot?: unknown })
          | undefined;
        const state = snapshot?.snapshot;
        return Response.json({ state: state && typeof state === "object" && !Array.isArray(state) ? state : null });
      }
      default:
        return notFound();
    }
  } catch (err) {
    if (err instanceof ChatTakenError) return notFound();
    if (err instanceof ChatStoreError) {
      console.error("[chat] history:", err.message);
      return Response.json({ error: "Chat history is unavailable right now" }, { status: 503 });
    }
    throw err;
  }
}

const notFound = () => Response.json({ error: "Thread not found" }, { status: 404 });
const methodNotAllowed = () => Response.json({ error: "Method not allowed" }, { status: 405 });

/** A chat as CopilotKit's thread list expects it. */
function threadRecord(chat: ChatSummary) {
  return {
    id: chat.id,
    name: chat.name,
    agentId: chat.agentId,
    organizationId: "",
    createdById: "",
    archived: chat.archived,
    createdAt: chat.createdAt,
    updatedAt: chat.updatedAt,
    ...(chat.lastRunAt ? { lastRunAt: chat.lastRunAt } : {}),
  };
}

/** A message as the runtime's own messages route maps it. */
function threadMessage(msg: Message) {
  switch (msg.role) {
    case "assistant": {
      const toolCalls = msg.toolCalls ?? [];
      return {
        id: msg.id,
        role: msg.role,
        ...(msg.content !== undefined ? { content: msg.content } : {}),
        ...(toolCalls.length
          ? { toolCalls: toolCalls.map((tc) => ({ id: tc.id, name: tc.function.name, args: tc.function.arguments })) }
          : {}),
      };
    }
    case "tool":
      return { id: msg.id, role: msg.role, content: msg.content, toolCallId: msg.toolCallId };
    default:
      return {
        id: msg.id,
        role: msg.role,
        ...("content" in msg && msg.content !== undefined ? { content: msg.content } : {}),
      };
  }
}
