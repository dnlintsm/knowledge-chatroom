"""Each user's personalized memory, as MemoryService in apps/agent/src/storage/memory.ts (issue #93, migrations 018-021).

Short markdown notes Claude keeps about each user across chats, in the format
Claude Code's memory and SKILL.md use: a name, a one-line description, a type
and a body. Notes belong to one user. Every query names that user and runs in
that user's transaction (`scoped`, as the restricted role when row-level
security is on), so Postgres keeps notes private too: nobody else reads them,
workspace owners included.

Every change is a version. Claude's changes are also events, which the chat
shows and the user can undo; Claude's deletes only archive.

Claude's proposals go to the user's inbox (`propose`): imports always do
(memory_import.py). What a run uses (the index, reads, search, small edits)
serves /memory/agent (memory_agent.py). The background learner stays on the
TypeScript server until #190's step 8d.
"""

from __future__ import annotations

import io
import re
import time
import zipfile
from collections.abc import Callable
from contextlib import AbstractAsyncContextManager
from typing import Any

from psycopg import AsyncConnection
from psycopg.rows import dict_row

from .access import iso
from .paths import JS_SPACE, js_trim, utf16_len
from .text_index import from_units, to_units

MEMORY_TYPES = ("preference", "profile", "project", "reference", "feedback")
# Notes per user (archived ones not counted).
MAX_NOTES = 200
MAX_BODY = 16_000
MAX_DESCRIPTION = 300
# How much of the prompt the index of notes may take, in characters.
INDEX_CHARS = 6_000
# The run id the background learner records its changes under.
LEARN_RUN = "learn"
# Changes waiting in a user's inbox at most.
MAX_INBOX = 50
INBOX_OPS = ("add", "update", "delete")

_NAME = re.compile(r"[a-z0-9][a-z0-9-]{0,63}")
_ID = re.compile(r"[0-9a-fA-F-]{36}")
_SPACES = re.compile(f"[{JS_SPACE}]+")
_INBOX_COLUMNS = "id::text AS id, op, name, description, type, body, base_version, source, thread_id, reason, created_at"
_COLUMNS = (
    "id::text AS id, name, description, type, body, version, created_by, updated_by, "
    "archived_at, created_at, updated_at, last_used_at"
)

Scope = Callable[[], AbstractAsyncContextManager[AsyncConnection]]
# MemoryService.list shadows the builtin in the class body's later annotations.
Rows = list[dict[str, Any]]
_NOT_SLUG = re.compile(r"[^a-z0-9]+")


class MemoryError_(ValueError):
    """A bad request: answered with 400."""


class MemoryNotFoundError(LookupError):
    """No such note: answered with 404."""

    def __init__(self, name: str) -> None:
        super().__init__(f"No memory named {name}")


class MemoryConflictError(Exception):
    """The note changed since (e.g. undoing an older change): answered with 409."""


def valid_name(name: Any) -> bool:
    return isinstance(name, str) and bool(_NAME.fullmatch(name))


def check_name(name: Any) -> str:
    if not valid_name(name):
        raise MemoryError_(
            "A memory's name is lowercase letters, digits and dashes, at most 64 (e.g. writing-style)"
        )
    return name


def slugify(text: str) -> str:
    """A name from free text: "Writing style!" -> "writing-style"."""
    slug = _NOT_SLUG.sub("-", text.lower()).strip("-")
    return slug[:64].rstrip("-")


def clean_reason(reason: Any) -> str | None:
    """reason?.replace(/\\s+/g, " ").trim().slice(0, 500) || null."""
    if not isinstance(reason, str):
        return None
    return from_units(to_units(js_trim(_SPACES.sub(" ", reason)))[:500]) or None


def _js_string(value: Any) -> str:
    """String(value), for a name that isn't one."""
    if value is None:
        return "undefined"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, str):
        return value
    if isinstance(value, int | float):
        from .run_report import js_number

        return js_number(value)
    if isinstance(value, list):
        return ",".join("" if v is None else _js_string(v) for v in value)
    return "[object Object]"


def query_words(query: str, most: int) -> list[str]:
    """[...new Set(query.toLowerCase().split(/\\s+/).filter((w) => w.length > 1))].slice(0, most)."""
    words: list[str] = []
    for word in _SPACES.split(query.lower()):
        if utf16_len(word) > 1 and word not in words:
            words.append(word)
    return words[:most]


def like_pattern(word: str) -> str:
    """%word%, with ILIKE's \\ % and _ escaped."""
    return "%" + re.sub(r"[\\%_]", lambda m: "\\" + m.group(0), word) + "%"


def snippet(body: str, words: list[str]) -> str:
    """The first line with one of the words, trimmed, at most 200 characters."""
    line = next((line for line in body.split("\n") if any(w in line.lower() for w in words)), "")
    return from_units(to_units(js_trim(line))[:200])


def _date(value: Any) -> str:
    """toISOString().slice(0, 10): the UTC date."""
    return (iso(value) or "")[:10]


def check_input(given: dict[str, Any]) -> dict[str, str]:
    """The input, cleaned: one-line description, known type, body within limits (checkInput)."""
    raw = given.get("description")
    description = js_trim(_SPACES.sub(" ", raw)) if isinstance(raw, str) else ""
    if not description:
        raise MemoryError_("A memory needs a one-line description")
    if utf16_len(description) > MAX_DESCRIPTION:
        raise MemoryError_(f"A memory's description is at most {MAX_DESCRIPTION} characters")
    kind = given.get("type")
    kind = "preference" if kind is None else kind
    if not isinstance(kind, str) or kind not in MEMORY_TYPES:
        raise MemoryError_(f"A memory's type is one of {', '.join(MEMORY_TYPES)}")
    raw = given.get("body")
    body = js_trim(re.sub(r"\r\n?", "\n", raw)) if isinstance(raw, str) else ""
    if utf16_len(body) > MAX_BODY:
        raise MemoryError_(f"A memory is at most {MAX_BODY} characters")
    return {"description": description, "type": kind, "body": body}


def to_markdown(note: dict[str, Any]) -> str:
    """A note as a markdown file with front matter, as export and Claude's view show it."""
    return f"---\nname: {note['name']}\ndescription: {note['description']}\ntype: {note['type']}\n---\n\n{note['body']}\n"


def _note(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "name": row["name"],
        "description": row["description"],
        "type": row["type"],
        "body": row["body"],
        "version": row["version"],
        "createdBy": row["created_by"],
        "updatedBy": row["updated_by"],
        "archived": row["archived_at"] is not None,
        "createdAt": iso(row["created_at"]),
        "updatedAt": iso(row["updated_at"]),
        "lastUsedAt": iso(row["last_used_at"]),
    }


def _summary(row: dict[str, Any]) -> dict[str, Any]:
    note = _note(row)
    del note["body"]
    return note


def _inbox_item(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": row["id"],
        "op": row["op"],
        "name": row["name"],
        "description": row["description"],
        "type": row["type"],
        "body": row["body"],
        "baseVersion": row["base_version"],
        "source": row["source"],
        "threadId": row["thread_id"],
        "reason": row["reason"],
        "createdAt": iso(row["created_at"]),
    }


async def _rows(conn: AsyncConnection, sql: str, params: Any = ()) -> list[dict[str, Any]]:
    cur = conn.cursor(row_factory=dict_row)
    await cur.execute(sql, params)
    return await cur.fetchall()


async def _one(conn: AsyncConnection, sql: str, params: Any = ()) -> dict[str, Any] | None:
    rows = await _rows(conn, sql, params)
    return rows[0] if rows else None


class MemoryService:
    """One user's memory; `scoped` opens that user's transaction (Session.scoped)."""

    def __init__(self, scoped: Scope, workspace_id: str, user_id: str) -> None:
        self.scoped = scoped
        self.ws = workspace_id
        self.user = user_id

    async def _row(
        self, conn: AsyncConnection, name: str, lock: bool = False
    ) -> dict[str, Any] | None:
        return await _one(
            conn,
            f"SELECT {_COLUMNS} FROM memories WHERE workspace_id = %s AND user_id = %s AND name = %s"
            + (" FOR UPDATE" if lock else ""),
            (self.ws, self.user, name),
        )

    async def _event(
        self, conn: AsyncConnection, row: dict[str, Any], kind: str, run: dict[str, str]
    ) -> dict[str, Any]:
        found = await _one(
            conn,
            """
            INSERT INTO memory_events (workspace_id, user_id, memory_id, thread_id, run_id, kind, version)
            VALUES (%s, %s, %s, %s, %s, %s, %s)
            RETURNING id::text AS id""",
            (self.ws, self.user, row["id"], run["threadId"], run["runId"], kind, row["version"]),
        )
        assert found is not None
        return {
            "id": found["id"],
            "name": row["name"],
            "description": row["description"],
            "kind": kind,
            "version": row["version"],
        }

    async def _write(
        self,
        conn: AsyncConnection,
        row: dict[str, Any],
        given: dict[str, Any],
        by: str,
        thread_id: str | None,
        archived: bool = False,
    ) -> dict[str, Any]:
        """Writes new content as the note's next version (and brings it back if archived)."""
        nxt = await _one(
            conn,
            f"""
            UPDATE memories SET
              description = %s, type = %s, body = %s,
              version = version + 1, updated_by = %s, updated_at = now(),
              archived_at = {"now()" if archived else "NULL"}
            WHERE id = %s
            RETURNING {_COLUMNS}""",
            (given["description"], given["type"], given["body"], by, row["id"]),
        )
        assert nxt is not None
        await conn.execute(
            """
            INSERT INTO memory_versions (memory_id, version, description, type, body, changed_by, thread_id)
            VALUES (%s, %s, %s, %s, %s, %s, %s)""",
            (
                nxt["id"],
                nxt["version"],
                nxt["description"],
                nxt["type"],
                nxt["body"],
                by,
                thread_id,
            ),
        )
        return nxt

    async def _check_room(self, conn: AsyncConnection) -> None:
        found = await _one(
            conn,
            "SELECT count(*)::int AS count FROM memories WHERE workspace_id = %s AND user_id = %s AND archived_at IS NULL",
            (self.ws, self.user),
        )
        if found and found["count"] >= MAX_NOTES:
            raise MemoryError_(
                f"You have {MAX_NOTES} memories, the most there can be: delete or merge some first"
            )

    async def list(self) -> list[dict[str, Any]]:
        """The user's notes, the ones in use first, then archived ones, newest first."""
        async with self.scoped() as conn:
            rows = await _rows(
                conn,
                f"""
                SELECT {_COLUMNS} FROM memories WHERE workspace_id = %s AND user_id = %s
                ORDER BY archived_at IS NOT NULL, updated_at DESC, name""",
                (self.ws, self.user),
            )
        return [_summary(r) for r in rows]

    async def get(self, name: str) -> dict[str, Any] | None:
        """One note with its body; None when the user has none of that name."""
        if not valid_name(name):
            return None
        async with self.scoped() as conn:
            row = await self._row(conn, name)
        return _note(row) if row else None

    async def versions(self, name: str) -> list[dict[str, Any]]:
        """A note's versions, newest first."""
        check_name(name)
        async with self.scoped() as conn:
            row = await self._row(conn, name)
            if not row:
                raise MemoryNotFoundError(name)
            rows = await _rows(
                conn,
                """
                SELECT version, description, type, body, changed_by, thread_id, created_at
                FROM memory_versions WHERE memory_id = %s ORDER BY version DESC""",
                (row["id"],),
            )
        return [
            {
                "version": r["version"],
                "description": r["description"],
                "type": r["type"],
                "body": r["body"],
                "changedBy": r["changed_by"],
                "threadId": r["thread_id"],
                "createdAt": iso(r["created_at"]),
            }
            for r in rows
        ]

    async def save(
        self,
        name: str,
        given: dict[str, Any],
        by: str,
        *,
        run: dict[str, str] | None = None,
        create: bool = False,
        if_version: int | None = None,
    ) -> tuple[dict[str, Any], dict[str, Any] | None]:
        """
        Creates or replaces a note. `run` (Claude's writes) records an event the
        chat shows and the user can undo. `create` refuses a name in use;
        `if_version` refuses a note that is at another version by now. Saving the
        same content again changes nothing and records nothing.
        """
        check_name(name)
        clean = check_input(given)
        thread_id = run["threadId"] if run else None
        async with self.scoped() as conn:
            row = await self._row(conn, name, lock=True)
            if row and create and not row["archived_at"]:
                raise MemoryConflictError(f"A memory named {name} already exists")
            if if_version is not None and (
                not row or row["archived_at"] or row["version"] != if_version
            ):
                raise MemoryConflictError(f"{name} changed meanwhile; view it again")
            if not row or row["archived_at"]:
                await self._check_room(conn)
            if not row:
                created = await _one(
                    conn,
                    f"""
                    INSERT INTO memories (workspace_id, user_id, name, description, type, body, created_by, updated_by)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                    RETURNING {_COLUMNS}""",
                    (
                        self.ws,
                        self.user,
                        name,
                        clean["description"],
                        clean["type"],
                        clean["body"],
                        by,
                        by,
                    ),
                )
                assert created is not None
                await conn.execute(
                    """
                    INSERT INTO memory_versions (memory_id, version, description, type, body, changed_by, thread_id)
                    VALUES (%s, 1, %s, %s, %s, %s, %s)""",
                    (
                        created["id"],
                        created["description"],
                        created["type"],
                        created["body"],
                        by,
                        thread_id,
                    ),
                )
                event = await self._event(conn, created, "create", run) if run else None
                return _note(created), event
            same = all(row[k] == clean[k] for k in ("description", "type", "body"))
            if same and not row["archived_at"]:
                return _note(row), None
            nxt = await self._write(conn, row, clean, by, thread_id)
            # Bringing an archived note back counts as creating it, for Undo.
            kind = "create" if row["archived_at"] else "update"
            event = await self._event(conn, nxt, kind, run) if run else None
            return _note(nxt), event

    async def archive(
        self, name: str, archived: bool, run: dict[str, str] | None = None
    ) -> tuple[dict[str, Any], dict[str, Any] | None]:
        """Archives (or brings back) a note: out of Claude's index, kept with its versions."""
        check_name(name)
        async with self.scoped() as conn:
            row = await self._row(conn, name, lock=True)
            if not row:
                raise MemoryNotFoundError(name)
            if (row["archived_at"] is not None) == archived:
                return _note(row), None
            if not archived:
                await self._check_room(conn)
            nxt = await _one(
                conn,
                f"""
                UPDATE memories SET archived_at = {"now()" if archived else "NULL"}, updated_at = now()
                WHERE id = %s RETURNING {_COLUMNS}""",
                (row["id"],),
            )
            assert nxt is not None
            event = await self._event(conn, nxt, "archive", run) if run and archived else None
            return _note(nxt), event

    async def remove(self, name: str) -> bool:
        """Deletes a note for good, with every version and event."""
        if not valid_name(name):
            return False
        async with self.scoped() as conn:
            rows = await _rows(
                conn,
                "DELETE FROM memories WHERE workspace_id = %s AND user_id = %s AND name = %s RETURNING id::text AS id",
                (self.ws, self.user, name),
            )
        return bool(rows)

    async def restore(self, name: str, version: int) -> dict[str, Any]:
        """Makes an earlier version the current one again (as a new version), and brings the note back."""
        check_name(name)
        async with self.scoped() as conn:
            row = await self._row(conn, name, lock=True)
            if not row:
                raise MemoryNotFoundError(name)
            old = await _one(
                conn,
                "SELECT description, type, body FROM memory_versions WHERE memory_id = %s AND version = %s",
                (row["id"], version),
            )
            if not old:
                raise MemoryNotFoundError(f"{name} version {version}")
            if row["archived_at"]:
                await self._check_room(conn)
            return _note(await self._write(conn, row, old, "user", None))

    async def undo(self, event_id: str) -> dict[str, Any]:
        """
        Undoes one of Claude's changes, when it is still the note's latest: a new
        note goes away, an update goes back to the version before it (as a new
        version), an archived note comes back.
        """
        if not _ID.fullmatch(event_id):
            raise MemoryNotFoundError("for that change")
        async with self.scoped() as conn:
            event = await _one(
                conn,
                """
                SELECT memory_id::text AS memory_id, kind, version, undone_at FROM memory_events
                WHERE id = %s AND user_id = %s AND workspace_id = %s""",
                (event_id, self.user, self.ws),
            )
            if not event or event["kind"] == "read":
                raise MemoryNotFoundError("for that change")
            if event["undone_at"]:
                raise MemoryConflictError("That change was already undone")
            # Every change (archiving included) sets updated_at in the transaction
            # that records its event, so a later one shows as a later updated_at.
            row = await _one(
                conn,
                f"""
                SELECT {", ".join("m." + c.strip() for c in _COLUMNS.split(","))}, m.updated_at <= e.created_at AS fresh
                FROM memories m JOIN memory_events e ON e.memory_id = m.id
                WHERE e.id = %s
                FOR UPDATE OF m""",
                (event_id,),
            )
            if not row:
                raise MemoryNotFoundError("for that change")
            latest = (
                row["fresh"]
                and row["version"] == event["version"]
                and (event["kind"] == "archive") == (row["archived_at"] is not None)
            )
            if not latest:
                raise MemoryConflictError(
                    f"{row['name']} changed since; restore an earlier version instead"
                )
            await conn.execute(
                "UPDATE memory_events SET undone_at = now() WHERE id = %s", (event_id,)
            )
            if event["kind"] == "archive":
                back = await _one(
                    conn,
                    f"UPDATE memories SET archived_at = NULL, updated_at = now() WHERE id = %s RETURNING {_COLUMNS}",
                    (row["id"],),
                )
                assert back is not None
                return {"name": row["name"], "note": _note(back)}
            if event["kind"] == "create" and row["version"] == 1:
                await conn.execute("DELETE FROM memories WHERE id = %s", (row["id"],))
                return {"name": row["name"], "note": None}
            before = await _one(
                conn,
                "SELECT description, type, body FROM memory_versions WHERE memory_id = %s AND version = %s",
                (row["id"], row["version"] - 1),
            )
            # A note brought back from the archive goes back there.
            nxt = await self._write(
                conn, row, before or {}, "user", None, archived=event["kind"] == "create"
            )
            return {"name": row["name"], "note": _note(nxt)}

    async def settings(self, thread_id: str | None = None) -> dict[str, Any]:
        """Whether memory is on for the user, and whether `thread_id` is an incognito chat."""
        async with self.scoped() as conn:
            setting = await _one(
                conn,
                "SELECT mode FROM memory_settings WHERE workspace_id = %s AND user_id = %s",
                (self.ws, self.user),
            )
            incognito = False
            if thread_id:
                incognito = bool(
                    await _rows(
                        conn,
                        """
                        SELECT 1 AS found FROM memory_incognito_chats
                        WHERE workspace_id = %s AND user_id = %s AND thread_id = %s""",
                        (self.ws, self.user, thread_id),
                    )
                )
        return {"mode": setting["mode"] if setting else "on", "incognito": incognito}

    async def set_mode(self, mode: Any) -> str:
        if not isinstance(mode, str) or mode not in ("on", "ask", "off"):
            raise MemoryError_("mode is on, ask or off")
        async with self.scoped() as conn:
            await conn.execute(
                """
                INSERT INTO memory_settings (workspace_id, user_id, mode) VALUES (%s, %s, %s)
                ON CONFLICT (workspace_id, user_id) DO UPDATE SET mode = EXCLUDED.mode, updated_at = now()""",
                (self.ws, self.user, mode),
            )
        return mode

    async def set_incognito(self, thread_id: Any, incognito: bool) -> bool:
        if not isinstance(thread_id, str) or not thread_id or utf16_len(thread_id) > 200:
            raise MemoryError_("Say which chat: thread")
        async with self.scoped() as conn:
            if incognito:
                await conn.execute(
                    """
                    INSERT INTO memory_incognito_chats (workspace_id, user_id, thread_id)
                    VALUES (%s, %s, %s) ON CONFLICT DO NOTHING""",
                    (self.ws, self.user, thread_id),
                )
            else:
                await conn.execute(
                    "DELETE FROM memory_incognito_chats WHERE workspace_id = %s AND user_id = %s AND thread_id = %s",
                    (self.ws, self.user, thread_id),
                )
        return incognito

    async def inbox(self) -> list[dict[str, Any]]:
        """Changes waiting for the user, oldest first."""
        async with self.scoped() as conn:
            rows = await _rows(
                conn,
                """
                SELECT id::text AS id, op, name, description, type, body, base_version, source, thread_id,
                       reason, created_at
                FROM memory_inbox WHERE workspace_id = %s AND user_id = %s AND status = 'pending'
                ORDER BY created_at, id""",
                (self.ws, self.user),
            )
        return [_inbox_item(r) for r in rows]

    async def index(self, max_chars: int = INDEX_CHARS) -> dict[str, Any]:
        """
        The index Claude gets in its prompt: one line per note in use, the most
        recently used first, within `max_chars`: {text, shown, total}.
        """
        async with self.scoped() as conn:
            rows = await _rows(
                conn,
                """
                SELECT name, type, description FROM memories
                WHERE workspace_id = %s AND user_id = %s AND archived_at IS NULL
                ORDER BY coalesce(last_used_at, updated_at) DESC, name""",
                (self.ws, self.user),
            )
        lines: list[str] = []
        size = 0
        for row in rows:
            line = f"- {row['name']} ({row['type']}): {row['description']}"
            if size + utf16_len(line) + 1 > max_chars:
                break
            lines.append(line)
            size += utf16_len(line) + 1
        return {"text": "\n".join(lines), "shown": len(lines), "total": len(rows)}

    async def mark_read(
        self, name: str, run: dict[str, str]
    ) -> tuple[dict[str, Any], dict[str, Any]] | None:
        """Records that Claude read a note in a run; None when there is no such note in use."""
        if not valid_name(name):
            return None
        async with self.scoped() as conn:
            row = await _one(
                conn,
                f"""
                UPDATE memories SET last_used_at = now()
                WHERE workspace_id = %s AND user_id = %s AND name = %s AND archived_at IS NULL
                RETURNING {_COLUMNS}""",
                (self.ws, self.user, name),
            )
            if not row:
                return None
            return _note(row), await self._event(conn, row, "read", run)

    async def texts(self) -> Rows:
        """Every note in use, with its text: for search by meaning (memory_agent.py)."""
        async with self.scoped() as conn:
            return await _rows(
                conn,
                """
                SELECT name, description, type, body, version FROM memories
                WHERE workspace_id = %s AND user_id = %s AND archived_at IS NULL
                ORDER BY name""",
                (self.ws, self.user),
            )

    async def search(self, query: str, limit: int = 10) -> Rows:
        """Notes in use whose name, description or body has the query's words, best first."""
        words = query_words(query, 12)
        if not words:
            return []
        async with self.scoped() as conn:
            rows = await _rows(
                conn,
                f"""
                SELECT * FROM (
                  SELECT {_COLUMNS}, (
                    SELECT count(*)::int FROM unnest(%s::text[]) AS p(pattern)
                    WHERE (m.name || ' ' || m.description || ' ' || m.body) ILIKE p.pattern
                  ) AS score
                  FROM memories m
                  WHERE m.workspace_id = %s AND m.user_id = %s AND m.archived_at IS NULL
                ) scored
                WHERE score > 0
                ORDER BY score DESC, updated_at DESC
                LIMIT %s""",
                ([like_pattern(w) for w in words], self.ws, self.user, min(max(limit, 1), 50)),
            )
        return [{**_summary(row), "snippet": snippet(row["body"], words)} for row in rows]

    async def replace_text(
        self, name: str, old_text: str, new_text: str, by: str, run: dict[str, str] | None = None
    ) -> tuple[dict[str, Any], dict[str, Any] | None]:
        """Replaces the one occurrence of `old_text` in a note's body (Claude's small edits)."""
        note = await self.get(name)
        if not note or note["archived"]:
            raise MemoryNotFoundError(name)
        if not old_text:
            raise MemoryError_("Say which text to replace")
        count = note["body"].count(old_text)
        if count != 1:
            raise MemoryError_(
                f"That text isn't in {name}; view it and copy the text exactly"
                if count == 0
                else f"That text is in {name} {count} times; include more around it so it's unique"
            )
        # Only onto the version just read, so a change made meanwhile isn't lost.
        body = note["body"].replace(old_text, new_text, 1)
        return await self.save(
            name, {**note, "body": body}, by, run=run, if_version=note["version"]
        )

    async def propose(
        self,
        change: dict[str, Any],
        source: str,
        thread_id: str | None = None,
    ) -> dict[str, Any]:
        """
        Puts a change in the user's inbox instead of making it: `change` is
        {op, name, input?, reason?, baseVersion?}. A pending change to the same
        note with the same op is replaced, so the inbox holds the latest one.
        """
        op, name = change.get("op"), change.get("name")
        if op not in INBOX_OPS:
            raise MemoryError_("op is add, update or delete")
        if not isinstance(name, str) or not valid_name(name):
            raise MemoryError_(f"Invalid memory name: {_js_string(name)}")
        clean = None if op == "delete" else check_input(change.get("input") or {})
        reason = clean_reason(change.get("reason"))
        async with self.scoped() as conn:
            row = await self._row(conn, name)
            if op == "add" and row and not row["archived_at"]:
                raise MemoryConflictError(f"A memory named {name} already exists")
            if op != "add" and (not row or row["archived_at"]):
                raise MemoryNotFoundError(name)
            base_given = change.get("baseVersion")
            if op != "add" and base_given is not None and row and row["version"] != base_given:
                raise MemoryConflictError(f"{name} changed since")
            base = None if op == "add" or not row else row["version"]
            content = (
                (clean["description"], clean["type"], clean["body"])
                if clean
                else (None, None, None)
            )
            pending = await _one(
                conn,
                """
                SELECT id FROM memory_inbox
                WHERE workspace_id = %s AND user_id = %s AND status = 'pending' AND name = %s AND op = %s
                FOR UPDATE""",
                (self.ws, self.user, name, op),
            )
            if pending:
                item = await _one(
                    conn,
                    f"""
                    UPDATE memory_inbox SET
                      description = %s, type = %s, body = %s, base_version = %s, source = %s,
                      thread_id = %s, reason = %s, created_at = now()
                    WHERE id = %s RETURNING {_INBOX_COLUMNS}""",
                    (*content, base, source, thread_id, reason, pending["id"]),
                )
            else:
                counted = await _one(
                    conn,
                    """
                    SELECT count(*)::int AS count FROM memory_inbox
                    WHERE workspace_id = %s AND user_id = %s AND status = 'pending'""",
                    (self.ws, self.user),
                )
                if counted and counted["count"] >= MAX_INBOX:
                    raise MemoryError_(
                        f"The memory inbox has {MAX_INBOX} changes waiting; review some first"
                    )
                item = await _one(
                    conn,
                    f"""
                    INSERT INTO memory_inbox
                      (workspace_id, user_id, op, name, description, type, body, base_version, source,
                       thread_id, reason)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                    RETURNING {_INBOX_COLUMNS}""",
                    (self.ws, self.user, op, name, *content, base, source, thread_id, reason),
                )
        assert item is not None
        return _inbox_item(item)

    async def notes_for_learning(self, max_chars: int = 24_000) -> tuple[str, dict[str, int]]:
        """
        The notes in use, in full where they fit in `max_chars`, for a model to
        compare new memory against. The map has the notes shown in full, at the
        version shown: only those may be changed.
        """
        async with self.scoped() as conn:
            rows = await _rows(
                conn,
                f"""
                SELECT {_COLUMNS} FROM memories
                WHERE workspace_id = %s AND user_id = %s AND archived_at IS NULL
                ORDER BY coalesce(last_used_at, updated_at) DESC, name""",
                (self.ws, self.user),
            )
        parts: list[str] = []
        versions: dict[str, int] = {}
        size = 0
        for row in rows:
            used = _date(row["last_used_at"]) if row["last_used_at"] else "never"
            head = (
                f'<note name="{row["name"]}" type="{row["type"]}" updated="{_date(row["updated_at"])}" '
                f'last_used="{used}">'
            )
            full = f"{head}\n{row['description']}\n\n{row['body']}\n</note>"
            whole = size + utf16_len(full) <= max_chars
            text = (
                full
                if whole
                else f"{head}\n{row['description']}\n(body left out for length; leave this note as it is)\n</note>"
            )
            if size + utf16_len(text) > max_chars:
                break
            parts.append(text)
            if whole:
                versions[row["name"]] = row["version"]
            size += utf16_len(text)
        return "\n".join(parts), versions

    async def accept(self, item_id: str) -> tuple[dict[str, Any] | None, dict[str, Any] | None]:
        """
        Makes a proposed change, as Claude's (so it shows in the activity with
        Undo). Refused when the note changed since it was proposed.
        """
        item = await self._decide(item_id, "accepted")
        run = {"threadId": item["threadId"] or "", "runId": "inbox"}
        try:
            if item["op"] == "delete":
                note = await self.get(item["name"])
                if not note or note["archived"] or note["version"] != item["baseVersion"]:
                    raise MemoryConflictError(f"{item['name']} changed since Claude proposed this")
                return await self.archive(item["name"], True, run)
            given = {"description": item["description"], "type": item["type"], "body": item["body"]}
            return await self.save(
                item["name"],
                given,
                "agent",
                run=run,
                create=item["op"] == "add",
                if_version=item["baseVersion"] if item["op"] == "update" else None,
            )
        except Exception as err:
            # Back to waiting, so the user can reject it or look again.
            async with self.scoped() as conn:
                await conn.execute(
                    "UPDATE memory_inbox SET status = 'pending', decided_at = NULL WHERE id = %s",
                    (item_id,),
                )
            if isinstance(err, MemoryConflictError):
                raise MemoryConflictError(
                    f"{item['name']} changed since Claude proposed this; reject it, or edit the note yourself"
                ) from err
            raise

    async def reject(self, item_id: str) -> None:
        """Drops a proposed change."""
        await self._decide(item_id, "rejected")

    async def _decide(self, item_id: str, status: str) -> dict[str, Any]:
        if not _ID.fullmatch(item_id):
            raise MemoryNotFoundError("change in the inbox")
        async with self.scoped() as conn:
            row = await _one(
                conn,
                """
                UPDATE memory_inbox SET status = %s, decided_at = now()
                WHERE id = %s AND user_id = %s AND workspace_id = %s AND status = 'pending'
                RETURNING id::text AS id, op, name, description, type, body, base_version, source, thread_id,
                          reason, created_at""",
                (status, item_id, self.user, self.ws),
            )
        if not row:
            raise MemoryNotFoundError("change in the inbox")
        return _inbox_item(row)

    async def activity(self, limit: int = 30) -> list[dict[str, Any]]:
        """Claude's recent changes to the user's notes, newest first."""
        async with self.scoped() as conn:
            rows = await _rows(
                conn,
                """
                SELECT e.id::text AS id, m.name, m.description, e.kind, e.version, e.thread_id, e.run_id,
                  e.created_at, e.undone_at,
                  -- The same test undo() makes.
                  e.undone_at IS NULL AND m.updated_at <= e.created_at AND m.version = e.version
                    AND (e.kind = 'archive') = (m.archived_at IS NOT NULL) AS undoable
                FROM memory_events e JOIN memories m ON m.id = e.memory_id
                WHERE e.workspace_id = %s AND e.user_id = %s AND e.kind <> 'read'
                ORDER BY e.created_at DESC, e.id
                LIMIT %s""",
                (self.ws, self.user, min(max(limit, 1), 100)),
            )
        return [
            {
                "id": r["id"],
                "name": r["name"],
                "description": r["description"],
                "kind": r["kind"],
                "version": r["version"],
                "threadId": r["thread_id"],
                "source": "learn"
                if r["run_id"] == LEARN_RUN
                else "inbox"
                if r["run_id"] == "inbox"
                else "chat",
                "at": iso(r["created_at"]),
                "undone": r["undone_at"] is not None,
                "undoable": r["undoable"],
            }
            for r in rows
        ]

    async def export_zip(self) -> bytes:
        """Every note as memory/<name>.md (archived ones under memory/archived/), zipped."""
        async with self.scoped() as conn:
            rows = await _rows(
                conn,
                f"SELECT {_COLUMNS} FROM memories WHERE workspace_id = %s AND user_id = %s ORDER BY name",
                (self.ws, self.user),
            )
        out = io.BytesIO()
        stamp = time.localtime()[:6]
        with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as archive:
            for row in rows:
                path = f"memory/{'archived/' if row['archived_at'] else ''}{row['name']}.md"
                entry = zipfile.ZipInfo(path, date_time=stamp)
                entry.compress_type = zipfile.ZIP_DEFLATED
                archive.writestr(entry, to_markdown(row).encode())
        return out.getvalue()
