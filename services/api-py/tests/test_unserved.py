"""What api-py answers for a request no route serves, with no database."""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
import pytest

from api_py.app import create_app
from api_py.config import Settings, settings_from_env

pytestmark = pytest.mark.anyio


@pytest.fixture
def anyio_backend():
    return "asyncio"


def settings(**overrides) -> Settings:
    base = {"database_url": None, "auth_secret": None, "migrations_dir": Path(".")}
    return Settings(**{**base, **overrides})


@asynccontextmanager
async def serving(given: Settings) -> AsyncIterator[tuple[httpx.AsyncClient, object]]:
    app = create_app(given)
    async with (
        app.router.lifespan_context(app),
        httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://api") as api,
    ):
        yield api, app


async def test_without_login_a_signed_request_is_refused_not_made_the_local_user():
    """Login on in the app and no secret here must not make everyone the owner."""
    async with serving(settings()) as (api, _):
        for header in ("x-knowledge-user", "X-Knowledge-Storage"):
            answer = await api.get("/files", headers={header: "v2.token.sig"})
            assert answer.status_code == 401, header
            assert "AUTH_MODE=oidc" in answer.json()["error"]
        # Unsigned requests, and the unsigned local memory token, are the local
        # user's: they get as far as the route, which has no storage to serve.
        assert (await api.get("/files")).status_code == 404
        local = await api.get("/files", headers={"x-knowledge-memory": "local.e30"})
        assert local.status_code == 404
    # With login on the header is the route's to check, not refused up front.
    async with serving(settings(auth_secret="0123456789abcdef0123456789abcdef")) as (api, _):
        answer = await api.get("/files", headers={"x-knowledge-user": "v2.token.sig"})
        assert answer.status_code == 404


@pytest.mark.parametrize("method", ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"])
async def test_an_unknown_path_is_not_found_for_every_method(method):
    async with serving(settings()) as (api, _):
        for path in ("/", "/agent/report", "/unknown", "/nodes"):
            answer = await api.request(method, path)
            assert answer.status_code == 404, path
            if method != "HEAD":
                assert answer.json() == {"error": "Not found"}


async def test_without_a_database_it_is_healthy_and_serves_what_needs_none():
    async with serving(settings_from_env({"AUTH_MODE": "local"})) as (api, _):
        health = await api.get("/health")
        assert health.status_code == 200 and health.json() == {"status": "ok"}
        menu = await api.get("/tools")
        assert menu.status_code == 200 and menu.json() == {"tools": []}


async def test_storage_that_is_still_starting_is_unavailable_not_missing():
    async with serving(settings()) as (api, app):
        # A database is configured and storage hasn't opened yet.
        app.state.settings = settings(database_url="configured")
        for path in ("/files", "/nodes/x", "/skills", "/workspaces"):
            answer = await api.get(path)
            assert answer.status_code == 503, path
            assert answer.json() == {"error": "Storage is not ready"}
        # A path storage doesn't serve is still simply not found.
        assert (await api.get("/unknown")).status_code == 404
