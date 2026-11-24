"""Experiment maintainers and collaborators (025_experiment_maintainers.sql).

The rules through the API are in the conformance suite
(packages/contracts/conformance/workspaces.test.ts, "Experiment handover");
these need the database before the migration, or a user's own queries
bypassing the routes.
"""

from __future__ import annotations

import uuid
from collections.abc import AsyncIterator

import psycopg
import pytest
from psycopg import conninfo
from support import URL

from api_py import db
from api_py.config import DEFAULT_MIGRATIONS_DIR

pytestmark = [
    pytest.mark.skipif(not URL, reason="needs TEST_DATABASE_URL"),
    pytest.mark.anyio,
]
MAINTAINERS = "025_experiment_maintainers.sql"


async def _apply(conn: psycopg.AsyncConnection, name: str) -> None:
    async with conn.transaction():
        await conn.execute((DEFAULT_MIGRATIONS_DIR / name).read_text())  # type: ignore[arg-type]
        await conn.execute("INSERT INTO schema_migrations (name) VALUES (%s)", (name,))


@pytest.fixture
async def before() -> AsyncIterator[psycopg.AsyncConnection]:
    """A database with every migration before the maintainers, and a connection to it."""
    name = f"api_py_mt_{uuid.uuid4().hex[:12]}"
    async with await psycopg.AsyncConnection.connect(URL, autocommit=True) as admin:  # pyrefly: ignore[bad-argument-type]
        await admin.execute(f'CREATE DATABASE "{name}"')  # pyrefly: ignore[bad-argument-type]
        try:
            url = conninfo.make_conninfo(URL, dbname=name)  # pyrefly: ignore[bad-argument-type]
            async with await psycopg.AsyncConnection.connect(url, autocommit=True) as conn:
                await conn.execute(
                    "CREATE TABLE schema_migrations (name text PRIMARY KEY, applied_at timestamptz DEFAULT now())"
                )
                for migration in db.known_migrations(DEFAULT_MIGRATIONS_DIR):
                    if migration == MAINTAINERS:
                        break
                    await _apply(conn, migration)
                yield conn
        finally:
            await admin.execute(f'DROP DATABASE "{name}" WITH (FORCE)')  # pyrefly: ignore[bad-argument-type]


async def _one(conn: psycopg.AsyncConnection, query: str, *params) -> object:
    cur = await conn.execute(query, params)  # pyrefly: ignore[bad-argument-type]
    row = await cur.fetchone()
    return row[0] if row else None


async def _setup(conn: psycopg.AsyncConnection) -> dict[str, str]:
    """
    The default workspace with alice (Owner), bob and carol (Members who view
    the node), dan (a Member without a grant), and experiments by alice and bob
    in every status.
    """
    ids: dict[str, str] = {
        "ws": str(await _one(conn, "SELECT id FROM workspaces WHERE slug = 'default'"))
    }
    for name, role in [
        ("alice", "owner"),
        ("bob", "member"),
        ("carol", "member"),
        ("dan", "member"),
    ]:
        ids[name] = str(
            await _one(
                conn, "INSERT INTO users (subject, name) VALUES (%s, %s) RETURNING id", name, name
            )
        )
        await conn.execute(
            "INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (%s, %s, %s)",
            (ids["ws"], ids[name], role),
        )
    ids["node"] = str(
        await _one(
            conn,
            "INSERT INTO nodes (workspace_id, parent_id, type_id, name) "
            "SELECT %s, NULL, id, 'Etch' FROM node_types WHERE workspace_id = %s AND depth = 1 RETURNING id",
            ids["ws"],
            ids["ws"],
        )
    )
    await conn.execute(
        "INSERT INTO grants (workspace_id, node_id, principal_type, principal_id, role) VALUES (%s, NULL, 'user', %s, 'owner')",
        (ids["ws"], ids["alice"]),
    )
    for name in ("bob", "carol"):
        await conn.execute(
            "INSERT INTO grants (workspace_id, node_id, principal_type, principal_id, role) VALUES (%s, %s, 'user', %s, 'viewer')",
            (ids["ws"], ids["node"], ids[name]),
        )
    for author in ("alice", "bob"):
        for status in ("draft", "shared", "archived"):
            ids[f"{author}-{status}"] = str(
                await _one(
                    conn,
                    "INSERT INTO experiments (workspace_id, node_id, author_id, title, status) "
                    "VALUES (%s, %s, %s, %s, %s) RETURNING id",
                    ids["ws"],
                    ids["node"],
                    ids[author],
                    f"{author} {status}",
                    status,
                )
            )
    return ids


async def _access(conn: psycopg.AsyncConnection) -> list[tuple]:
    """What every user may do with every experiment."""
    cur = await conn.execute(
        """
        SELECT u.name, e.title, experiment_access(u.id, e.id)
        FROM users u CROSS JOIN experiments e ORDER BY 1, 2"""
    )
    return await cur.fetchall()


async def test_the_migration_makes_each_author_the_maintainer_and_changes_no_access(before):
    conn = before
    await _setup(conn)
    access = await _access(conn)
    await _apply(conn, MAINTAINERS)
    assert (
        await _one(
            conn, "SELECT count(*) FROM experiments WHERE maintainer_id IS DISTINCT FROM author_id"
        )
        == 0
    )
    assert await _one(conn, "SELECT count(*) FROM experiment_collaborators") == 0
    assert await _access(conn) == access


async def _as(conn: psycopg.AsyncConnection, user_id: str, query: str, *params) -> int:
    """Runs `query` as `user_id`'s own query (row-level security and the guard trigger); rows changed."""
    async with conn.transaction():
        await conn.execute(f"SET LOCAL ROLE {db.APP_ROLE}")
        await conn.execute("SELECT set_config('app.user_id', %s, true)", (user_id,))
        cur = await conn.execute(query, params)  # pyrefly: ignore[bad-argument-type]
        return cur.rowcount


async def test_a_users_own_queries_keep_the_rules_when_the_routes_are_bypassed(before):
    conn = before
    await conn.execute(
        f"DO $$ BEGIN CREATE ROLE {db.APP_ROLE} NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$"
    )
    ids = await _setup(conn)
    await _apply(conn, MAINTAINERS)
    await conn.execute(f"GRANT USAGE ON SCHEMA public TO {db.APP_ROLE}")
    await conn.execute(f"GRANT SELECT, UPDATE ON experiments TO {db.APP_ROLE}")
    await conn.execute(f"GRANT SELECT ON workspaces, nodes, users TO {db.APP_ROLE}")
    await conn.execute(f"GRANT SELECT, INSERT, DELETE ON experiment_collaborators TO {db.APP_ROLE}")
    draft, shared = ids["bob-draft"], ids["bob-shared"]
    add = "INSERT INTO experiment_collaborators (experiment_id, user_id) VALUES (%s, %s)"
    status = "UPDATE experiments SET status = 'archived' WHERE id = %s"
    hand_to = "UPDATE experiments SET maintainer_id = %s WHERE id = %s"

    # Only the maintainer adds a collaborator to a draft.
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        await _as(conn, ids["carol"], add, draft, ids["carol"])
    assert await _as(conn, ids["bob"], add, draft, ids["carol"]) == 1
    # A collaborator edits it, but changes neither its status nor its maintainer, nor its author.
    assert (
        await _as(
            conn,
            ids["carol"],
            "UPDATE experiments SET title = 'carol was here' WHERE id = %s",
            draft,
        )
        == 1
    )
    with pytest.raises(psycopg.errors.RaiseException, match="maintainer"):
        await _as(conn, ids["carol"], status, draft)
    with pytest.raises(psycopg.errors.RaiseException, match="maintainer"):
        await _as(conn, ids["carol"], hand_to, ids["carol"], draft)
    with pytest.raises(psycopg.errors.RaiseException, match="author"):
        await _as(
            conn,
            ids["bob"],
            "UPDATE experiments SET author_id = %s WHERE id = %s",
            ids["carol"],
            draft,
        )
    # Someone who doesn't work on it changes nothing.
    assert (
        await _as(conn, ids["dan"], "UPDATE experiments SET title = 'dan' WHERE id = %s", shared)
        == 0
    )
    # The Owner hands over a shared one, never a draft (which they can't even see).
    assert await _as(conn, ids["alice"], hand_to, ids["carol"], draft) == 0
    assert await _as(conn, ids["alice"], hand_to, ids["carol"], shared) == 1
    # The maintainer hands a draft over without staying on it.
    assert await _as(conn, ids["bob"], hand_to, ids["carol"], ids["bob-archived"]) == 1
    assert await _as(conn, ids["bob"], hand_to, ids["carol"], draft) == 1
    assert (
        await _one(conn, "SELECT maintainer_id::text FROM experiments WHERE id = %s", draft)
        == ids["carol"]
    )
    # A collaborator removes themselves; a new experiment's maintainer is its author.
    assert (
        await _as(
            conn,
            ids["carol"],
            "DELETE FROM experiment_collaborators WHERE user_id = %s",
            ids["carol"],
        )
        == 1
    )
    made = await _one(
        conn,
        "INSERT INTO experiments (workspace_id, node_id, author_id, maintainer_id, title) "
        "VALUES (%s, %s, %s, %s, 'new') RETURNING maintainer_id::text",
        ids["ws"],
        ids["node"],
        ids["bob"],
        ids["carol"],
    )
    assert made == ids["bob"]
