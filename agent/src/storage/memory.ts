import { strToU8, zipSync } from "fflate";

import { asUser, inTransaction, type Sql, type Tx } from "./db";

/**
 * Personalized memory (issue #93, migrations/018_memory.sql): short markdown
 * notes Claude keeps about each user across chats, in the format Claude Code's
 * memory and SKILL.md use (a name, a one-line description, a type, a body).
 * Each run gets an index of the user's notes in its prompt and reads or edits
 * them with the memory tools (../memory/run.ts).
 *
 * Notes belong to one user. Every query names that user, and with row-level
 * security it also runs as them (db.ts asUser), so Postgres keeps notes
 * private too: nobody else reads them, workspace owners included.
 *
 * Every change is a version. Claude's changes are also events, which the chat
 * shows ("Updated: …") and the user can undo; Claude's deletes only archive.
 */

export const MEMORY_TYPES = ["preference", "profile", "project", "reference", "feedback"] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];
export type MemoryAuthor = "user" | "agent";
export type MemoryMode = "on" | "off";
export type MemoryEventKind = "read" | "create" | "update" | "archive";

/** Notes per user (archived ones not counted). */
export const MAX_NOTES = 200;
export const MAX_BODY = 16_000;
export const MAX_DESCRIPTION = 300;
/** How much of the prompt the index of notes may take, in characters. */
export const INDEX_CHARS = 6_000;

export interface MemorySummary {
  name: string;
  description: string;
  type: MemoryType;
  version: number;
  createdBy: MemoryAuthor;
  updatedBy: MemoryAuthor;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
}

export interface MemoryNote extends MemorySummary {
  body: string;
}

export interface MemoryVersion {
  version: number;
  description: string;
  type: MemoryType;
  body: string;
  changedBy: MemoryAuthor;
  threadId: string | null;
  createdAt: string;
}

/** What Claude did with a note in a run, as the chat shows it. */
export interface MemoryEvent {
  id: string;
  name: string;
  description: string;
  kind: MemoryEventKind;
  version: number;
}

export interface MemoryInput {
  description: string;
  type: string;
  body: string;
}

/** The chat run a change or read happened in; none for the user's own edits. */
export interface MemoryRun {
  threadId: string;
  runId: string;
}

/** A bad request: answered with 400. */
export class MemoryError extends Error {}
/** No such note: answered with 404. */
export class MemoryNotFoundError extends Error {
  constructor(name: string) {
    super(`No memory named ${name}`);
  }
}
/** The note changed since (e.g. undoing an older change): answered with 409. */
export class MemoryConflictError extends Error {}

const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function validName(name: unknown): name is string {
  return typeof name === "string" && NAME.test(name);
}

/** A name from free text: "Writing style!" → "writing-style". */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/, "");
}

function checkName(name: unknown): string {
  if (!validName(name)) {
    throw new MemoryError("A memory's name is lowercase letters, digits and dashes, at most 64 (e.g. writing-style)");
  }
  return name;
}

/** The input, cleaned: one-line description, known type, body within limits. */
export function checkInput(input: Partial<MemoryInput>): MemoryInput & { type: MemoryType } {
  const description = typeof input.description === "string" ? input.description.replace(/\s+/g, " ").trim() : "";
  if (!description) throw new MemoryError("A memory needs a one-line description");
  if (description.length > MAX_DESCRIPTION) {
    throw new MemoryError(`A memory's description is at most ${MAX_DESCRIPTION} characters`);
  }
  const type = input.type ?? "preference";
  if (!MEMORY_TYPES.includes(type as MemoryType)) {
    throw new MemoryError(`A memory's type is one of ${MEMORY_TYPES.join(", ")}`);
  }
  const body = typeof input.body === "string" ? input.body.replace(/\r\n?/g, "\n").trim() : "";
  if (body.length > MAX_BODY) throw new MemoryError(`A memory is at most ${MAX_BODY} characters`);
  return { description, type: type as MemoryType, body };
}

/** A note as a markdown file with front matter, as export and Claude's view show it. */
export function toMarkdown(note: Pick<MemoryNote, "name" | "description" | "type" | "body">): string {
  return `---\nname: ${note.name}\ndescription: ${note.description}\ntype: ${note.type}\n---\n\n${note.body}\n`;
}

interface MemoryRow {
  id: string;
  name: string;
  description: string;
  type: MemoryType;
  body: string;
  version: number;
  created_by: MemoryAuthor;
  updated_by: MemoryAuthor;
  archived_at: Date | null;
  created_at: Date;
  updated_at: Date;
  last_used_at: Date | null;
}

const toNote = (row: MemoryRow): MemoryNote => ({
  name: row.name,
  description: row.description,
  type: row.type,
  body: row.body,
  version: row.version,
  createdBy: row.created_by,
  updatedBy: row.updated_by,
  archived: row.archived_at !== null,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
  lastUsedAt: row.last_used_at?.toISOString() ?? null,
});

const toSummary = (row: MemoryRow): MemorySummary => {
  const note: Partial<MemoryNote> = toNote(row);
  delete note.body;
  return note as MemorySummary;
};

export class MemoryService {
  constructor(
    private readonly sql: Sql,
    private readonly workspaceId: string,
    private readonly rowSecurity: boolean,
  ) {}

  /** Runs `fn` for `userId` in one transaction, as that user when row-level security is on. */
  private as<T>(userId: string, fn: (db: Sql) => Promise<T>): Promise<T> {
    if (this.rowSecurity) return asUser(this.sql, userId, fn);
    return this.sql.begin((tx) => fn(inTransaction(tx as Tx))) as Promise<T>;
  }

  private async row(db: Sql, userId: string, name: string, lock = false): Promise<MemoryRow | null> {
    const [row] = await db<MemoryRow[]>`
      SELECT * FROM memories
      WHERE workspace_id = ${this.workspaceId} AND user_id = ${userId} AND name = ${name}
      ${lock ? db`FOR UPDATE` : db``}`;
    return row ?? null;
  }

  private async event(db: Sql, userId: string, row: MemoryRow, kind: MemoryEventKind, run: MemoryRun): Promise<MemoryEvent> {
    const [{ id }] = await db<{ id: string }[]>`
      INSERT INTO memory_events (workspace_id, user_id, memory_id, thread_id, run_id, kind, version)
      VALUES (${this.workspaceId}, ${userId}, ${row.id}, ${run.threadId}, ${run.runId}, ${kind}, ${row.version})
      RETURNING id`;
    return { id, name: row.name, description: row.description, kind, version: row.version };
  }

  /** Writes new content as the note's next version (and brings it back if archived). */
  private async write(
    db: Sql,
    row: MemoryRow,
    input: MemoryInput,
    by: MemoryAuthor,
    threadId: string | null,
    archived = false,
  ): Promise<MemoryRow> {
    const [next] = await db<MemoryRow[]>`
      UPDATE memories SET
        description = ${input.description}, type = ${input.type}, body = ${input.body},
        version = version + 1, updated_by = ${by}, updated_at = now(),
        archived_at = ${archived ? db`now()` : null}
      WHERE id = ${row.id}
      RETURNING *`;
    await db`
      INSERT INTO memory_versions (memory_id, version, description, type, body, changed_by, thread_id)
      VALUES (${next.id}, ${next.version}, ${next.description}, ${next.type}, ${next.body}, ${by}, ${threadId})`;
    return next;
  }

  /** The user's notes, the ones in use first, then archived ones, newest first. */
  list(userId: string): Promise<MemorySummary[]> {
    return this.as(userId, async (db) => {
      const rows = await db<MemoryRow[]>`
        SELECT * FROM memories
        WHERE workspace_id = ${this.workspaceId} AND user_id = ${userId}
        ORDER BY archived_at IS NOT NULL, updated_at DESC, name`;
      return rows.map(toSummary);
    });
  }

  /** One note with its body; null when the user has none of that name. */
  get(userId: string, name: string): Promise<MemoryNote | null> {
    if (!validName(name)) return Promise.resolve(null);
    return this.as(userId, async (db) => {
      const row = await this.row(db, userId, name);
      return row ? toNote(row) : null;
    });
  }

  /** A note's versions, newest first. */
  async versions(userId: string, name: string): Promise<MemoryVersion[]> {
    checkName(name);
    return this.as(userId, async (db) => {
      const row = await this.row(db, userId, name);
      if (!row) throw new MemoryNotFoundError(name);
      const rows = await db<{ version: number; description: string; type: MemoryType; body: string; changed_by: MemoryAuthor; thread_id: string | null; created_at: Date }[]>`
        SELECT version, description, type, body, changed_by, thread_id, created_at
        FROM memory_versions WHERE memory_id = ${row.id} ORDER BY version DESC`;
      return rows.map((r) => ({
        version: r.version,
        description: r.description,
        type: r.type,
        body: r.body,
        changedBy: r.changed_by,
        threadId: r.thread_id,
        createdAt: r.created_at.toISOString(),
      }));
    });
  }

  /**
   * Creates or replaces a note. `run` (Claude's writes) records an event the
   * chat shows and the user can undo. `create` refuses a name in use. Saving
   * the same content again changes nothing and records nothing.
   */
  async save(
    userId: string,
    name: string,
    input: Partial<MemoryInput>,
    by: MemoryAuthor,
    { run, create = false }: { run?: MemoryRun; create?: boolean } = {},
  ): Promise<{ note: MemoryNote; event: MemoryEvent | null }> {
    checkName(name);
    const clean = checkInput(input);
    return this.as(userId, async (db) => {
      const row = await this.row(db, userId, name, true);
      if (row && create && !row.archived_at) throw new MemoryConflictError(`A memory named ${name} already exists`);
      if (!row || row.archived_at) await this.checkRoom(db, userId);
      if (!row) {
        const [created] = await db<MemoryRow[]>`
          INSERT INTO memories (workspace_id, user_id, name, description, type, body, created_by, updated_by)
          VALUES (${this.workspaceId}, ${userId}, ${name}, ${clean.description}, ${clean.type}, ${clean.body}, ${by}, ${by})
          RETURNING *`;
        await db`
          INSERT INTO memory_versions (memory_id, version, description, type, body, changed_by, thread_id)
          VALUES (${created.id}, 1, ${created.description}, ${created.type}, ${created.body}, ${by}, ${run?.threadId ?? null})`;
        return { note: toNote(created), event: run ? await this.event(db, userId, created, "create", run) : null };
      }
      const same = row.description === clean.description && row.type === clean.type && row.body === clean.body;
      if (same && !row.archived_at) return { note: toNote(row), event: null };
      const next = await this.write(db, row, clean, by, run?.threadId ?? null);
      // Bringing an archived note back counts as creating it, for Undo.
      const kind = row.archived_at ? "create" : "update";
      return { note: toNote(next), event: run ? await this.event(db, userId, next, kind, run) : null };
    });
  }

  private async checkRoom(db: Sql, userId: string) {
    const [{ count }] = await db<{ count: number }[]>`
      SELECT count(*)::int AS count FROM memories
      WHERE workspace_id = ${this.workspaceId} AND user_id = ${userId} AND archived_at IS NULL`;
    if (count >= MAX_NOTES) {
      throw new MemoryError(`You have ${MAX_NOTES} memories, the most there can be: delete or merge some first`);
    }
  }

  /** Replaces the one occurrence of `oldText` in a note's body (Claude's small edits). */
  async replaceText(
    userId: string,
    name: string,
    oldText: string,
    newText: string,
    by: MemoryAuthor,
    run?: MemoryRun,
  ): Promise<{ note: MemoryNote; event: MemoryEvent | null }> {
    const note = await this.get(userId, name);
    if (!note || note.archived) throw new MemoryNotFoundError(name);
    if (!oldText) throw new MemoryError("Say which text to replace");
    const count = note.body.split(oldText).length - 1;
    if (count !== 1) {
      throw new MemoryError(
        count === 0
          ? `That text isn't in ${name}; view it and copy the text exactly`
          : `That text is in ${name} ${count} times; include more around it so it's unique`,
      );
    }
    return this.save(userId, name, { ...note, body: note.body.replace(oldText, () => newText) }, by, { run });
  }

  /**
   * Archives (or brings back) a note: out of Claude's index, kept with its
   * versions. Claude's deletes are archives, with an event to undo.
   */
  async archive(
    userId: string,
    name: string,
    archived: boolean,
    run?: MemoryRun,
  ): Promise<{ note: MemoryNote; event: MemoryEvent | null }> {
    checkName(name);
    return this.as(userId, async (db) => {
      const row = await this.row(db, userId, name, true);
      if (!row) throw new MemoryNotFoundError(name);
      if (Boolean(row.archived_at) === archived) return { note: toNote(row), event: null };
      if (!archived) await this.checkRoom(db, userId);
      const [next] = await db<MemoryRow[]>`
        UPDATE memories SET archived_at = ${archived ? db`now()` : null}, updated_at = now()
        WHERE id = ${row.id} RETURNING *`;
      const event = run && archived ? await this.event(db, userId, next, "archive", run) : null;
      return { note: toNote(next), event };
    });
  }

  /** Deletes a note for good, with every version and event. */
  remove(userId: string, name: string): Promise<boolean> {
    if (!validName(name)) return Promise.resolve(false);
    return this.as(userId, async (db) => {
      const rows = await db`
        DELETE FROM memories
        WHERE workspace_id = ${this.workspaceId} AND user_id = ${userId} AND name = ${name}
        RETURNING id`;
      return rows.length > 0;
    });
  }

  /** Makes an earlier version the current one again (as a new version), and brings the note back. */
  async restore(userId: string, name: string, version: number): Promise<MemoryNote> {
    checkName(name);
    return this.as(userId, async (db) => {
      const row = await this.row(db, userId, name, true);
      if (!row) throw new MemoryNotFoundError(name);
      const [old] = await db<MemoryInput[]>`
        SELECT description, type, body FROM memory_versions
        WHERE memory_id = ${row.id} AND version = ${version}`;
      if (!old) throw new MemoryNotFoundError(`${name} version ${version}`);
      if (row.archived_at) await this.checkRoom(db, userId);
      return toNote(await this.write(db, row, old, "user", null));
    });
  }

  /**
   * Undoes one of Claude's changes, when it is still the note's latest: a new
   * note goes away, an update goes back to the version before it (as a new
   * version), an archived note comes back.
   */
  undo(userId: string, eventId: string): Promise<{ name: string; note: MemoryNote | null }> {
    if (!/^[0-9a-f-]{36}$/i.test(eventId)) return Promise.reject(new MemoryNotFoundError("for that change"));
    return this.as(userId, async (db) => {
      const [event] = await db<{ memory_id: string; kind: MemoryEventKind; version: number; undone_at: Date | null }[]>`
        SELECT memory_id, kind, version, undone_at FROM memory_events
        WHERE id = ${eventId} AND user_id = ${userId} AND workspace_id = ${this.workspaceId}`;
      if (!event || event.kind === "read") throw new MemoryNotFoundError("for that change");
      if (event.undone_at) throw new MemoryConflictError("That change was already undone");
      const [row] = await db<MemoryRow[]>`SELECT * FROM memories WHERE id = ${event.memory_id} FOR UPDATE`;
      if (!row) throw new MemoryNotFoundError("for that change");
      const latest = row.version === event.version && (event.kind === "archive") === Boolean(row.archived_at);
      if (!latest) throw new MemoryConflictError(`${row.name} changed since; restore an earlier version instead`);
      await db`UPDATE memory_events SET undone_at = now() WHERE id = ${eventId}`;
      if (event.kind === "archive") {
        const [back] = await db<MemoryRow[]>`
          UPDATE memories SET archived_at = NULL, updated_at = now() WHERE id = ${row.id} RETURNING *`;
        return { name: row.name, note: toNote(back) };
      }
      if (event.kind === "create" && row.version === 1) {
        await db`DELETE FROM memories WHERE id = ${row.id}`;
        return { name: row.name, note: null };
      }
      const [before] = await db<MemoryInput[]>`
        SELECT description, type, body FROM memory_versions
        WHERE memory_id = ${row.id} AND version = ${row.version - 1}`;
      // A note brought back from the archive goes back there.
      const next = await this.write(db, row, before, "user", null, event.kind === "create");
      return { name: row.name, note: toNote(next) };
    });
  }

  /** Records that Claude read a note in a run; null when there is no such note in use. */
  markRead(userId: string, name: string, run: MemoryRun): Promise<{ note: MemoryNote; event: MemoryEvent } | null> {
    if (!validName(name)) return Promise.resolve(null);
    return this.as(userId, async (db) => {
      const [row] = await db<MemoryRow[]>`
        UPDATE memories SET last_used_at = now()
        WHERE workspace_id = ${this.workspaceId} AND user_id = ${userId} AND name = ${name} AND archived_at IS NULL
        RETURNING *`;
      if (!row) return null;
      return { note: toNote(row), event: await this.event(db, userId, row, "read", run) };
    });
  }

  /** Notes in use whose name, description or body has the query's words, best first. */
  search(userId: string, query: string, limit = 10): Promise<(MemorySummary & { snippet: string })[]> {
    const words = [...new Set(query.toLowerCase().split(/\s+/).filter((w) => w.length > 1))].slice(0, 12);
    if (!words.length) return Promise.resolve([]);
    const patterns = words.map((w) => `%${w.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    return this.as(userId, async (db) => {
      const rows = await db<(MemoryRow & { score: number })[]>`
        SELECT * FROM (
          SELECT m.*, (
            SELECT count(*)::int FROM unnest(${patterns}::text[]) AS p(pattern)
            WHERE (m.name || ' ' || m.description || ' ' || m.body) ILIKE p.pattern
          ) AS score
          FROM memories m
          WHERE m.workspace_id = ${this.workspaceId} AND m.user_id = ${userId} AND m.archived_at IS NULL
        ) scored
        WHERE score > 0
        ORDER BY score DESC, updated_at DESC
        LIMIT ${Math.min(Math.max(limit, 1), 50)}`;
      return rows.map((row) => {
        const line = row.body.split("\n").find((l) => words.some((w) => l.toLowerCase().includes(w))) ?? "";
        return { ...toSummary(row), snippet: line.trim().slice(0, 200) };
      });
    });
  }

  /**
   * The index Claude gets in its prompt: one line per note in use, the most
   * recently used first, within `maxChars`.
   */
  async index(userId: string, maxChars = INDEX_CHARS): Promise<{ text: string; shown: number; total: number }> {
    const rows = await this.as(userId, (db) => db<Pick<MemoryRow, "name" | "type" | "description">[]>`
      SELECT name, type, description FROM memories
      WHERE workspace_id = ${this.workspaceId} AND user_id = ${userId} AND archived_at IS NULL
      ORDER BY coalesce(last_used_at, updated_at) DESC, name`);
    const lines: string[] = [];
    let size = 0;
    for (const row of rows) {
      const line = `- ${row.name} (${row.type}): ${row.description}`;
      if (size + line.length + 1 > maxChars) break;
      lines.push(line);
      size += line.length + 1;
    }
    return { text: lines.join("\n"), shown: lines.length, total: rows.length };
  }

  /** Whether memory is on for the user, and whether `threadId` is an incognito chat. */
  settings(userId: string, threadId?: string | null): Promise<{ mode: MemoryMode; incognito: boolean }> {
    return this.as(userId, async (db) => {
      const [setting] = await db<{ mode: MemoryMode }[]>`
        SELECT mode FROM memory_settings WHERE workspace_id = ${this.workspaceId} AND user_id = ${userId}`;
      const incognito = threadId
        ? (await db`
            SELECT 1 FROM memory_incognito_chats
            WHERE workspace_id = ${this.workspaceId} AND user_id = ${userId} AND thread_id = ${threadId}`).length > 0
        : false;
      return { mode: setting?.mode ?? "on", incognito };
    });
  }

  setMode(userId: string, mode: unknown): Promise<MemoryMode> {
    if (mode !== "on" && mode !== "off") return Promise.reject(new MemoryError("mode is on or off"));
    return this.as(userId, async (db) => {
      await db`
        INSERT INTO memory_settings (workspace_id, user_id, mode) VALUES (${this.workspaceId}, ${userId}, ${mode})
        ON CONFLICT (workspace_id, user_id) DO UPDATE SET mode = EXCLUDED.mode, updated_at = now()`;
      return mode;
    });
  }

  setIncognito(userId: string, threadId: unknown, incognito: boolean): Promise<boolean> {
    if (typeof threadId !== "string" || !threadId || threadId.length > 200) {
      return Promise.reject(new MemoryError("Say which chat: thread"));
    }
    return this.as(userId, async (db) => {
      if (incognito) {
        await db`
          INSERT INTO memory_incognito_chats (workspace_id, user_id, thread_id)
          VALUES (${this.workspaceId}, ${userId}, ${threadId}) ON CONFLICT DO NOTHING`;
      } else {
        await db`
          DELETE FROM memory_incognito_chats
          WHERE workspace_id = ${this.workspaceId} AND user_id = ${userId} AND thread_id = ${threadId}`;
      }
      return incognito;
    });
  }

  /** Every note as memory/<name>.md (archived ones under memory/archived/), zipped. */
  async exportZip(userId: string): Promise<Uint8Array> {
    const rows = await this.as(userId, (db) => db<MemoryRow[]>`
      SELECT * FROM memories WHERE workspace_id = ${this.workspaceId} AND user_id = ${userId} ORDER BY name`);
    const files: Record<string, Uint8Array> = {};
    for (const row of rows) {
      files[`memory/${row.archived_at ? "archived/" : ""}${row.name}.md`] = strToU8(toMarkdown(row));
    }
    return zipSync(files);
  }
}
