"""Chat history, as ChatService in apps/agent/src/storage/chats.ts (issue #91, migrations/017_chats.sql).

Each AG-UI thread the app's chat runs is a chat owned by the user who started
it. The app's CopilotKit runner (apps/web/src/lib/chat-runner.ts) saves every
finished run here and replays a chat's runs when it is opened again.

Every query names its user and runs in that user's transaction (Session.scoped),
as the restricted role when row-level security is on, so Postgres keeps chats
private too: nobody reads another person's chats, workspace owners included.

Claude searches past chats and reads one (search_chats, chat_lines_of) through
/memory/agent (memory_agent.py). Incognito chats are never found or read.
"""

from __future__ import annotations

import re
from datetime import datetime
from typing import Any

from psycopg import AsyncConnection
from psycopg.types.json import Jsonb

from .access import iso
from .memory import _js_string, like_pattern, query_words
from .paths import JS_SPACE, js_trim
from .run_report import js_json
from .text_index import from_units, to_units

MAX_NAME = 200
# Words searched for at most, and the characters of each line shown around them.
MAX_WORDS = 8
SNIPPET = 160
_ELLIPSIS = "\u2026"
_SPACES = re.compile(f"[{JS_SPACE}]+")
_COLUMNS = "id, name, agent_id, archived, created_at, updated_at, last_run_at"


class ChatError(ValueError):
    """A bad request: answered with 400."""


class ChatTakenError(Exception):
    """The thread id is another user's chat: answered with 403."""

    def __init__(self) -> None:
        super().__init__("This chat belongs to someone else")


def valid_chat_id(value: Any) -> bool:
    """1 to 200 characters, counted as JavaScript counts them."""
    return isinstance(value, str) and 0 < len(to_units(value)) <= 200


def clean_name(name: str | None) -> str | None:
    """Spaces collapsed, trimmed and cut to MAX_NAME characters; None when nothing is left."""
    if name is None:
        return None
    clean = from_units(to_units(js_trim(_SPACES.sub(" ", name)))[:MAX_NAME])
    return clean or None


def _to_json(value: Any) -> Jsonb:
    """Stored as JSON.stringify writes it, so a chat reads the same whichever server saved it."""
    return Jsonb(value, dumps=js_json)


def _summary(row: tuple) -> dict[str, Any]:
    id_, name, agent_id, archived, created_at, updated_at, last_run_at = row[:7]
    return {
        "id": id_,
        "name": name,
        "agentId": agent_id,
        "archived": archived,
        "createdAt": iso(created_at),
        "updatedAt": iso(updated_at),
        "lastRunAt": iso(last_run_at),
    }


def _read_cursor(cursor: str) -> tuple[str, str]:
    """A cursor is the last row's "<updatedAt>|<id>", updatedAt as Postgres writes timestamptz."""
    bar = cursor.find("|")
    at = cursor[:bar] if bar >= 0 else cursor
    valid = bar >= 1
    if valid:
        try:
            datetime.fromisoformat(re.sub(r"([+-]\d\d)$", r"\1:00", at))
        except ValueError:
            valid = False
    if not valid:
        raise ChatError("Invalid cursor")
    return at, cursor[bar + 1 :]


def _limit(value: int | None) -> int:
    """Math.min(Math.max(Math.trunc(limit ?? 50) || 50, 1), 200)."""
    return min(max(value or 50, 1), 200)


async def list_chats(
    conn: AsyncConnection,
    workspace_id: str,
    user_id: str,
    *,
    agent_id: str | None = None,
    include_archived: bool = False,
    limit: int | None = None,
    cursor: str | None = None,
) -> dict[str, Any]:
    """The user's chats, most recently active first, a page at a time."""
    count = _limit(limit)
    after = _read_cursor(cursor) if cursor else None
    sql = [
        f"SELECT {_COLUMNS}, updated_at::text AS at FROM chats WHERE user_id = %s AND workspace_id = %s"
    ]
    params: list[Any] = [user_id, workspace_id]
    if agent_id:
        sql.append("AND agent_id = %s")
        params.append(agent_id)
    if not include_archived:
        sql.append("AND NOT archived")
    if after:
        # The cursor keeps updated_at to the microsecond, as text.
        sql.append("AND (updated_at, id) < (%s::timestamptz, %s)")
        params.extend(after)
    sql.append("ORDER BY updated_at DESC, id DESC LIMIT %s")
    params.append(count + 1)
    cur = await conn.execute(" ".join(sql), params)
    rows = await cur.fetchall()
    page = rows[:count]
    last = page[-1] if page else None
    return {
        "threads": [_summary(r) for r in page],
        "nextCursor": f"{last[7]}|{last[0]}" if len(rows) > count and last else None,
    }


async def get_chat(
    conn: AsyncConnection, workspace_id: str, user_id: str, chat_id: str
) -> dict[str, Any] | None:
    """One of the user's chats in the workspace, with its latest messages; None when it isn't theirs or there."""
    if not valid_chat_id(chat_id):
        return None
    cur = await conn.execute(
        f"SELECT {_COLUMNS}, messages FROM chats WHERE id = %s AND user_id = %s AND workspace_id = %s",
        (chat_id, user_id, workspace_id),
    )
    row = await cur.fetchone()
    return {"chat": _summary(row), "messages": row[7]} if row else None


async def chat_runs(
    conn: AsyncConnection, workspace_id: str, user_id: str, chat_id: str
) -> list[dict[str, Any]] | None:
    """The chat's runs in order; None when it isn't the user's, in this workspace."""
    if not valid_chat_id(chat_id):
        return None
    cur = await conn.execute(
        "SELECT 1 FROM chats WHERE id = %s AND user_id = %s AND workspace_id = %s",
        (chat_id, user_id, workspace_id),
    )
    if await cur.fetchone() is None:
        return None
    cur = await conn.execute(
        "SELECT run_id, parent_run_id, events, created_at FROM chat_runs WHERE chat_id = %s ORDER BY seq",
        (chat_id,),
    )
    return [
        {"runId": run_id, "parentRunId": parent, "events": events, "createdAt": iso(created_at)}
        for run_id, parent, events, created_at in await cur.fetchall()
    ]


async def append_run(
    conn: AsyncConnection, workspace_id: str, user_id: str, chat_id: str, run: dict[str, Any]
) -> dict[str, Any]:
    """Saves a finished run, starting the chat on its first. Raises ChatTakenError for another user's chat."""
    await conn.execute(
        "INSERT INTO chats (id, workspace_id, user_id, agent_id) VALUES (%s, %s, %s, %s) ON CONFLICT (id) DO NOTHING",
        (chat_id, workspace_id, user_id, run["agentId"]),
    )
    # Locks the chat, so two runs saved at once get their own seq. Another
    # user's chat isn't found (row security hides it, the user_id test too),
    # nor one in another workspace: a chat lives in one.
    cur = await conn.execute(
        "SELECT 1 FROM chats WHERE id = %s AND user_id = %s AND workspace_id = %s FOR UPDATE",
        (chat_id, user_id, workspace_id),
    )
    if await cur.fetchone() is None:
        raise ChatTakenError()
    await conn.execute(
        """
        INSERT INTO chat_runs (chat_id, seq, run_id, parent_run_id, events)
        SELECT %s, coalesce(max(seq), 0) + 1, %s, %s, %s FROM chat_runs WHERE chat_id = %s""",
        (chat_id, run["runId"], run.get("parentRunId"), _to_json(run["events"]), chat_id),
    )
    cur = await conn.execute(
        f"""
        UPDATE chats SET messages = %s, name = coalesce(name, %s), updated_at = now(), last_run_at = now()
        WHERE id = %s RETURNING {_COLUMNS}""",
        (_to_json(run["messages"]), clean_name(run.get("name")), chat_id),
    )
    return _summary(await cur.fetchone())  # pyrefly: ignore[bad-argument-type]


_KEEP = object()


async def update_chat(
    conn: AsyncConnection,
    workspace_id: str,
    user_id: str,
    chat_id: str,
    *,
    name: Any = _KEEP,
    archived: Any = _KEEP,
) -> dict[str, Any] | None:
    """Renames or (un)archives one of the user's chats; None when it isn't theirs."""
    if not valid_chat_id(chat_id):
        return None
    sets, params = [], []
    if name is not _KEEP:
        sets.append("name = %s")
        params.append(clean_name(name))
    if archived is not _KEEP:
        sets.append("archived = %s")
        params.append(archived)
    cur = await conn.execute(
        f"UPDATE chats SET {', '.join(sets) or 'name = name'} "
        f"WHERE id = %s AND user_id = %s AND workspace_id = %s RETURNING {_COLUMNS}",
        (*params, chat_id, user_id, workspace_id),
    )
    row = await cur.fetchone()
    return _summary(row) if row else None


async def remove_chat(conn: AsyncConnection, workspace_id: str, user_id: str, chat_id: str) -> bool:
    """Deletes one of the user's chats in the workspace for good, with its runs."""
    if not valid_chat_id(chat_id):
        return False
    cur = await conn.execute(
        "DELETE FROM chats WHERE id = %s AND user_id = %s AND workspace_id = %s RETURNING id",
        (chat_id, user_id, workspace_id),
    )
    return await cur.fetchone() is not None


def _text_of(part: Any) -> str:
    """String(part.text ?? "") for a text part, else ""."""
    if not isinstance(part, dict) or part.get("type") != "text":
        return ""
    value = part.get("text")
    return "" if value is None else _js_string(value)


def chat_lines(messages: Any) -> list[dict[str, str]]:
    """What the user and Claude said in a chat's messages, in order (chatLines in chats.ts)."""
    lines: list[dict[str, str]] = []
    for message in messages if isinstance(messages, list) else []:
        if not isinstance(message, dict):
            continue
        role, content = message.get("role"), message.get("content")
        if role not in ("user", "assistant"):
            continue
        if isinstance(content, str):
            text = content
        elif isinstance(content, list):
            text = "\n".join(t for t in (_text_of(p) for p in content) if t)
        else:
            text = ""
        if js_trim(text):
            lines.append({"role": role, "text": text})
    return lines


_SEARCH = """
    SELECT c.id, c.name, c.updated_at, c.messages, m.matched FROM chats c
    CROSS JOIN LATERAL (
      SELECT coalesce(c.name, '') || E'\\n' || coalesce(string_agg(
        CASE jsonb_typeof(e->'content')
          WHEN 'string' THEN e->>'content'
          WHEN 'array' THEN (
            SELECT string_agg(p->>'text', E'\\n') FROM jsonb_array_elements(e->'content') p
            WHERE jsonb_typeof(p) = 'object' AND p->>'type' = 'text')
        END, E'\\n'), '') AS said
      FROM jsonb_array_elements(CASE jsonb_typeof(c.messages) WHEN 'array' THEN c.messages ELSE '[]'::jsonb END) e
      WHERE e->>'role' IN ('user', 'assistant')
    ) t
    CROSS JOIN LATERAL (
      SELECT count(*)::int AS matched FROM unnest(%s::text[]) w WHERE t.said ILIKE w
    ) m
    WHERE c.user_id = %s AND c.workspace_id = %s
      AND (%s::text IS NULL OR c.id <> %s)
      AND NOT EXISTS (
        SELECT 1 FROM memory_incognito_chats i
        WHERE i.workspace_id = c.workspace_id AND i.user_id = c.user_id AND i.thread_id = c.id)
      AND m.matched > 0
    ORDER BY m.matched DESC, c.updated_at DESC
    LIMIT %s"""


def _snippets(lines: list[dict[str, str]], found: list[str]) -> list[str]:
    """Up to two lines around the words found, as `role: …text…`."""
    snippets: list[str] = []
    for line in lines:
        text = to_units(line["text"])
        lower = to_units(line["text"].lower())
        hits = [i for i in (lower.find(to_units(w)) for w in found) if i >= 0]
        if not hits:
            continue
        start = max(0, min(hits) - SNIPPET // 2)
        cut = js_trim(_SPACES.sub(" ", from_units(text[start : start + SNIPPET])))
        before = _ELLIPSIS if start > 0 else ""
        after = _ELLIPSIS if start + SNIPPET < len(text) else ""
        snippets.append(f"{line['role']}: {before}{cut}{after}")
        if len(snippets) == 2:
            break
    return snippets


async def search_chats(
    conn: AsyncConnection,
    workspace_id: str,
    user_id: str,
    query: str,
    exclude: str | None = None,
    limit: int | None = None,
) -> list[dict[str, Any]]:
    """
    The user's past chats with the query's words in their name or messages,
    those with the most words first, then the latest. Incognito chats, and
    `exclude` (the chat asking), are never results.
    """
    words = query_words(query, MAX_WORDS)
    if not words:
        return []
    chosen = int(limit) if limit else 5
    cur = await conn.execute(
        _SEARCH,
        (
            [like_pattern(w) for w in words],
            user_id,
            workspace_id,
            exclude or None,
            exclude or None,
            min(max(chosen or 5, 1), 20),
        ),
    )
    hits = []
    for id_, name, updated_at, messages, matched in await cur.fetchall():
        lines = chat_lines(messages)
        said = "\n".join([name or "", *(line["text"] for line in lines)]).lower()
        found = [w for w in words if w in said]
        hits.append(
            {
                "id": id_,
                "name": name,
                "updatedAt": iso(updated_at),
                "matched": matched,
                "snippets": _snippets(lines, found),
            }
        )
    return hits


async def chat_lines_of(
    conn: AsyncConnection, workspace_id: str, user_id: str, chat_id: str
) -> dict[str, Any] | None:
    """
    One of the user's chats, as what was said: {chat, lines}; None when it
    isn't theirs, doesn't exist, or is incognito.
    """
    if not valid_chat_id(chat_id):
        return None
    cur = await conn.execute(
        f"""
        SELECT {_COLUMNS}, messages FROM chats c
        WHERE c.id = %s AND c.user_id = %s AND c.workspace_id = %s
          AND NOT EXISTS (
            SELECT 1 FROM memory_incognito_chats i
            WHERE i.workspace_id = c.workspace_id AND i.user_id = c.user_id AND i.thread_id = c.id)""",
        (chat_id, user_id, workspace_id),
    )
    row = await cur.fetchone()
    return {"chat": _summary(row), "lines": chat_lines(row[7])} if row else None
