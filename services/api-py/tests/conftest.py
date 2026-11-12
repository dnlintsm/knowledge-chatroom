"""Fixtures for the tests that need Postgres (TEST_DATABASE_URL); see support.py."""

from __future__ import annotations

import uuid
from collections.abc import AsyncIterator

import httpx
import psycopg
import pytest
from psycopg import conninfo
from support import SECRET, URL, Client, migrate


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture
async def database() -> AsyncIterator[str]:
    name = f"api_py_routes_{uuid.uuid4().hex[:12]}"
    async with await psycopg.AsyncConnection.connect(URL, autocommit=True) as admin:
        await admin.execute(f'CREATE DATABASE "{name}"')
        try:
            url = conninfo.make_conninfo(URL, dbname=name)
            await migrate(url)
            yield url
        finally:
            await admin.execute(f'DROP DATABASE "{name}" WITH (FORCE)')


@pytest.fixture
async def api(database) -> AsyncIterator[httpx.AsyncClient]:
    async with Client(database, SECRET) as (client, _app):
        yield client
