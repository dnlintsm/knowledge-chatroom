import { localAgentUrl } from "./agent-target";
import { IDENTITY_HEADER, authSecret, identityHeader, type SessionUser } from "./auth";

/**
 * Where each user's chat history is kept (issue #91). With server storage
 * (DATABASE_URL on the agent server) that is the agent's `/chats` API
 * (agent/src/storage/chats.ts), in Postgres, so chats survive restarts.
 * Without it, this process's memory: lost on restart, but still one history
 * per user. src/lib/chat-runner.ts saves runs here and replays them.
 */

/** Who a chat is for: a signed-in user, or null without login (the local user). */
export type ChatUser = SessionUser | null;

/** A chat in a user's history, as the agent's /chats API returns it. */
export interface ChatSummary {
  id: string;
  name: string | null;
  agentId: string;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  lastRunAt: string | null;
}

export interface StoredRun {
  runId: string;
  parentRunId: string | null;
  events: unknown[];
}

export interface NewRun extends Omit<StoredRun, "parentRunId"> {
  agentId: string;
  parentRunId: string | null;
  messages: unknown[];
  name: string | null;
}

export interface ListOptions {
  agentId?: string;
  includeArchived?: boolean;
  limit?: number;
  cursor?: string | null;
}

/** The chat id is another user's. */
export class ChatTakenError extends Error {
  constructor() {
    super("This chat belongs to someone else");
  }
}

export interface ChatStore {
  /** The chat's runs in order: [] when there is no such chat yet; ChatTakenError when it's someone else's. */
  runs(user: ChatUser, id: string): Promise<StoredRun[]>;
  /** Saves a finished run, starting the chat on its first. */
  save(user: ChatUser, id: string, run: NewRun): Promise<void>;
  list(user: ChatUser, options: ListOptions): Promise<{ threads: ChatSummary[]; nextCursor: string | null }>;
  /** The chat and its latest messages; null when it isn't the user's. */
  get(user: ChatUser, id: string): Promise<{ chat: ChatSummary; messages: unknown[] } | null>;
  update(user: ChatUser, id: string, changes: { name?: string | null; archived?: boolean }): Promise<boolean>;
  remove(user: ChatUser, id: string): Promise<boolean>;
}

/** A store that can't be reached right now. */
export class ChatStoreError extends Error {}

// Long enough for a big run to be written, short enough not to hold a reply.
const TIMEOUT_MS = 15_000;

/** The agent server's /chats API, which keeps chats in Postgres. */
export class AgentChatStore implements ChatStore {
  constructor(private readonly base = localAgentUrl()) {}

  private async call(user: ChatUser, path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    // Signed now, not taken from the request: a run may outlast its header.
    if (user && authSecret()) headers.set(IDENTITY_HEADER, identityHeader(user));
    if (init.body) headers.set("Content-Type", "application/json");
    try {
      return await fetch(`${this.base}/chats${path}`, {
        ...init,
        headers,
        cache: "no-store",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      throw new ChatStoreError(`Chat history unreachable: ${err instanceof Error ? err.message : err}`);
    }
  }

  private static async fail(res: Response): Promise<never> {
    if (res.status === 403) throw new ChatTakenError();
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new ChatStoreError(body?.error ?? `Chat history answered ${res.status}`);
  }

  async runs(user: ChatUser, id: string) {
    const res = await this.call(user, `/${encodeURIComponent(id)}/runs`);
    if (res.status === 404) return [];
    if (!res.ok) return AgentChatStore.fail(res);
    return ((await res.json()) as { runs: StoredRun[] }).runs;
  }

  async save(user: ChatUser, id: string, run: NewRun) {
    const res = await this.call(user, `/${encodeURIComponent(id)}/runs`, {
      method: "POST",
      body: JSON.stringify(run),
    });
    if (!res.ok) await AgentChatStore.fail(res);
  }

  async list(user: ChatUser, { agentId, includeArchived, limit, cursor }: ListOptions) {
    const query = new URLSearchParams();
    if (agentId) query.set("agent", agentId);
    if (includeArchived) query.set("archived", "");
    if (limit) query.set("limit", String(limit));
    if (cursor) query.set("cursor", cursor);
    const res = await this.call(user, `?${query}`);
    if (!res.ok) return AgentChatStore.fail(res);
    return (await res.json()) as { threads: ChatSummary[]; nextCursor: string | null };
  }

  async get(user: ChatUser, id: string) {
    const res = await this.call(user, `/${encodeURIComponent(id)}`);
    if (res.status === 404) return null;
    if (!res.ok) return AgentChatStore.fail(res);
    return (await res.json()) as { chat: ChatSummary; messages: unknown[] };
  }

  async update(user: ChatUser, id: string, changes: { name?: string | null; archived?: boolean }) {
    const res = await this.call(user, `/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(changes),
    });
    if (res.status === 404) return false;
    if (!res.ok) await AgentChatStore.fail(res);
    return true;
  }

  async remove(user: ChatUser, id: string) {
    const res = await this.call(user, `/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (res.status === 404) return false;
    if (!res.ok) await AgentChatStore.fail(res);
    return true;
  }
}

interface MemoryChat extends ChatSummary {
  owner: string;
  runs: StoredRun[];
  messages: unknown[];
}

const ownerKey = (user: ChatUser) => user?.sub ?? "local";

/**
 * Chats in this process's memory, one history per user, for deployments
 * without server storage. The oldest are dropped past `maxChats`.
 */
export class MemoryChatStore implements ChatStore {
  private readonly chats = new Map<string, MemoryChat>();

  constructor(private readonly maxChats = 1000) {}

  private mine(user: ChatUser, id: string): MemoryChat | null {
    const chat = this.chats.get(id);
    if (!chat) return null;
    if (chat.owner !== ownerKey(user)) throw new ChatTakenError();
    return chat;
  }

  private find(user: ChatUser, id: string): MemoryChat | null {
    const chat = this.chats.get(id);
    return chat && chat.owner === ownerKey(user) ? chat : null;
  }

  async runs(user: ChatUser, id: string) {
    return this.mine(user, id)?.runs ?? [];
  }

  async save(user: ChatUser, id: string, run: NewRun) {
    const now = new Date().toISOString();
    let chat = this.mine(user, id);
    if (!chat) {
      chat = {
        id,
        owner: ownerKey(user),
        name: null,
        agentId: run.agentId,
        archived: false,
        createdAt: now,
        updatedAt: now,
        lastRunAt: null,
        runs: [],
        messages: [],
      };
    }
    chat.runs.push({ runId: run.runId, parentRunId: run.parentRunId, events: run.events });
    chat.messages = run.messages;
    chat.name ??= run.name;
    chat.updatedAt = chat.lastRunAt = now;
    // Re-inserted last, so the map stays oldest-first for dropping.
    this.chats.delete(id);
    this.chats.set(id, chat);
    for (const oldest of this.chats.keys()) {
      if (this.chats.size <= this.maxChats) break;
      this.chats.delete(oldest);
    }
  }

  async list(user: ChatUser, { agentId, includeArchived, limit = 50, cursor }: ListOptions) {
    const all = [...this.chats.values()]
      .filter((c) => c.owner === ownerKey(user) && (!agentId || c.agentId === agentId) && (includeArchived || !c.archived))
      .reverse();
    const start = cursor ? Math.max(Number.parseInt(cursor, 10) || 0, 0) : 0;
    const page = all.slice(start, start + limit);
    return {
      threads: page.map(summary),
      nextCursor: start + limit < all.length ? String(start + limit) : null,
    };
  }

  async get(user: ChatUser, id: string) {
    const chat = this.find(user, id);
    return chat ? { chat: summary(chat), messages: chat.messages } : null;
  }

  async update(user: ChatUser, id: string, changes: { name?: string | null; archived?: boolean }) {
    const chat = this.find(user, id);
    if (!chat) return false;
    if (changes.name !== undefined) chat.name = changes.name?.trim() || null;
    if (changes.archived !== undefined) chat.archived = changes.archived;
    return true;
  }

  async remove(user: ChatUser, id: string) {
    return this.find(user, id) ? this.chats.delete(id) : false;
  }
}

const summary = ({ id, name, agentId, archived, createdAt, updatedAt, lastRunAt }: MemoryChat): ChatSummary => ({
  id,
  name,
  agentId,
  archived,
  createdAt,
  updatedAt,
  lastRunAt,
});

/**
 * The agent server's store when it has server storage, else memory. Which one
 * is asked of the agent server (its /chats answers 404 without DATABASE_URL,
 * 500 when storage failed to start) and remembered; until it answers (still
 * starting, or unreachable) memory stands in.
 */
export class AutoChatStore implements ChatStore {
  private chosen: ChatStore | null = null;

  constructor(
    private readonly server: ChatStore = new AgentChatStore(),
    private readonly memory: ChatStore = new MemoryChatStore(),
    private readonly probe: () => Promise<number | null> = () => probeAgent(localAgentUrl()),
  ) {}

  private async store(): Promise<ChatStore> {
    if (this.chosen) return this.chosen;
    const status = await this.probe();
    if (status === 404 || status === 500) this.chosen = this.memory;
    else if (status !== null && status !== 503) this.chosen = this.server;
    return this.chosen ?? this.memory;
  }

  async runs(user: ChatUser, id: string) {
    return (await this.store()).runs(user, id);
  }
  async save(user: ChatUser, id: string, run: NewRun) {
    return (await this.store()).save(user, id, run);
  }
  async list(user: ChatUser, options: ListOptions) {
    return (await this.store()).list(user, options);
  }
  async get(user: ChatUser, id: string) {
    return (await this.store()).get(user, id);
  }
  async update(user: ChatUser, id: string, changes: { name?: string | null; archived?: boolean }) {
    return (await this.store()).update(user, id, changes);
  }
  async remove(user: ChatUser, id: string) {
    return (await this.store()).remove(user, id);
  }
}

/** The status /chats answers without a user (401 when storage is on with login), or null when unreachable. */
async function probeAgent(base: string): Promise<number | null> {
  try {
    const res = await fetch(`${base}/chats?limit=1`, { cache: "no-store", signal: AbortSignal.timeout(5000) });
    await res.body?.cancel();
    return res.status;
  } catch {
    return null;
  }
}
