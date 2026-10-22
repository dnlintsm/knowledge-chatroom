import { asUser, inTransaction, type Sql, type Tx } from "./db";

/**
 * Chat history (issue #91, migrations/017_chats.sql): each AG-UI thread the
 * app's chat runs is a chat owned by the user who started it. The app's
 * CopilotKit runner (src/lib/chat-runner.ts) saves every finished run here
 * and replays a chat's runs when it is opened again, e.g. after a restart.
 *
 * Every query names its user, and with row-level security it also runs as
 * that user (db.ts asUser), so Postgres keeps chats private too: nobody
 * reads another person's chats, workspace owners included.
 */

/** A chat in a user's history, shaped like CopilotKit's thread records. */
export interface ChatSummary {
  id: string;
  name: string | null;
  agentId: string;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  lastRunAt: string | null;
}

export interface ChatRun {
  runId: string;
  parentRunId: string | null;
  /** The run's AG-UI events, compacted. */
  events: unknown[];
  createdAt: string;
}

export interface NewRun {
  agentId: string;
  runId: string;
  parentRunId?: string | null;
  events: unknown[];
  /** The whole conversation after the run (AG-UI messages). */
  messages: unknown[];
  /** The chat's name if it has none yet: usually the first thing asked. */
  name?: string | null;
}

export interface ListOptions {
  agentId?: string;
  includeArchived?: boolean;
  /** At most this many (default 50, at most 200). */
  limit?: number;
  /** From a previous page's nextCursor. */
  cursor?: string | null;
}

/** A bad request: answered with 400. */
export class ChatError extends Error {}

/** The thread id is another user's chat: answered with 403. */
export class ChatTakenError extends Error {
  constructor() {
    super("This chat belongs to someone else");
  }
}

export const MAX_NAME = 200;

interface ChatRow {
  id: string;
  name: string | null;
  agent_id: string;
  archived: boolean;
  created_at: Date;
  updated_at: Date;
  last_run_at: Date | null;
}

const COLUMNS = (sql: Sql) => sql`id, name, agent_id, archived, created_at, updated_at, last_run_at`;

const toSummary = (row: ChatRow): ChatSummary => ({
  id: row.id,
  name: row.name,
  agentId: row.agent_id,
  archived: row.archived,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
  lastRunAt: row.last_run_at?.toISOString() ?? null,
});

export const validChatId = (id: unknown): id is string =>
  typeof id === "string" && id.length > 0 && id.length <= 200;

/** A cursor is the last row's "<updatedAt>|<id>". */
function readCursor(cursor: string): { at: string; id: string } {
  const bar = cursor.indexOf("|");
  const at = cursor.slice(0, bar);
  if (bar < 1 || Number.isNaN(Date.parse(at))) throw new ChatError("Invalid cursor");
  return { at, id: cursor.slice(bar + 1) };
}

const cleanName = (name: string | null | undefined) => {
  const clean = name?.replace(/\s+/g, " ").trim().slice(0, MAX_NAME);
  return clean || null;
};

/** A past chat that matched a search, with lines around the words found. */
export interface ChatHit {
  id: string;
  name: string | null;
  updatedAt: string;
  /** How many of the query's words it has. */
  matched: number;
  snippets: string[];
}

/** One user or assistant message's text. */
export interface ChatLine {
  role: "user" | "assistant";
  text: string;
}

/** The text of a chat's user and assistant messages (AG-UI), in order. */
export function chatLines(messages: unknown[]): ChatLine[] {
  const lines: ChatLine[] = [];
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!m || typeof m !== "object") continue;
    const { role, content } = m as { role?: unknown; content?: unknown };
    if (role !== "user" && role !== "assistant") continue;
    const text =
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content
              .map((p) => (p && typeof p === "object" && (p as { type?: unknown }).type === "text" ? String((p as { text?: unknown }).text ?? "") : ""))
              .filter(Boolean)
              .join("\n")
          : "";
    if (text.trim()) lines.push({ role, text });
  }
  return lines;
}

/** Words searched for at most, and chats looked through. */
const MAX_WORDS = 8;
const CANDIDATES = 100;
const SNIPPET = 160;

const likePattern = (word: string) => `%${word.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

export class ChatService {
  constructor(
    private readonly sql: Sql,
    private readonly workspaceId: string,
    private readonly rowSecurity: boolean,
  ) {}

  /**
   * Runs `fn` for `userId` in one transaction (so appendRun's row lock holds),
   * as that user when row-level security is on.
   */
  private as<T>(userId: string, fn: (db: Sql) => Promise<T>): Promise<T> {
    if (this.rowSecurity) return asUser(this.sql, userId, fn);
    return this.sql.begin((tx) => fn(inTransaction(tx as Tx))) as Promise<T>;
  }

  /** The user's chats, most recently active first. */
  async list(userId: string, options: ListOptions = {}): Promise<{ threads: ChatSummary[]; nextCursor: string | null }> {
    const limit = Math.min(Math.max(Math.trunc(options.limit ?? 50) || 50, 1), 200);
    const after = options.cursor ? readCursor(options.cursor) : null;
    return this.as(userId, async (db) => {
      // The cursor keeps updated_at to the microsecond, as text.
      const rows = await db<(ChatRow & { at: string })[]>`
        SELECT ${COLUMNS(db)}, updated_at::text AS at FROM chats
        WHERE user_id = ${userId} AND workspace_id = ${this.workspaceId}
          ${options.agentId ? db`AND agent_id = ${options.agentId}` : db``}
          ${options.includeArchived ? db`` : db`AND NOT archived`}
          ${after ? db`AND (updated_at, id) < (${after.at}::timestamptz, ${after.id})` : db``}
        ORDER BY updated_at DESC, id DESC
        LIMIT ${limit + 1}`;
      const page = rows.slice(0, limit);
      const last = page[page.length - 1];
      return {
        threads: page.map(toSummary),
        nextCursor: rows.length > limit && last ? `${last.at}|${last.id}` : null,
      };
    });
  }

  /** One of the user's chats with its latest messages; null when it isn't theirs or doesn't exist. */
  get(userId: string, id: string): Promise<{ chat: ChatSummary; messages: unknown[] } | null> {
    if (!validChatId(id)) return Promise.resolve(null);
    return this.as(userId, async (db) => {
      const [row] = await db<(ChatRow & { messages: unknown[] })[]>`
        SELECT ${COLUMNS(db)}, messages FROM chats
        WHERE id = ${id} AND user_id = ${userId}`;
      return row ? { chat: toSummary(row), messages: row.messages } : null;
    });
  }

  /** The chat's runs in order; null when it isn't the user's or doesn't exist. */
  runs(userId: string, id: string): Promise<ChatRun[] | null> {
    if (!validChatId(id)) return Promise.resolve(null);
    return this.as(userId, async (db) => {
      const [chat] = await db`SELECT 1 FROM chats WHERE id = ${id} AND user_id = ${userId}`;
      if (!chat) return null;
      const rows = await db<{ run_id: string; parent_run_id: string | null; events: unknown[]; created_at: Date }[]>`
        SELECT run_id, parent_run_id, events, created_at FROM chat_runs
        WHERE chat_id = ${id} ORDER BY seq`;
      return rows.map((r) => ({
        runId: r.run_id,
        parentRunId: r.parent_run_id,
        events: r.events,
        createdAt: r.created_at.toISOString(),
      }));
    });
  }

  /**
   * The user's past chats with the query's words in their name or messages,
   * those with the most words first, then the latest. Incognito chats, and
   * `exclude` (the chat asking), are never results.
   */
  async search(userId: string, query: string, options: { exclude?: string | null; limit?: number } = {}): Promise<ChatHit[]> {
    const words = [...new Set(query.toLowerCase().split(/\s+/).filter((w) => w.length > 1))].slice(0, MAX_WORDS);
    if (!words.length) return [];
    const limit = Math.min(Math.max(Math.trunc(options.limit ?? 5) || 5, 1), 20);
    const rows = await this.as(userId, (db) =>
      db<{ id: string; name: string | null; updated_at: Date; messages: unknown[] }[]>`
        SELECT c.id, c.name, c.updated_at, c.messages FROM chats c
        WHERE c.user_id = ${userId} AND c.workspace_id = ${this.workspaceId}
          ${options.exclude ? db`AND c.id <> ${options.exclude}` : db``}
          AND NOT EXISTS (
            SELECT 1 FROM memory_incognito_chats i
            WHERE i.workspace_id = c.workspace_id AND i.user_id = c.user_id AND i.thread_id = c.id)
          AND (coalesce(c.name, '') || ' ' || c.messages::text) ILIKE ANY (${words.map(likePattern)}::text[])
        ORDER BY c.updated_at DESC
        LIMIT ${CANDIDATES}`,
    );
    const hits: ChatHit[] = [];
    for (const row of rows) {
      // The JSON matched; look again in just what was said.
      const lines = chatLines(row.messages);
      const said = [row.name ?? "", ...lines.map((l) => l.text)].join("\n").toLowerCase();
      const found = words.filter((w) => said.includes(w));
      if (!found.length) continue;
      const snippets: string[] = [];
      for (const line of lines) {
        const at = Math.min(...found.map((w) => line.text.toLowerCase().indexOf(w)).filter((i) => i >= 0));
        if (!Number.isFinite(at)) continue;
        const start = Math.max(0, at - SNIPPET / 2);
        const cut = line.text.slice(start, start + SNIPPET).replace(/\s+/g, " ").trim();
        snippets.push(`${line.role}: ${start > 0 ? "…" : ""}${cut}${start + SNIPPET < line.text.length ? "…" : ""}`);
        if (snippets.length === 2) break;
      }
      hits.push({ id: row.id, name: row.name, updatedAt: row.updated_at.toISOString(), matched: found.length, snippets });
    }
    return hits.sort((a, b) => b.matched - a.matched).slice(0, limit);
  }

  /**
   * One of the user's chats, as what was said; null when it isn't theirs,
   * doesn't exist, or is incognito.
   */
  async lines(userId: string, id: string): Promise<{ chat: ChatSummary; lines: ChatLine[] } | null> {
    if (!validChatId(id)) return null;
    return this.as(userId, async (db) => {
      const [row] = await db<(ChatRow & { messages: unknown[] })[]>`
        SELECT ${COLUMNS(db)}, c.messages FROM chats c
        WHERE c.id = ${id} AND c.user_id = ${userId} AND c.workspace_id = ${this.workspaceId}
          AND NOT EXISTS (
            SELECT 1 FROM memory_incognito_chats i
            WHERE i.workspace_id = c.workspace_id AND i.user_id = c.user_id AND i.thread_id = c.id)`;
      return row ? { chat: toSummary(row), lines: chatLines(row.messages) } : null;
    });
  }

  /**
   * Whose chat `id` is: "mine", "theirs" (another user's) or "none" (no chat
   * yet). Read with the table owner's rights, since the user can't see others'.
   */
  async owner(userId: string, id: string): Promise<"mine" | "theirs" | "none"> {
    if (!validChatId(id)) return "none";
    const [row] = await this.sql<{ user_id: string }[]>`SELECT user_id FROM chats WHERE id = ${id}`;
    return !row ? "none" : row.user_id === userId ? "mine" : "theirs";
  }

  /**
   * Saves a finished run, starting the chat on its first. Throws
   * ChatTakenError when `id` is another user's chat.
   */
  appendRun(userId: string, id: string, run: NewRun): Promise<ChatSummary> {
    if (!validChatId(id)) throw new ChatError("Invalid chat id");
    if (!run.agentId || !run.runId) throw new ChatError("A run needs agentId and runId");
    return this.as(userId, async (db) => {
      await db`
        INSERT INTO chats (id, workspace_id, user_id, agent_id)
        VALUES (${id}, ${this.workspaceId}, ${userId}, ${run.agentId})
        ON CONFLICT (id) DO NOTHING`;
      // Locks the chat, so two runs saved at once get their own seq. Another
      // user's chat isn't found (row security hides it, the user_id test too).
      const [chat] = await db`SELECT 1 FROM chats WHERE id = ${id} AND user_id = ${userId} FOR UPDATE`;
      if (!chat) throw new ChatTakenError();
      await db`
        INSERT INTO chat_runs (chat_id, seq, run_id, parent_run_id, events)
        SELECT ${id}, coalesce(max(seq), 0) + 1, ${run.runId}, ${run.parentRunId ?? null},
               ${db.json(run.events as never)}
        FROM chat_runs WHERE chat_id = ${id}`;
      const [row] = await db<ChatRow[]>`
        UPDATE chats SET
          messages = ${db.json(run.messages as never)},
          name = coalesce(name, ${cleanName(run.name)}),
          updated_at = now(), last_run_at = now()
        WHERE id = ${id}
        RETURNING ${COLUMNS(db)}`;
      return toSummary(row);
    });
  }

  /** Renames or (un)archives one of the user's chats; null when it isn't theirs. */
  update(userId: string, id: string, changes: { name?: string | null; archived?: boolean }): Promise<ChatSummary | null> {
    if (!validChatId(id)) return Promise.resolve(null);
    const name = changes.name === undefined ? undefined : cleanName(changes.name);
    return this.as(userId, async (db) => {
      const [row] = await db<ChatRow[]>`
        UPDATE chats SET
          name = ${name === undefined ? db`name` : name},
          archived = ${changes.archived === undefined ? db`archived` : changes.archived}
        WHERE id = ${id} AND user_id = ${userId}
        RETURNING ${COLUMNS(db)}`;
      return row ? toSummary(row) : null;
    });
  }

  /** Deletes one of the user's chats for good, with its runs. */
  remove(userId: string, id: string): Promise<boolean> {
    if (!validChatId(id)) return Promise.resolve(false);
    return this.as(userId, async (db) => {
      const rows = await db`DELETE FROM chats WHERE id = ${id} AND user_id = ${userId} RETURNING id`;
      return rows.length > 0;
    });
  }
}
