"""What the tests of the routes api-py serves share: a migrated Postgres and a stand-in TypeScript server.

The stand-in records what reaches it, and Client fails the test when a route
api-py serves got there.
"""

from __future__ import annotations

import os
import time
from collections.abc import AsyncIterator

import httpx
import psycopg

from api_py import db, tokens
from api_py.app import create_app
from api_py.config import DEFAULT_MIGRATIONS_DIR, Settings

URL = os.environ.get("TEST_DATABASE_URL")
SECRET = "0123456789abcdef0123456789abcdef"


async def migrate(url: str) -> None:
    """What migrate() in apps/agent/src/storage/db.ts does: every migration, recorded."""
    async with await psycopg.AsyncConnection.connect(url, autocommit=True) as conn:
        await conn.execute(
            "CREATE TABLE schema_migrations (name text PRIMARY KEY, applied_at timestamptz DEFAULT now())"
        )
        for name in db.known_migrations(DEFAULT_MIGRATIONS_DIR):
            async with conn.transaction():
                await conn.execute((DEFAULT_MIGRATIONS_DIR / name).read_text())  # type: ignore[arg-type]
                await conn.execute("INSERT INTO schema_migrations (name) VALUES (%s)", (name,))


forwarded: list[str] = []


async def typescript(request: httpx.Request) -> httpx.Response:
    forwarded.append(f"{request.method} {request.url.raw_path.decode().split('?')[0]}")  # as sent

    async def body() -> AsyncIterator[bytes]:  # streamed, as a real connection answers
        yield b'{"from":"typescript"}'

    return httpx.Response(200, headers={"content-type": "application/json"}, content=body())


class Client:
    """api-py on a migrated database, with the stand-in TypeScript server behind it."""

    def __init__(self, url: str, secret: str | None, **settings) -> None:
        self.app = create_app(
            Settings(
                ts_agent_url="http://ts",
                database_url=url,
                auth_secret=secret,
                migrations_dir=DEFAULT_MIGRATIONS_DIR,
                **settings,
            ),
            transport=httpx.MockTransport(typescript),
        )

    async def __aenter__(self):
        forwarded.clear()
        self._life = self.app.router.lifespan_context(self.app)
        await self._life.__aenter__()
        self._http = httpx.AsyncClient(
            transport=httpx.ASGITransport(app=self.app), base_url="http://api"
        )
        return self._http, self.app

    async def __aexit__(self, *exc):
        await self._http.aclose()
        await self._life.__aexit__(*exc)
        assert not forwarded, f"ported routes reached the TypeScript server: {forwarded}"


def user(sub: str, name: str) -> dict[str, str]:
    claims = {
        "sub": sub,
        "email": f"{name.lower()}@example.com",
        "name": name,
        "exp": int(time.time()) + 3600,
    }
    return {tokens.IDENTITY_HEADER: tokens.sign(claims, SECRET)}


def storage_token(sub: str, via: str | None = "mcp:lab") -> dict[str, str]:
    claims: dict = {"sub": sub, "exp": int(time.time()) + 3600, "aud": tokens.STORAGE_AUDIENCE}
    if via:
        claims["via"] = via
    return {tokens.STORAGE_HEADER: tokens.sign(claims, SECRET)}


ALICE = user("kc|alice", "Alice")
BOB = user("kc|bob", "Bob")
