"""/identity/public-key, /identity/mcp-tokens and /suggest served by api-py (server_routes.py).

Mirrors apps/agent/src/mcp-tokens.test.ts and suggest.test.ts, and checks the
routes as server.ts answers them: statuses, headers and the event stream.
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

import httpx
import pytest
from support import ALICE, SECRET, forwarded, storage_token, typescript

from api_py import tokens
from api_py.app import create_app
from api_py.config import Settings
from api_py.mcp_tokens import local_memory_token, mcp_tokens
from api_py.suggest import AGUI_MEDIA_TYPE, accepts_protobuf, suggest, suggest_prompt

pytestmark = pytest.mark.anyio

NOW = 1893456000  # 2030-01-01, in seconds
ALICE_CLAIMS = {"sub": "kc|alice", "email": "alice@example.com", "name": "Alice"}
ALL = {"servers": {"lab": ["identity", "storage", "memory"]}}


def storage(**claims: Any) -> str:
    return tokens.sign(
        {**ALICE_CLAIMS, "aud": "storage", "via": "remote", "exp": NOW + 1800, **claims}, SECRET
    )


def memory(**claims: Any) -> str:
    base = {"aud": "memory", "via": "remote", "thread": "t1", "node": None, "exp": NOW + 900}
    return tokens.sign({**ALICE_CLAIMS, **base, **claims}, SECRET)


def made(answer: tuple[int, dict[str, Any]]) -> dict[str, dict[str, str]]:
    status, body = answer
    assert status == 200, body
    return body["tokens"]


def test_each_kind_is_made_for_the_server():
    headers = {"x-knowledge-storage": storage(), "x-knowledge-memory": memory()}
    lab = made(mcp_tokens(headers, ALL, SECRET, NOW))["lab"]
    assert tokens.verify(lab["identity"], SECRET, "mcp:lab", NOW) == {
        **ALICE_CLAIMS,
        "aud": "mcp:lab",
        "exp": NOW + 1800,
    }
    assert tokens.verify(lab["storage"], SECRET, "storage", NOW) == {
        **ALICE_CLAIMS,
        "aud": "storage",
        "via": "mcp:lab",
        "exp": NOW + 1800,
    }
    # The chat's memory, expiring with the run's memory token.
    assert tokens.verify(lab["memory"], SECRET, "memory", NOW) == {
        **ALICE_CLAIMS,
        "aud": "memory",
        "via": "mcp:lab",
        "thread": "t1",
        "node": None,
        "exp": NOW + 900,
    }
    # An identity token lasts an hour at most, and none outlives the run's.
    long = made(mcp_tokens({"x-knowledge-storage": storage(exp=NOW + 9000)}, ALL, SECRET, NOW))
    assert tokens.read(long["lab"]["identity"], SECRET, NOW)["exp"] == NOW + 3600  # type: ignore[index]


def test_only_what_is_asked_for_and_no_memory_without_the_chats_token():
    body = {"servers": {"lab": ["memory"], "papers": ["identity"], "2": [], "10": ["identity"]}}
    found = made(mcp_tokens({"x-knowledge-storage": storage()}, body, SECRET, NOW))
    assert found["lab"] == {} and list(found["papers"]) == ["identity"]
    # The keys in JavaScript's order: array indexes first.
    assert list(found) == ["2", "10", "lab", "papers"]


def test_refused_without_the_runs_remote_storage_token():
    for headers in [
        {},
        {"x-knowledge-storage": storage(via="mcp:lab")},
        {"x-knowledge-storage": storage(exp=NOW - 1)},
        {"x-knowledge-storage": memory()},
    ]:
        assert mcp_tokens(headers, ALL, SECRET, NOW)[0] == 401


def test_someone_elses_memory_token_or_a_servers_gives_no_memory_token():
    for other in [memory(sub="kc|bob"), memory(via="mcp:other"), memory(thread="")]:
        headers = {"x-knowledge-storage": storage(), "x-knowledge-memory": other}
        assert "memory" not in made(mcp_tokens(headers, ALL, SECRET, NOW))["lab"]


def test_bad_requests_are_400():
    for body in [
        None,
        {},
        {"servers": []},
        {"servers": {"a b": ["identity"]}},
        {"servers": {"lab\n": ["identity"]}},
        {"servers": {"lab": ["root"]}},
        {"servers": {f"s{i}": [] for i in range(33)}},
    ]:
        assert mcp_tokens({"x-knowledge-storage": storage()}, body, SECRET, NOW)[0] == 400


def test_without_login_only_memory_in_the_local_form():
    local = local_memory_token("remote", "t1", None)
    lab = made(mcp_tokens({"x-knowledge-memory": local}, ALL, None, NOW))["lab"]
    assert lab == {"memory": local_memory_token("mcp:lab", "t1", None)}
    assert lab["memory"] == "local.eyJ2aWEiOiJtY3A6bGFiIiwidGhyZWFkIjoidDEiLCJub2RlIjpudWxsfQ"
    other = local_memory_token("mcp:x", "t1", None)
    assert made(mcp_tokens({"x-knowledge-memory": other}, ALL, None, NOW))["lab"] == {}


SUGGEST = {
    "name": "copilotkitSuggest",
    "description": "Suggest what the user could say next.",
    "parameters": {
        "type": "object",
        "properties": {"suggestions": {"type": "array"}},
        "required": ["suggestions"],
    },
}


def run_input(**overrides: Any) -> dict[str, Any]:
    return {
        "threadId": "t1",
        "runId": "r1",
        "state": {},
        "forwardedProps": {},
        "tools": [SUGGEST],
        "context": [
            {
                "description": "The user's knowledge workspace",
                "value": '{"openFile":"runs/etch/report.md"}',
            }
        ],
        "messages": [
            {"id": "1", "role": "user", "content": "Analyze the etch report"},
            {
                "id": "2",
                "role": "assistant",
                "content": "RF power dominates etch rate.",
                "toolCalls": [
                    {
                        "id": "c1",
                        "type": "function",
                        "function": {"name": "readWorkspaceFile", "arguments": "{}"},
                    }
                ],
            },
            {
                "id": "3",
                "role": "tool",
                "toolCallId": "c1",
                "content": "file body that should not be quoted",
            },
            {
                "id": "4",
                "role": "user",
                "content": "Suggest what the user could say next.\n"
                "Provide at least 2 and at most 3 suggestions.\n"
                'The user has the following tools available: [{"name":"readWorkspaceFile"}].\n'
                " Prefer next steps on the run.",
            },
        ],
        **overrides,
    }


def test_the_prompt_carries_the_conversation_workspace_and_request_not_tool_output():
    prompt = suggest_prompt(run_input())
    assert prompt is not None
    user = prompt["user"]
    assert user == (
        "<conversation>\nUser: Analyze the etch report\n\n"
        "Claude: RF power dominates etch rate.\n(Claude used readWorkspaceFile)\n</conversation>\n\n"
        '<workspace>\n<context description="The user\'s knowledge workspace">\n'
        '{"openFile":"runs/etch/report.md"}\n</context>\n</workspace>\n\n'
        "Suggest what the user could say next.\nProvide at least 2 and at most 3 suggestions.\n"
        " Prefer next steps on the run."
    )
    assert prompt["tool"] == {
        "name": "copilotkitSuggest",
        "description": SUGGEST["description"],
        "input_schema": SUGGEST["parameters"],
    }


def test_only_suggestion_requests_get_a_prompt_and_long_chats_keep_their_newest_lines():
    assert suggest_prompt(run_input(tools=[])) is None
    assert suggest_prompt(run_input(messages=[])) is None
    many = [{"role": "user", "content": f"message {i} " + "x" * 1500} for i in range(40)]
    prompt = suggest_prompt(run_input(messages=[*many, run_input()["messages"][-1]]))
    assert prompt is not None
    assert "message 39 " in prompt["user"] and "message 0 " not in prompt["user"]


async def test_the_answer_is_one_forced_call_streamed_as_events():
    chips = {"suggestions": [{"title": "Compare", "message": "Compare this run with litho."}]}
    sent: list[dict] = []

    async def create(params: dict) -> dict:
        sent.append(params)
        return {
            "content": [
                {"type": "tool_use", "id": "x", "name": "copilotkitSuggest", "input": chips}
            ]
        }

    events = await suggest(run_input(), create)
    (params,) = sent
    assert params["tool_choice"] == {"type": "tool", "name": "copilotkitSuggest"}
    assert params["max_tokens"] == 800
    assert [e["type"] for e in events] == [
        "RUN_STARTED",
        "TOOL_CALL_START",
        "TOOL_CALL_ARGS",
        "TOOL_CALL_END",
        "RUN_FINISHED",
    ]
    assert events[0] == {"type": "RUN_STARTED", "threadId": "t1", "runId": "r1"}
    assert json.loads(events[2]["delta"]) == chips
    assert events[1]["toolCallId"] == events[2]["toolCallId"] == events[3]["toolCallId"]

    async def fails(params: dict) -> dict:
        raise RuntimeError("overloaded")

    failed = await suggest(run_input(), fails)
    assert failed[1] == {"type": "RUN_ERROR", "message": "overloaded"}

    async def no_call(params: dict) -> dict:
        return {"content": [{"type": "tool_use", "name": "copilotkitSuggest", "input": {}}]}

    # {} is a call (it is truthy in JavaScript); null isn't.
    assert len(await suggest(run_input(), no_call)) == 5


def test_the_content_type_follows_the_accept_header_as_the_ag_ui_encoder_picks_it():
    for accept, proto in [
        (None, False),
        ("", False),
        ("text/event-stream", False),
        ("*/*", True),
        ("application/*", True),
        ("application/vnd.ag-ui.event+proto;q=0", False),
        ("application/vnd.ag-ui.event+proto;q=0, */*", False),
        ("*/*;q=0, application/vnd.ag-ui.event+proto", True),
        ("application/vnd.ag-ui.event+proto;charset=utf-8", False),
        ("*/*;q=abc", False),
        ('a/b;x="1,2", */*', True),
    ]:
        assert accepts_protobuf(accept) is proto, accept


@asynccontextmanager
async def api(secret: str | None = SECRET, create: Any = None) -> AsyncIterator[httpx.AsyncClient]:
    forwarded.clear()
    settings = Settings(
        ts_agent_url="http://ts", database_url=None, auth_secret=secret, migrations_dir=Path(".")
    )
    app = create_app(settings, transport=httpx.MockTransport(typescript))
    async with (
        app.router.lifespan_context(app),
        httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://api") as client,
    ):
        if create:
            app.state.create_message = create
        yield client


async def test_the_routes():
    async def create(params: dict) -> dict:
        return {"content": [{"type": "tool_use", "name": "copilotkitSuggest", "input": {"s": 1}}]}

    async with api(create=create) as client:
        key = await client.get("/identity/public-key")
        assert key.json() == {"alg": "Ed25519", "key": tokens.public_key(SECRET)}

        traded = await client.post(
            "/identity/mcp-tokens",
            headers={"x-knowledge-storage": storage(exp=2**40)},
            json={"servers": {"lab": ["identity"]}},
        )
        assert traded.status_code == 200 and traded.headers["cache-control"] == "no-store"
        assert list(traded.json()["tokens"]["lab"]) == ["identity"]
        for method, body, headers, status in [
            ("POST", b"{", {}, 400),
            ("POST", b"", {}, 400),
            ("POST", b'{"servers":{"a":[]},"x":"' + b"y" * 17_000 + b'"}', {}, 400),
            ("POST", json.dumps({"servers": {}}).encode(), {}, 401),
            ("POST", b'{"servers":{}}', storage_token("kc|alice"), 401),
            ("GET", b"", {}, 405),
        ]:
            answer = await client.request(
                method, "/identity/mcp-tokens", content=body, headers=headers
            )
            assert answer.status_code == status, (method, body[:20], answer.text)

        assert (await client.post("/suggest", json=run_input())).status_code == 401
        bad = await client.post("/suggest", headers=ALICE, content=b"{")
        assert (bad.status_code, bad.json()) == (400, {"error": "Invalid JSON body"})
        assert (await client.post("/suggest", headers=ALICE, content=b"null")).status_code == 400
        answer = await client.post(
            "/suggest", headers={**ALICE, "accept": "text/event-stream"}, json=run_input()
        )
        assert answer.headers["content-type"] == "text/event-stream"
        assert answer.headers["cache-control"] == "no-cache"
        lines = [json.loads(line[6:]) for line in answer.text.split("\n\n") if line]
        assert [e["type"] for e in lines][-1] == "RUN_FINISHED"
        assert lines[2]["delta"] == '{"s":1}'
        # No copilotkitSuggest tool: started, then the error, and no model call.
        plain = await client.post(
            "/suggest", headers={**ALICE, "accept": "*/*"}, json={"tools": [], "messages": []}
        )
        assert plain.headers["content-type"] == AGUI_MEDIA_TYPE
        assert plain.text == (
            'data: {"type":"RUN_STARTED"}\n\n'
            'data: {"type":"RUN_ERROR","message":"Expected a copilotkitSuggest request"}\n\n'
        )
        assert not forwarded

        # Other methods and spellings are the TypeScript server's.
        await client.get("/suggest")
        await client.head("/identity/public-key")
        await client.post("/identity%2Fmcp-tokens", json=ALL)
        assert forwarded == [
            "GET /suggest",
            "HEAD /identity/public-key",
            "POST /identity%2Fmcp-tokens",
        ]
        forwarded.clear()

    async with api(secret=None) as client:
        key = await client.get("/identity/public-key")
        assert (key.status_code, key.json()) == (
            404,
            {"error": "Login is off: there are no identity tokens."},
        )
        local = local_memory_token("remote", "t1", None)
        traded = await client.post(
            "/identity/mcp-tokens", headers={"x-knowledge-memory": local}, json=ALL
        )
        assert traded.json() == {
            "tokens": {"lab": {"memory": local_memory_token("mcp:lab", "t1", None)}}
        }
        events = await client.post("/suggest", json={"tools": []})
        assert events.status_code == 200
