"""Routes not ported yet reach the TypeScript server as sent, and its answers come back as given."""

from __future__ import annotations

import json
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
import pytest

from api_py.app import create_app
from api_py.config import Settings

pytestmark = pytest.mark.anyio


@pytest.fixture
def anyio_backend():
    return "asyncio"


def settings(**overrides) -> Settings:
    base = {"ts_agent_url": "http://ts", "database_url": None, "auth_secret": None, "migrations_dir": Path(".")}
    return Settings(**{**base, **overrides})


def as_network(handler):
    """`handler` with its answers streamed, as a real connection gives them (httpx reads bytes content at once)."""

    async def handle(request: httpx.Request) -> httpx.Response:
        answer = await handler(request)
        if not answer.is_stream_consumed:
            return answer
        content = answer.content

        async def body() -> AsyncIterator[bytes]:
            yield content

        return httpx.Response(answer.status_code, headers=answer.headers.raw, content=body())

    return handle


@asynccontextmanager
async def through(handler) -> AsyncIterator[httpx.AsyncClient]:
    """A client for api-py, with `handler` playing the TypeScript server."""
    app = create_app(settings(), transport=httpx.MockTransport(as_network(handler)))
    async with app.router.lifespan_context(app):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://api") as api:
            yield api


async def echo(request: httpx.Request) -> httpx.Response:
    body = await request.aread()
    return httpx.Response(
        200,
        json={
            "method": request.method,
            "target": request.url.raw_path.decode(),
            "headers": {k: v for k, v in request.headers.items()},
            "body": body.decode(),
        },
    )


async def test_passes_method_path_query_headers_and_body():
    async with through(echo) as api:
        answer = await api.post(
            "/files/a%2Fb%20c?watch=1&x=%2F",
            content=b'{"hello":"world"}',
            headers={"x-knowledge-user": "v2.token", "content-type": "application/json"},
        )
    seen = answer.json()
    assert seen["method"] == "POST"
    # Percent-encoding kept: %2F is a name character there, not a separator.
    assert seen["target"] == "/files/a%2Fb%20c?watch=1&x=%2F"
    assert seen["headers"]["x-knowledge-user"] == "v2.token"
    assert seen["headers"]["content-type"] == "application/json"
    assert seen["body"] == '{"hello":"world"}'


@pytest.mark.parametrize("method", ["GET", "HEAD", "PUT", "PATCH", "DELETE", "OPTIONS"])
async def test_passes_every_method(method):
    async with through(echo) as api:
        answer = await api.request(method, "/nodes")
    assert answer.status_code == 200
    if method != "HEAD":
        assert answer.json()["method"] == method
        assert answer.json()["body"] == ""


async def test_drops_hop_by_hop_headers_both_ways():
    async def upstream(request: httpx.Request) -> httpx.Response:
        assert "x-private-hop" not in request.headers
        assert "keep-alive" not in request.headers
        return httpx.Response(
            200,
            headers=[("connection", "x-upstream-hop"), ("x-upstream-hop", "1"), ("x-kept", "yes")],
            content=b"ok",
        )

    async with through(upstream) as api:
        answer = await api.get(
            "/access/me", headers={"connection": "x-private-hop", "x-private-hop": "1", "keep-alive": "timeout=5"}
        )
    assert answer.status_code == 200
    assert "x-upstream-hop" not in answer.headers
    assert answer.headers["x-kept"] == "yes"


async def test_keeps_status_repeated_headers_and_bytes():
    payload = bytes(range(256)) * 64

    async def upstream(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            201,
            headers=[("set-cookie", "a=1"), ("set-cookie", "b=2"), ("content-type", "application/octet-stream")],
            content=payload,
        )

    async with through(upstream) as api:
        answer = await api.get("/files/blob")
    assert answer.status_code == 201
    assert answer.headers.get_list("set-cookie") == ["a=1", "b=2"]
    assert answer.content == payload


async def test_streams_server_sent_events():
    events = [f"data: {json.dumps({'n': n})}\n\n".encode() for n in range(3)]

    async def stream() -> AsyncIterator[bytes]:
        for event in events:
            yield event

    async def upstream(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, headers={"content-type": "text/event-stream"}, content=stream())

    async with through(upstream) as api, api.stream("GET", "/files?watch=1") as answer:
        assert answer.headers["content-type"] == "text/event-stream"
        got = b"".join([chunk async for chunk in answer.aiter_raw()])
    assert got == b"".join(events)


async def test_answers_502_when_the_typescript_server_is_down():
    async def upstream(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused", request=request)

    async with through(upstream) as api:
        answer = await api.get("/nodes")
    assert answer.status_code == 502
    assert answer.json() == {"error": "The agent server isn't reachable"}


async def test_health_reports_the_typescript_server():
    async def up(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/health"
        return httpx.Response(200, json={"status": "ok"})

    async def down(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused", request=request)

    async with through(up) as api:
        answer = await api.get("/health")
    assert answer.status_code == 200
    assert answer.json() == {"status": "ok"}

    async with through(down) as api:
        answer = await api.get("/health")
    assert answer.status_code == 503
    assert answer.json() == {"status": "degraded", "upstream": "down", "database": "off"}
