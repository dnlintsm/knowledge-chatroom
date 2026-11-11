"""Postgres, shared with the TypeScript server (apps/agent/src/storage/db.ts).

The TypeScript server applies the migrations (until #190's last step); this
server only checks that the database has exactly the ones it was built for.
Each signed-in user's queries run in one transaction as APP_ROLE with
`app.user_id` set, so the row-level security policies
(004_row_security.sql) back up every access check, as asUser() does there.
"""

from __future__ import annotations

import re
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass
from enum import Enum
from pathlib import Path

from psycopg import AsyncConnection
from psycopg_pool import AsyncConnectionPool

APP_ROLE = "knowledge_user"
_MIGRATION = re.compile(r"^\d+_.*\.sql$")


class SchemaState(str, Enum):
    READY = "ready"  # exactly the migrations this server knows
    BEHIND = "behind"  # some not applied yet: the TypeScript server applies them at startup
    AHEAD = "ahead"  # migrations this server doesn't know: it is older than the database


@dataclass(frozen=True)
class Schema:
    state: SchemaState
    missing: tuple[str, ...] = ()
    unknown: tuple[str, ...] = ()


def known_migrations(directory: Path) -> list[str]:
    """The migration files this server was built for, in order."""
    return sorted(p.name for p in directory.iterdir() if _MIGRATION.match(p.name))


def compare(known: list[str], applied: set[str]) -> Schema:
    unknown = tuple(sorted(applied - set(known)))
    if unknown:
        return Schema(SchemaState.AHEAD, unknown=unknown)
    missing = tuple(name for name in known if name not in applied)
    return Schema(SchemaState.BEHIND, missing=missing) if missing else Schema(SchemaState.READY)


async def applied_migrations(conn: AsyncConnection) -> set[str]:
    """The migrations recorded in schema_migrations; none before the first one ran."""
    cur = await conn.execute("SELECT to_regclass('schema_migrations') IS NOT NULL")
    row = await cur.fetchone()
    if not row or not row[0]:
        return set()
    cur = await conn.execute("SELECT name FROM schema_migrations")
    return {name for (name,) in await cur.fetchall()}


async def schema(pool: AsyncConnectionPool, directory: Path) -> Schema:
    async with pool.connection() as conn:
        return compare(known_migrations(directory), await applied_migrations(conn))


def open_pool(database_url: str) -> AsyncConnectionPool:
    """
    A small pool, opened by the app's lifespan (await pool.open()). Statements
    outside `conn.transaction()` commit on their own, as with postgres.js.
    """
    return AsyncConnectionPool(database_url, min_size=1, max_size=10, open=False, kwargs={"autocommit": True})


@asynccontextmanager
async def as_user(pool: AsyncConnectionPool, user_id: str) -> AsyncIterator[AsyncConnection]:
    """One transaction as APP_ROLE for `user_id`, so row-level security decides what it sees."""
    async with pool.connection() as conn, conn.transaction():
        await conn.execute(f"SET LOCAL ROLE {APP_ROLE}")
        await conn.execute("SELECT set_config('app.user_id', %s, true)", (user_id,))
        yield conn
