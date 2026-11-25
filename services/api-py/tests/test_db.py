"""The migration check and the row-security transaction, against a real Postgres.

Set TEST_DATABASE_URL to a Postgres this test may create databases on (as the
TypeScript storage tests do); each test gets a new, empty database.
"""

from __future__ import annotations

import asyncio
import dataclasses
import os
import uuid
from collections.abc import AsyncIterator

import anyio
import httpx
import psycopg
import pytest
from psycopg import conninfo

from api_py import db
from api_py.app import create_app
from api_py.config import DEFAULT_MIGRATIONS_DIR, Settings

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


def settings(url: str, migrations: bool = True) -> Settings:
    return Settings(
        database_url=url,
        auth_secret=None,
        migrations_dir=DEFAULT_MIGRATIONS_DIR,
        migrations=migrations,
    )


@pytest.mark.anyio
@needs_postgres
async def test_refuses_to_start_on_a_newer_database(database):
    await record(database, [*KNOWN, "999_from_a_newer_release.sql"])
    app = create_app(settings(database))
    with pytest.raises(RuntimeError, match="999_from_a_newer_release.sql"):
        async with app.router.lifespan_context(app):
            pass


@pytest.mark.anyio
@needs_postgres
async def test_applies_the_migrations_itself(database):
    app = create_app(settings(database))
    async with (
        app.router.lifespan_context(app),
        httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://api") as api,
    ):
        for _ in range(200):
            if app.state.storage is not None:
                break
            await anyio.sleep(0.05)
        assert app.state.schema.state is db.SchemaState.READY
        # Storage is open: /health also says whether Postgres enforces access.
        assert (await api.get("/health")).json() == {"status": "ok", "rowSecurity": "on"}
    async with await psycopg.AsyncConnection.connect(database) as conn:
        cur = await conn.execute("SELECT name FROM schema_migrations ORDER BY name")
        assert [name for (name,) in await cur.fetchall()] == KNOWN
        # What 001_init.sql seeds: the default workspace.
        cur = await conn.execute("SELECT count(*) FROM workspaces WHERE slug = 'default'")
        assert await cur.fetchone() == (1,)


@pytest.mark.anyio
@needs_postgres
async def test_migrate_applies_each_once_in_order_and_one_process_at_a_time(database, tmp_path):
    pool = db.open_pool(database)
    await pool.open()
    try:
        # Two at once, as when both servers start: the lock lets one apply them all.
        first, second = await asyncio.gather(
            db.migrate(pool, DEFAULT_MIGRATIONS_DIR), db.migrate(pool, DEFAULT_MIGRATIONS_DIR)
        )
        assert sorted([first, second], key=len) == [[], KNOWN]
        assert await db.migrate(pool, DEFAULT_MIGRATIONS_DIR) == []
        assert (await db.schema(pool, DEFAULT_MIGRATIONS_DIR)).state is db.SchemaState.READY

        # A migration that fails leaves the database as it was: all or nothing.
        for name in KNOWN:
            (tmp_path / name).write_text((DEFAULT_MIGRATIONS_DIR / name).read_text())
        (tmp_path / "900_first.sql").write_text("CREATE TABLE added_by_900 (id int);")
        (tmp_path / "901_broken.sql").write_text("SELECT * FROM no_such_table;")
        with pytest.raises(psycopg.Error):
            await db.migrate(pool, tmp_path)
        async with pool.connection() as conn:
            cur = await conn.execute("SELECT to_regclass('added_by_900') IS NULL")
            assert await cur.fetchone() == (True,)
        assert (await db.schema(pool, tmp_path)).missing == ("900_first.sql", "901_broken.sql")
    finally:
        await pool.close()


@pytest.mark.anyio
@needs_postgres
async def test_row_security_off_is_reported_and_refused_when_required(database, monkeypatch):
    """A database user who can't use the restricted role used to cost one log line."""
    from api_py import app as app_module
    from api_py import storage as storage_module

    monkeypatch.setattr(app_module, "SCHEMA_POLL_SECONDS", 0.05)
    can_use_role = False
    prepare = storage_module.prepare_row_security

    async def prepare_or_not(conn) -> bool:
        return await prepare(conn) if can_use_role else False

    monkeypatch.setattr(storage_module, "prepare_row_security", prepare_or_not)

    async def storage_opens(app) -> bool:
        for _ in range(200):
            if app.state.storage is not None:
                return True
            if app.state.row_security == "off":
                await anyio.sleep(0.2)  # a few more polls: it must stay closed
                return app.state.storage is not None
            await anyio.sleep(0.05)
        return False

    # By default it is served, with the app's own checks only, and /health says so.
    alone = settings(database)
    app = create_app(alone)
    async with (
        app.router.lifespan_context(app),
        httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://api") as api,
    ):
        assert await storage_opens(app)
        assert (await api.get("/health")).json() == {"status": "ok", "rowSecurity": "off"}

    # ROW_SECURITY=required: storage stays closed, and the server reports itself unhealthy.
    app = create_app(dataclasses.replace(alone, row_security_required=True))
    async with (
        app.router.lifespan_context(app),
        httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://api") as api,
    ):
        assert not await storage_opens(app)
        health = await api.get("/health")
        assert (health.status_code, health.json()) == (
            503,
            {"status": "degraded", "database": "ready", "rowSecurity": "off"},
        )
        # Everything in the database is refused, memory too; the rest is simply not found.
        for path in ("/files", "/files/a.md", "/memory", "/skills", "/workspaces"):
            refused = await api.get(path)
            assert (refused.status_code, refused.json()) == (
                503,
                {"error": "Storage is not served: row-level security is required and off"},
            ), path
        assert (await api.get("/something/else")).status_code == 404
        # An admin grants the role while it runs: the next poll serves storage.
        can_use_role = True
        for _ in range(200):
            if app.state.storage is not None:
                break
            await anyio.sleep(0.05)
        assert (await api.get("/health")).json() == {"status": "ok", "rowSecurity": "on"}


@pytest.mark.anyio
@needs_postgres
async def test_migrations_off_is_served_once_the_migrate_command_ran(database, monkeypatch, capsys):
    """MIGRATIONS=off waits for another process to apply the migrations: the migrate command."""
    from api_py import app as app_module
    from api_py import migrate

    monkeypatch.setattr(app_module, "SCHEMA_POLL_SECONDS", 0.05)
    app = create_app(settings(database, migrations=False))
    async with (
        app.router.lifespan_context(app),
        httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://api") as api,
    ):
        await anyio.sleep(0.2)
        assert app.state.schema.state is db.SchemaState.BEHIND
        waiting = await api.get("/health")
        assert (waiting.status_code, waiting.json()["database"]) == (503, "behind")

        # The deploy step: `python -m api_py.migrate` (run here in a thread; it has its own loop).
        env = {"DATABASE_URL": database}
        await anyio.to_thread.run_sync(migrate.main, env)
        assert capsys.readouterr().out.startswith("applied: 001_init.sql, ")
        for _ in range(200):
            if app.state.storage is not None:
                break
            await anyio.sleep(0.05)
        assert (await api.get("/health")).json() == {"status": "ok", "rowSecurity": "on"}
    await anyio.to_thread.run_sync(migrate.main, env)
    assert capsys.readouterr().out == "nothing to apply: the database is up to date\n"
    with pytest.raises(SystemExit, match="DATABASE_URL is not set"):
        migrate.main({})
