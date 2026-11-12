"""/tools served by api-py (tools.py): the "+" menu and the app's calls to MCP servers, as tools-api.ts answers them."""

from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

import httpx
import pytest
import uvicorn
from support import ALICE, SECRET, forwarded, typescript

from api_py import tokens
from api_py.app import create_app
from api_py.config import ConfigError, Settings, settings_from_env
from api_py.tools import (
    ExternalServer,
    ToolAnswer,
    ToolsSettings,
    call_timeout_seconds,
    servers_from_env,
    storage_token_seconds,
    tool_menu,
)

pytestmark = pytest.mark.anyio

LAB = {
    "type": "http",
    "url": "http://lab.invalid/mcp",
    "headers": {"Authorization": "Bearer ${LAB_KEY}"},
    "forwardIdentity": True,
    "storageAccess": True,
    "ui": {
        "label": "Papers",
        "chip": "Paper",
        "icon": "book",
        "tools": ["search", "save", "search"],
    },
}


@pytest.fixture
def anyio_backend():
    return "asyncio"


def servers(config: dict[str, Any], **env: str) -> dict[str, ExternalServer]:
    found = servers_from_env({"MCP_SERVERS": json.dumps(config), **env})
    assert found is not None
    return found


# --- MCP_SERVERS, as mcp.ts reads it


def test_mcp_servers_unset_means_typescript_keeps_tools():
    assert servers_from_env({}) is None
    assert servers_from_env({"MCP_SERVERS": " \n"}) is None
    assert settings_from_env({}).tools is None


def test_mcp_servers_parse_like_mcp_ts(tmp_path: Path, caplog: pytest.LogCaptureFixture):
    caplog.set_level(logging.WARNING, "api_py")
    found = servers(
        {"mcpServers": {"lab": LAB, "local": {"type": "stdio", "command": "lab-mcp"}}}, LAB_KEY="k1"
    )
    assert list(found) == ["lab", "local"]
    lab = found["lab"]
    assert lab.headers == {"Authorization": "Bearer k1"}
    assert (lab.forward_identity, lab.storage_access, lab.memory_access) == (True, True, False)
    assert lab.ui and lab.ui.tools == ("search", "save") and lab.ui.mode == "auto"
    assert found["local"].ui is None
    assert tool_menu(found) == [
        {
            "server": "lab",
            "label": "Papers",
            "chip": "Paper",
            "description": None,
            "icon": "book",
            "mode": "auto",
            "callable": ["search", "save"],
        }
    ]
    # A ${VAR} that isn't set is empty, with a warning.
    assert servers({"lab": LAB})["lab"].headers == {"Authorization": "Bearer "}
    assert "uses ${LAB_KEY}" in caplog.text
    # A file path, and a bare map; integer-like names come first, as Object.entries gives them.
    file = tmp_path / "mcp.json"
    file.write_text(
        json.dumps(
            {
                "b": {"url": "http://b/mcp"},
                "10": {"url": "http://t/mcp"},
                "2": {"url": "http://t/mcp"},
            }
        )
    )
    found = servers_from_env({"MCP_SERVERS": f" {file} "})
    assert found is not None and list(found) == ["2", "10", "b"]
    assert found["b"].type == "http" and found["b"].ui is None
    # The chip defaults to the label; labels are trimmed.
    ui = servers({"x": {"url": "https://x/mcp", "ui": {"label": "  Lab  ", "mode": "manual"}}})[
        "x"
    ].ui
    assert ui and (ui.label, ui.chip, ui.mode, ui.tools) == ("Lab", "Lab", "manual", ())


@pytest.mark.parametrize(
    ("name", "config"),
    [
        ("bad name", {"url": "http://x/mcp"}),
        ("copilotkit", {"url": "http://x/mcp"}),
        ("x", "http://x/mcp"),
        ("x", {"type": "ws", "url": "ws://x"}),
        ("x", {"url": "ftp://x"}),
        ("x", {"type": "stdio"}),
        ("x", {"type": "stdio", "command": "run", "ui": {"label": "X"}}),
        ("x", {"type": "stdio", "command": "run", "forwardIdentity": True}),
        ("x", {"url": "http://x/mcp", "headers": {"X-Knowledge-User": "me"}}),
        ("x", {"url": "http://x/mcp", "headers": {"a": 1}}),
        ("x", {"url": "http://x/mcp", "ui": {}}),
        ("x", {"url": "http://x/mcp", "ui": {"label": "x" * 41}}),
        ("x", {"url": "http://x/mcp", "ui": {"label": "X", "chip": "   "}}),
        ("x", {"url": "http://x/mcp", "ui": {"label": "X", "mode": "always"}}),
        ("x", {"url": "http://x/mcp", "ui": {"label": "X", "tools": ["no spaces"]}}),
        ("x", {"url": "http://x/mcp", "ui": {"label": "X", "tools": "search"}}),
    ],
)
def test_bad_servers_are_skipped(name: str, config: Any, caplog: pytest.LogCaptureFixture):
    caplog.set_level(logging.ERROR, "api_py")
    assert list(servers({name: config, "ok": {"url": "http://ok/mcp"}})) == ["ok"]
    assert f"skipping MCP server {json.dumps(name)}" in caplog.text


def test_unreadable_mcp_servers_mean_none(caplog: pytest.LogCaptureFixture):
    caplog.set_level(logging.ERROR, "api_py")
    assert servers_from_env({"MCP_SERVERS": "{nope"}) == {}
    assert servers_from_env({"MCP_SERVERS": "/no/such/file.json"}) == {}
    assert servers_from_env({"MCP_SERVERS": "[1]"}) == {}
    assert "no outside MCP servers" in caplog.text


def test_timeouts_and_token_lifetimes():
    assert call_timeout_seconds({}) == 120
    assert call_timeout_seconds({"TOOLS_CALL_TIMEOUT_MS": " 1500ms"}) == 1.5
    assert storage_token_seconds({}) == 3600
    assert storage_token_seconds({"STORAGE_TOKEN_SECONDS": " 0x3c "}) == 60
    for bad in ("59", "86401", "1.5", "1_000", "soon"):
        with pytest.raises(ValueError, match="STORAGE_TOKEN_SECONDS"):
            storage_token_seconds({"STORAGE_TOKEN_SECONDS": bad})
    with pytest.raises(ConfigError, match="STORAGE_TOKEN_SECONDS"):
        settings_from_env({"MCP_SERVERS": "{}", "STORAGE_TOKEN_SECONDS": "5"})
    tools = settings_from_env({"MCP_SERVERS": "{}", "TOOLS_CALL_TIMEOUT_MS": "500"}).tools
    assert tools == ToolsSettings(servers={}, timeout=0.5, storage_token_seconds=3600)


# --- The routes, with a stand-in for the MCP call


@asynccontextmanager
async def api(
    tools: ToolsSettings | None, secret: str | None = SECRET, call: Any = None
) -> AsyncIterator[httpx.AsyncClient]:
    forwarded.clear()
    settings = Settings(
        ts_agent_url="http://ts",
        database_url=None,
        auth_secret=secret,
        migrations_dir=Path("."),
        tools=tools,
    )
    app = create_app(settings, transport=httpx.MockTransport(typescript))
    if call:
        app.state.call_tool = call
    async with (
        app.router.lifespan_context(app),
        httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://api") as client,
    ):
        yield client


class Recorder:
    """Plays the MCP server: records each call and answers `answer` (or raises it)."""

    def __init__(self, answer: ToolAnswer | Exception) -> None:
        self.answer = answer
        self.calls: list[tuple[str, str, dict[str, Any], dict[str, str], float]] = []

    async def __call__(self, name, server, tool, args, headers, timeout) -> ToolAnswer:
        self.calls.append((name, tool, args, headers, timeout))
        if isinstance(self.answer, Exception):
            raise self.answer
        return self.answer


def lab_tools() -> ToolsSettings:
    return ToolsSettings(
        servers=servers({"lab": LAB}, LAB_KEY="k1"), timeout=7, storage_token_seconds=600
    )


async def test_menu():
    async with api(lab_tools()) as client:
        menu = await client.get("/tools", headers=ALICE)
        assert menu.status_code == 200 and menu.headers["cache-control"] == "no-store"
        assert [item["server"] for item in menu.json()["tools"]] == ["lab"]
        refused = await client.get("/tools")
        assert (refused.status_code, refused.json()) == (401, {"error": "Sign in first"})
        assert "cache-control" not in refused.headers
        assert (await client.post("/tools", headers=ALICE)).status_code == 405
        assert (await client.get("/tools/", headers=ALICE)).status_code == 200
    async with api(lab_tools(), secret=None) as client:
        assert (await client.get("/tools")).status_code == 200  # no login: everyone is one user
    assert not forwarded


async def test_refusals():
    recorder = Recorder(ToolAnswer({}, "", False))
    async with api(lab_tools(), call=recorder) as client:
        cases = [
            ("POST", "/tools/lab/%zz", 400, "Bad path"),
            ("POST", "/tools/lab", 404, "Not found"),
            ("POST", "/tools/lab/search/more", 404, "Not found"),
            ("GET", "/tools/lab/search", 405, "Method not allowed"),
            ("POST", "/tools/nope/search", 404, 'No tool server "nope" in the menu'),
            (
                "POST",
                "/tools/lab/delete",
                403,
                "delete isn't one of lab's tools the app may call (ui.tools)",
            ),
            ("POST", "/tools/lab/search", 401, "Sign in first"),
        ]
        for method, path, status, error in cases:
            answer = await client.request(method, path, headers=ALICE if status != 401 else {})
            assert (answer.status_code, answer.json()) == (status, {"error": error}), path
        for body in (
            b"[]",
            b"{nope",
            b'{"arguments": [1]}',
            b'{"arguments": "x"}',
            b"1",
            b"x" * (64 * 1024 + 1),
        ):
            answer = await client.post("/tools/lab/search", headers=ALICE, content=body)
            assert (answer.status_code, answer.json()) == (
                400,
                {"error": "Expected {arguments: {...}}"},
            ), body[:20]
    assert not recorder.calls and not forwarded


async def test_a_call_carries_the_users_tokens():
    recorder = Recorder(ToolAnswer({"hits": [1]}, '{"hits": [1]}', False))
    async with api(lab_tools(), call=recorder) as client:
        answer = await client.post(
            "/tools/lab/search", headers=ALICE, json={"arguments": {"q": "cells"}}
        )
        assert (answer.status_code, answer.json()) == (
            200,
            {"result": {"hits": [1]}, "text": '{"hits": [1]}'},
        )
        assert answer.headers["cache-control"] == "no-store"
        # No body, and {arguments: null}, are no arguments.
        assert (await client.post("/tools/lab/save", headers=ALICE)).status_code == 200
        assert (
            await client.post("/tools/lab/save", headers=ALICE, json={"arguments": None})
        ).status_code == 200
    (name, tool, args, headers, timeout), *rest = recorder.calls
    assert (name, tool, args, timeout) == ("lab", "search", {"q": "cells"}, 7)
    assert [call[2] for call in rest] == [{}, {}]
    assert headers["Authorization"] == "Bearer k1"
    identity = tokens.verify(headers[tokens.IDENTITY_HEADER], SECRET, "mcp:lab")
    assert identity and identity["sub"] == "kc|alice" and identity["email"] == "alice@example.com"
    storage = tokens.verify(headers[tokens.STORAGE_HEADER], SECRET, tokens.STORAGE_AUDIENCE)
    assert storage and storage["sub"] == "kc|alice" and storage["via"] == "mcp:lab"
    assert 590 <= storage["exp"] - identity["exp"] + 3600 <= 600
    assert tokens.MEMORY_HEADER not in headers


async def test_without_login_no_tokens_are_sent():
    recorder = Recorder(ToolAnswer(None, "done", False))
    async with api(lab_tools(), secret=None, call=recorder) as client:
        answer = await client.post("/tools/lab/search", json={"arguments": {}})
        assert answer.json() == {"result": None, "text": "done"}
    assert recorder.calls[0][3] == {"Authorization": "Bearer k1"}


async def test_errors_and_unreachable_servers():
    async with api(
        lab_tools(),
        call=Recorder(ToolAnswer(None, "Error executing tool search: no such paper", True)),
    ) as c:
        answer = await c.post("/tools/lab/search", headers=ALICE)
        assert (answer.status_code, answer.json()) == (422, {"error": "no such paper"})
    async with api(lab_tools(), call=Recorder(ToolAnswer(None, "", True))) as c:
        assert (await c.post("/tools/lab/search", headers=ALICE)).json() == {
            "error": "search failed"
        }
    async with api(lab_tools(), call=Recorder(ConnectionError("refused"))) as c:
        answer = await c.post("/tools/lab/search", headers=ALICE)
        assert (answer.status_code, answer.json()) == (
            502,
            {"error": "Papers isn't reachable right now"},
        )


async def test_without_mcp_servers_typescript_answers():
    async with api(None) as client:
        assert (await client.get("/tools", headers=ALICE)).json() == {"from": "typescript"}
        assert (await client.post("/tools/lab/search", headers=ALICE)).json() == {
            "from": "typescript"
        }
        assert (await client.get("/toolsx", headers=ALICE)).json() == {"from": "typescript"}
    assert forwarded == ["GET /tools", "POST /tools/lab/search", "GET /toolsx"]


# --- A real MCP server, over streamable HTTP and SSE


@asynccontextmanager
async def mcp_server(transport: str) -> AsyncIterator[tuple[str, list[dict[str, str]]]]:
    from mcp.server.mcpserver import MCPServer
    from mcp.server.mcpserver.exceptions import ToolError

    lab = MCPServer("lab")

    @lab.tool()
    def search(query: str) -> dict:
        return {"hits": [query.upper()]}

    @lab.tool()
    def plain() -> str:
        return '{"a": 1}'

    @lab.tool()
    def boom() -> str:
        raise ToolError("the index is rebuilding")

    inner = lab.sse_app() if transport == "sse" else lab.streamable_http_app()
    seen: list[dict[str, str]] = []

    async def recording(scope, receive, send):
        if scope["type"] == "http":
            seen.append({k.decode(): v.decode() for k, v in scope["headers"]})
        await inner(scope, receive, send)

    server = uvicorn.Server(
        uvicorn.Config(recording, host="127.0.0.1", port=0, log_level="warning")
    )
    serving = asyncio.create_task(server.serve())
    try:
        while not server.started:
            await asyncio.sleep(0.01)
        port = server.servers[0].sockets[0].getsockname()[1]
        yield f"http://127.0.0.1:{port}/{'sse' if transport == 'sse' else 'mcp'}", seen
    finally:
        server.should_exit = True
        await serving


@pytest.mark.parametrize("transport", ["http", "sse"])
async def test_a_real_mcp_server(transport: str):
    async with mcp_server(transport) as (url, seen):
        config = {
            **LAB,
            "type": transport,
            "url": url,
            "ui": {"label": "Papers", "tools": ["search", "plain", "boom"]},
        }
        tools = ToolsSettings(servers=servers({"lab": config}, LAB_KEY="k1"), timeout=10)
        async with api(tools) as client:
            answer = await client.post(
                "/tools/lab/search", headers=ALICE, json={"arguments": {"query": "cells"}}
            )
            assert answer.status_code == 200, answer.text
            assert answer.json()["result"] == {"hits": ["CELLS"]}
            plain = (await client.post("/tools/lab/plain", headers=ALICE)).json()
            assert plain == {"result": {"result": '{"a": 1}'}, "text": '{"a": 1}'}
            boom = await client.post("/tools/lab/boom", headers=ALICE)
            assert (boom.status_code, boom.json()) == (422, {"error": "the index is rebuilding"})
            missing = await client.post("/tools/lab/search", headers=ALICE, json={"arguments": {}})
            assert missing.status_code == 422 and "query" in missing.json()["error"]
    assert seen and all(h.get("authorization") == "Bearer k1" for h in seen)
    identity = tokens.verify(seen[-1][tokens.IDENTITY_HEADER], SECRET, "mcp:lab")
    assert identity and identity["sub"] == "kc|alice"
    assert tokens.verify(seen[-1][tokens.STORAGE_HEADER], SECRET, tokens.STORAGE_AUDIENCE)


async def test_a_server_that_is_down():
    config = {**LAB, "url": "http://127.0.0.1:9/mcp"}
    tools = ToolsSettings(servers=servers({"lab": config}, LAB_KEY="k1"), timeout=5)
    async with api(tools) as client:
        answer = await client.post("/tools/lab/search", headers=ALICE)
        assert (answer.status_code, answer.json()) == (
            502,
            {"error": "Papers isn't reachable right now"},
        )
