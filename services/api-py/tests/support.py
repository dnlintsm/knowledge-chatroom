"""What the tests of api-py's routes share: a migrated Postgres, a client and signed users."""

from __future__ import annotations

import os
import time

import httpx
import psycopg

from api_py import db, tokens
from api_py.app import create_app
from api_py.config import DEFAULT_MIGRATIONS_DIR, Settings

URL = os.environ.get("TEST_DATABASE_URL")
SECRET = "0123456789abcdef0123456789abcdef"


async def migrate(url: str) -> None:
    """Applies every migration to a new test database and records it."""
    async with await psycopg.AsyncConnection.connect(url, autocommit=True) as conn:
        await conn.execute(
            "CREATE TABLE schema_migrations (name text PRIMARY KEY, applied_at timestamptz DEFAULT now())"
        )
        for name in db.known_migrations(DEFAULT_MIGRATIONS_DIR):
            async with conn.transaction():
                await conn.execute((DEFAULT_MIGRATIONS_DIR / name).read_text())  # type: ignore[arg-type]
                await conn.execute("INSERT INTO schema_migrations (name) VALUES (%s)", (name,))


class Client:
    """api-py on a migrated database."""

    def __init__(self, url: str, secret: str | None, **settings) -> None:
        self.app = create_app(
            Settings(
                database_url=url,
                auth_secret=secret,
                migrations_dir=DEFAULT_MIGRATIONS_DIR,
                **settings,
            )
        )

    async def __aenter__(self):
        self._life = self.app.router.lifespan_context(self.app)
        await self._life.__aenter__()
        self._http = httpx.AsyncClient(
            transport=httpx.ASGITransport(app=self.app), base_url="http://api"
        )
        return self._http, self.app

    async def __aexit__(self, *exc):
        await self._http.aclose()
        await self._life.__aexit__(*exc)


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
