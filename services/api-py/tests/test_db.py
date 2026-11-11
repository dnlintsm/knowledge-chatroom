"""The migration check and the row-security transaction, against a real Postgres.

Set TEST_DATABASE_URL to a Postgres this test may create databases on (as the
TypeScript storage tests do); each test gets a new, empty database.
"""

from __future__ import annotations

import os
import uuid
from collections.abc import AsyncIterator

import anyio
import httpx
import psycopg
import pytest
from api_py import db
from api_py.app import create_app
from api_py.config import DEFAULT_MIGRATIONS_DIR, Settings
from psycopg import conninfo

URL = os.environ.get("TEST_DATABASE_URL")
needs_postgres = pytest.mark.skipif(not URL, reason="TEST_DATABASE_URL is not set")
KNOWN = db.known_migrations(DEFAULT_MIGRATIONS_DIR)


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture
async def database() -> AsyncIterator[str]:
    name = f"api_py_test_{uuid.uuid4().hex[:12]}"
    async with await psycopg.AsyncConnection.connect(URL, autocommit=True) as admin:
        # The role is the cluster's; 004_row_security.sql makes it on a real install.
        await admin.execute(
            f"DO $$ BEGIN CREATE ROLE {db.APP_ROLE} NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$"
        )
        await admin.execute(f'CREATE DATABASE "{name}"')
        try:
            yield conninfo.make_conninfo(URL, dbname=name)
        finally:
            await admin.execute(f'DROP DATABASE "{name}" WITH (FORCE)')


async def record(url: str, names: list[str]) -> None:
    async with await psycopg.AsyncConnection.connect(url, autocommit=True) as conn:
        await conn.execute(
            "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz DEFAULT now())"
        )
        for name in names:
            await conn.execute("INSERT INTO schema_migrations (name) VALUES (%s)", (name,))


def test_knows_the_typescript_migrations_in_order():
    assert KNOWN[0] == "001_init.sql"
    assert sorted(KNOWN) == KNOWN
    assert all(name.endswith(".sql") for name in KNOWN)


def test_compare():
    assert db.compare(["1.sql", "2.sql"], {"1.sql", "2.sql"}).state is db.SchemaState.READY
    behind = db.compare(["1.sql", "2.sql"], {"1.sql"})
    assert (behind.state, behind.missing) == (db.SchemaState.BEHIND, ("2.sql",))
    ahead = db.compare(["1.sql"], {"1.sql", "9.sql"})
    assert (ahead.state, ahead.unknown) == (db.SchemaState.AHEAD, ("9.sql",))


@pytest.mark.anyio
@needs_postgres
async def test_reads_the_schema_as_the_typescript_server_left_it(database):
    pool = db.open_pool(database)
    await pool.open()
    try:
        empty = await db.schema(pool, DEFAULT_MIGRATIONS_DIR)
        assert empty.state is db.SchemaState.BEHIND and empty.missing == tuple(KNOWN)
        await record(database, KNOWN)
        assert (await db.schema(pool, DEFAULT_MIGRATIONS_DIR)).state is db.SchemaState.READY
        await record(database, ["999_from_a_newer_release.sql"])
        ahead = await db.schema(pool, DEFAULT_MIGRATIONS_DIR)
        assert ahead.state is db.SchemaState.AHEAD and ahead.unknown == (
            "999_from_a_newer_release.sql",
        )
    finally:
        await pool.close()


@pytest.mark.anyio
@needs_postgres
async def test_as_user_sets_the_role_and_user_for_one_transaction(database):
    pool = db.open_pool(database)
    await pool.open()
    user = str(uuid.uuid4())
    try:
        async with db.as_user(pool, user) as conn:
            cur = await conn.execute("SELECT current_user, current_setting('app.user_id', true)")
            assert await cur.fetchone() == (db.APP_ROLE, user)
        async with pool.connection() as conn:
            cur = await conn.execute(
                "SELECT current_user = %s, coalesce(current_setting('app.user_id', true), '')",
                (db.APP_ROLE,),
            )
            assert await cur.fetchone() == (False, "")
    finally:
        await pool.close()


def settings(url: str) -> Settings:
    return Settings(
        ts_agent_url="http://ts",
        database_url=url,
        auth_secret=None,
        migrations_dir=DEFAULT_MIGRATIONS_DIR,
    )


async def up(request: httpx.Request) -> httpx.Response:
    return httpx.Response(200, json={"status": "ok"})


@pytest.mark.anyio
@needs_postgres
async def test_refuses_to_start_on_a_newer_database(database):
    await record(database, [*KNOWN, "999_from_a_newer_release.sql"])
    app = create_app(settings(database), transport=httpx.MockTransport(up))
    with pytest.raises(RuntimeError, match="999_from_a_newer_release.sql"):
        async with app.router.lifespan_context(app):
            pass


@pytest.mark.anyio
@needs_postgres
async def test_waits_for_the_typescript_server_to_migrate(database, monkeypatch):
    from api_py import app as app_module

    monkeypatch.setattr(app_module, "SCHEMA_POLL_SECONDS", 0.05)
    app = create_app(settings(database), transport=httpx.MockTransport(up))
    async with (
        app.router.lifespan_context(app),
        httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://api") as api,
    ):
        # Up while it waits: the TypeScript server applies the migrations as it starts.
        assert (await api.get("/health")).json() == {"status": "ok"}
        assert app.state.schema.state is db.SchemaState.BEHIND
        await record(database, KNOWN)
        for _ in range(100):
            if app.state.schema.state is db.SchemaState.READY:
                break
            await anyio.sleep(0.05)
        assert app.state.schema.state is db.SchemaState.READY
        assert (await api.get("/health")).json() == {"status": "ok"}
