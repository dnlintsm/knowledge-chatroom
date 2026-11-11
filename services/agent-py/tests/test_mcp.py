"""Outside MCP servers and tool chips: the same MCP_SERVERS as the agent server, with the user's tokens."""

from __future__ import annotations

import json
import time
from typing import Any

import httpx
import pytest
from agent_py.app import create_app, make_adapter
from agent_py.mcp import servers_from_env
from fastapi.testclient import TestClient

SERVERS = {
    "mcpServers": {
        "lab": {
            "url": "http://lab:9000/mcp",
            "headers": {"Authorization": "Bearer ${LAB_TOKEN}"},
            "forwardIdentity": True,
            "storageAccess": True,
            "memoryAccess": True,
            "ui": {"label": "Lab tools", "chip": "Lab", "mode": "manual"},
        },
        "papers": {
            "url": "http://papers:9100/mcp",
            "ui": {"label": "Search papers", "chip": "Papers"},
        },
        "local": {"type": "stdio", "command": "python", "args": ["tools.py"]},
    }
}


class AgentServer:
    """The agent server's /skills/run, /memory/agent and /identity/mcp-tokens."""

    def __init__(self) -> None:
        self.requests: list[httpx.Request] = []
        self.memory_on = True
        self.tokens_status = 200

    def handle(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        path = request.url.path
        if path == "/skills/run":
            return httpx.Response(200, json={"skills": []})
        if path == "/memory/agent":
            if not self.memory_on:
                return httpx.Response(
                    403, json={"error": "Memory is off in this chat (incognito, or turned off)"}
                )
            return httpx.Response(200, json={"prompt": "- Memory: ...", "tools": []})
        if path == "/identity/mcp-tokens":
            if self.tokens_status != 200:
                return httpx.Response(self.tokens_status, json={"error": "nope"})
            wanted = json.loads(request.content)["servers"]
            memory = request.headers.get("x-knowledge-memory")
            return httpx.Response(
                200,
                json={
                    "tokens": {
                        name: {k: f"{k}-for-{name}" for k in kinds if k != "memory" or memory}
                        for name, kinds in wanted.items()
                    }
                },
            )
        return httpx.Response(500, json={"error": f"unexpected {request.method} {path}"})

    def trades(self) -> list[httpx.Request]:
        return [r for r in self.requests if r.url.path == "/identity/mcp-tokens"]


@pytest.fixture
def agent_server() -> AgentServer:
    return AgentServer()


@pytest.fixture
def client(claude, agent_server, tmp_path):
    env = {
        "AGENT_PY_WORKDIR": str(tmp_path),
        "MCP_SERVERS": json.dumps(SERVERS),
        "LAB_TOKEN": "s3cret",
    }
    adapter = make_adapter(env, transport=httpx.MockTransport(agent_server.handle))
    with TestClient(create_app(env=env, adapter=adapter)) as c:
        yield c


def run_input(chips: list[str], thread: str = "t1") -> dict[str, Any]:
    return {
        "threadId": thread,
        "runId": f"r-{time.monotonic_ns()}",
        "state": {},
        "messages": [{"id": "m1", "role": "user", "content": "find papers"}],
        "tools": [],
        "context": [],
        "forwardedProps": {
            "knowledge_chatroom": {
                "version": 2,
                "user": {"id": "local"},
                "storage": "server",
                "tools": chips,
            }
        },
    }


def post(client, body, headers: dict[str, str] | None = None):
    response = client.post(
        "/agent/report",
        json=body,
        headers={
            "X-Knowledge-Storage": "storage-tok",
            "X-Knowledge-Memory": "memory-tok",
            **(headers or {}),
        },
    )
    assert response.status_code == 200, response.text
    return response


def test_reads_mcp_servers_as_the_agent_server_does(tmp_path, caplog):
    file = tmp_path / "mcp.json"
    file.write_text(
        json.dumps(
            {
                **SERVERS["mcpServers"],
                "copilotkit": {"url": "http://x/mcp"},
                "bad name": {"url": "http://x/mcp"},
                "sneaky": {"url": "http://x/mcp", "headers": {"x-knowledge-user": "forged"}},
                "ftp": {"url": "ftp://x"},
                "noisy": {"type": "stdio", "command": "x", "forwardIdentity": True},
                "badui": {"url": "http://x/mcp", "ui": {"chip": "No label"}},
            }
        )
    )
    servers = servers_from_env({"MCP_SERVERS": str(file), "LAB_TOKEN": "s3cret"})
    assert sorted(servers) == ["lab", "local", "papers"]
    assert servers["lab"].config == {
        "type": "http",
        "url": "http://lab:9000/mcp",
        "alwaysLoad": True,
        "headers": {"Authorization": "Bearer s3cret"},
    }
    assert servers["lab"].kinds == ("identity", "storage", "memory")
    assert servers["papers"].ui and servers["papers"].ui.mode == "auto"
    assert servers["local"].config == {"type": "stdio", "command": "python", "args": ["tools.py"]}
    assert servers_from_env({"MCP_SERVERS": "{not json"}) == {}


def test_a_run_gets_the_servers_with_the_users_tokens_and_its_chips(client, claude, agent_server):
    post(client, run_input(["lab", "nope"]))
    options = claude.created[0].options
    assert options.mcp_servers["lab"]["headers"] == {
        "Authorization": "Bearer s3cret",
        "X-Knowledge-User": "identity-for-lab",
        "X-Knowledge-Storage": "storage-for-lab",
        "X-Knowledge-Memory": "memory-for-lab",
    }
    assert "headers" not in options.mcp_servers["papers"]
    for name in ("lab", "papers", "local"):
        assert f"mcp__{name}" in options.allowed_tools
    assert (
        '- The user turned on "Lab" (Lab tools) for this chat: answer with the mcp__lab__ tools'
        in options.system_prompt
    )
    assert "Papers" not in options.system_prompt  # its chip is off
    (trade,) = agent_server.trades()
    assert json.loads(trade.content) == {"servers": {"lab": ["identity", "storage", "memory"]}}
    assert (
        trade.headers["x-knowledge-storage"] == "storage-tok"
        and trade.headers["x-knowledge-memory"] == "memory-tok"
    )


def test_a_manual_server_is_left_out_without_its_chip(client, claude):
    post(client, run_input([]))
    options = claude.created[0].options
    assert "lab" not in options.mcp_servers and "mcp__lab" not in options.allowed_tools
    assert "papers" in options.mcp_servers


def test_without_memory_in_the_chat_no_memory_token_is_asked_for(client, claude, agent_server):
    agent_server.memory_on = False
    post(client, run_input(["lab"]))
    assert "x-knowledge-memory" not in agent_server.trades()[0].headers
    assert "X-Knowledge-Memory" not in claude.created[0].options.mcp_servers["lab"]["headers"]


def test_when_the_trade_fails_the_servers_get_no_user(client, claude, agent_server):
    agent_server.tokens_status = 401
    post(client, run_input(["lab"]))
    assert claude.created[0].options.mcp_servers["lab"]["headers"] == {
        "Authorization": "Bearer s3cret"
    }
