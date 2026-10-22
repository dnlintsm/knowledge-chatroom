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
