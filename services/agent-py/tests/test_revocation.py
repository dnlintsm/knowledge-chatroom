"""Revocation at tool boundaries, the Python agent's side.

The engine tests run the real Claude Code engine (the SDK's bundled CLI) against
a scripted Messages API, so they can count model turns, and a storage API that
answers GET /access as api-py does: 404 once the user isn't a member of the
workspace, or it is archived.
"""

from __future__ import annotations

import asyncio
import json
import os
import tempfile
import threading
import uuid
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Literal, cast

import httpx
import pytest
from claude_agent_sdk import (
    ClaudeAgentOptions,
    ResultMessage,
    UserMessage,
    create_sdk_mcp_server,
    query,
    tool,
)

from agent_py.app import make_adapter
from agent_py.revocation import NO_LONGER_MEMBER, membership_hooks, no_longer_member
from agent_py.workspace import Storage

TOOL = "mcp__lab__long_task"


@dataclass
class Workspace:
    """The storage API, as far as GET /access sees it."""

    member: bool = True
    status: Literal["active", "archived"] = "active"
    calls: list[httpx.Request] = field(default_factory=list)
    fail: bool = False

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.calls.append(request)
        if self.fail:
            return httpx.Response(500, json={"error": "Storage error"})
        if request.url.path != "/access":
            return httpx.Response(200, json={"skills": []})
        if not self.member or self.status != "active":
            return httpx.Response(404, json={"error": "Workspace not found"})
        return httpx.Response(200, json={"me": None, "rootRole": "editor"})

    def storage(self) -> Storage:
        return Storage("http://storage.test", "tok", httpx.MockTransport(self.handler), "ws-1")


async def _hook(matcher: Any, event: str) -> dict[str, Any]:
    return await matcher.hooks[0]({"hook_event_name": event}, None, {"signal": None})


def test_the_hooks_stop_only_once_the_workspace_is_gone():
    asyncio.run(_the_hooks_stop_only_once_the_workspace_is_gone())


async def _the_hooks_stop_only_once_the_workspace_is_gone():
    ws = Workspace()
    hooks = membership_hooks(ws.storage)
    assert await _hook(hooks["PreToolUse"], "PreToolUse") == {}
    assert await _hook(hooks["PostToolBatch"], "PostToolBatch") == {}
    ws.member = False
    before = await _hook(hooks["PreToolUse"], "PreToolUse")
    assert before["continue_"] is False and before["stopReason"] == NO_LONGER_MEMBER
    assert before["hookSpecificOutput"]["permissionDecision"] == "deny"
    after = await _hook(hooks["PostToolBatch"], "PostToolBatch")
    assert after == {"continue_": False, "stopReason": NO_LONGER_MEMBER}
    # The check goes with the run's token and workspace.
    assert ws.calls[-1].headers["x-knowledge-storage"] == "tok"
    assert ws.calls[-1].headers["x-knowledge-workspace"] == "ws-1"


def test_an_archived_workspace_counts_as_gone_and_a_storage_failure_doesnt():
    ws = Workspace(status="archived")
    assert asyncio.run(no_longer_member(ws.storage()))
    ws.status, ws.fail = "active", True
    assert not asyncio.run(no_longer_member(ws.storage()))

    def down(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused", request=request)

    unreachable = Storage("http://storage.test", None, httpx.MockTransport(down))
    assert not asyncio.run(no_longer_member(unreachable))

    # A server without storage routes answers a bare 404: not a revocation.
    bare = Storage("http://storage.test", None, httpx.MockTransport(lambda _r: httpx.Response(404)))
    assert not asyncio.run(no_longer_member(bare))


def test_the_adapter_checks_first_before_each_call_and_after_each_batch():
    ws = Workspace()
    env = {"AUTH_MODE": "local", "LOCAL_AGENT_URL": "http://storage.test/"}
    options = make_adapter(env, httpx.MockTransport(ws.handler)).build_options(None, "t1")
    hooks = cast(dict[str, Any], options.hooks)
    assert hooks["PreToolUse"][0].matcher is None
    assert hooks["PostToolBatch"][0].matcher is None
    assert asyncio.run(_hook(hooks["PostToolBatch"][0], "PostToolBatch")) == {}
    ws.member = False
    assert asyncio.run(_hook(hooks["PostToolBatch"][0], "PostToolBatch"))["continue_"] is False


class ScriptedModel:
    """A Messages API that calls the lab tool `calls` times on the first chat turn and answers in text after."""

    def __init__(self, calls: int = 1) -> None:
        self.turns = 0
        model = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args: Any) -> None:
                pass

            def do_POST(self) -> None:
                length = int(self.headers.get("content-length") or 0)
                request = json.loads(self.rfile.read(length) or b"{}")
                if self.path.startswith("/v1/messages/count_tokens"):
                    return self._json({"input_tokens": 10})
                chat = bool(request.get("tools"))
                if chat:
                    model.turns += 1
                call = chat and model.turns == 1
                message_id = f"msg_{uuid.uuid4().hex}"
                if request.get("stream") is False:
                    return self._json(
                        {
                            "id": message_id,
                            "type": "message",
                            "role": "assistant",
                            "model": request.get("model"),
                            "content": [{"type": "text", "text": "ok"}],
                            "stop_reason": "end_turn",
                            "stop_sequence": None,
                            "usage": {"input_tokens": 10, "output_tokens": 1},
                        }
                    )
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.end_headers()

                def send(kind: str, data: dict[str, Any]) -> None:
                    body = json.dumps({"type": kind, **data})
                    self.wfile.write(f"event: {kind}\ndata: {body}\n\n".encode())

                send(
                    "message_start",
                    {
                        "message": {
                            "id": message_id,
                            "type": "message",
                            "role": "assistant",
                            "model": request.get("model"),
                            "content": [],
                            "stop_reason": None,
                            "stop_sequence": None,
                            "usage": {"input_tokens": 10, "output_tokens": 1},
                        }
                    },
                )
                if call:
                    blocks = [
                        (
                            {
                                "type": "tool_use",
                                "id": f"toolu_{uuid.uuid4().hex}",
                                "name": TOOL,
                                "input": {},
                            },
                            {"type": "input_json_delta", "partial_json": "{}"},
                        )
                        for _ in range(calls)
                    ]
                else:
                    blocks = [
                        (
                            {"type": "text", "text": ""},
                            {"type": "text_delta", "text": "Another turn."},
                        )
                    ]
                for index, (block, delta) in enumerate(blocks):
                    send("content_block_start", {"index": index, "content_block": block})
                    send("content_block_delta", {"index": index, "delta": delta})
                    send("content_block_stop", {"index": index})
                send(
                    "message_delta",
                    {
                        "delta": {
                            "stop_reason": "tool_use" if call else "end_turn",
                            "stop_sequence": None,
                        },
                        "usage": {"output_tokens": 5},
                    },
                )
                send("message_stop", {})

            def _json(self, body: dict[str, Any]) -> None:
                data = json.dumps(body).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()


@dataclass
class Outcome:
    turns: int
    ran: int
    results: str
    result: ResultMessage | None


async def run_with_tool(
    ws: Workspace,
    during: Literal["remove", "archive"] | None,
    error: bool = False,
    calls: int = 1,
) -> Outcome:
    """One prompt through the engine with the revocation hooks; the lab tool changes `ws` while it runs."""
    model = ScriptedModel(calls)
    ran = 0

    @tool("long_task", "A task that takes a while", {})
    async def long_task(_args: dict[str, Any]) -> dict[str, Any]:
        nonlocal ran
        ran += 1
        if during == "remove":
            ws.member = False
        elif during == "archive":
            ws.status = "archived"
        text = "the instrument failed" if error else "the task finished"
        return {
            "content": [{"type": "text", "text": text}],
            **({"is_error": True} if error else {}),
        }

    hooks = membership_hooks(ws.storage)
    messages: list[Any] = []
    with tempfile.TemporaryDirectory(prefix="revocation-test-") as cwd:
        options = ClaudeAgentOptions(
            cwd=cwd,
            model="claude-sonnet-4-5",
            tools=[],
            setting_sources=[],
            mcp_servers={"lab": create_sdk_mcp_server("lab", tools=[long_task])},
            allowed_tools=[TOOL],
            hooks=cast(Any, {event: [matcher] for event, matcher in hooks.items()}),
            max_turns=5,
            env={
                "ANTHROPIC_BASE_URL": model.url,
                "ANTHROPIC_API_KEY": "test-key",
                "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
                "NO_PROXY": "127.0.0.1,localhost",
                "no_proxy": "127.0.0.1,localhost",
            },
        )

        async def prompt():
            yield {"type": "user", "message": {"role": "user", "content": "Run the long task."}}

        try:
            async with asyncio.timeout(120):
                async for message in query(prompt=prompt(), options=options):
                    messages.append(message)
        finally:
            model.close()
    results = json.dumps([m.content for m in messages if isinstance(m, UserMessage)], default=str)
    result = next((m for m in messages if isinstance(m, ResultMessage)), None)
    return Outcome(model.turns, ran, results, result)


engine = pytest.mark.skipif(
    os.environ.get("AGENT_PY_SKIP_ENGINE") == "1", reason="AGENT_PY_SKIP_ENGINE=1"
)


@engine
@pytest.mark.parametrize(
    ("during", "error"), [("remove", False), ("remove", True), ("archive", False)]
)
def test_a_run_whose_workspace_goes_during_a_call_ends_after_it(during, error):
    """The accepted call runs to its end and its result is kept; the model gets no turn after it."""
    run = asyncio.run(run_with_tool(Workspace(), during, error))
    assert run.ran == 1
    assert ("the instrument failed" if error else "the task finished") in run.results
    assert run.turns == 1
    assert run.result is not None and run.result.terminal_reason == "hook_stopped"


@engine
@pytest.mark.parametrize("gone", ["remove", "archive"])
def test_a_call_after_the_workspace_went_is_refused(gone):
    """Gone between the model's turn and its call: the call never runs, nor does another turn."""
    ws = Workspace(member=gone != "remove", status="archived" if gone == "archive" else "active")
    run = asyncio.run(run_with_tool(ws, None))
    assert run.ran == 0
    assert run.turns == 1
    assert run.result is not None and run.result.terminal_reason == "hook_stopped"


@engine
def test_a_run_whose_user_stays_a_member_continues_after_the_call():
    run = asyncio.run(run_with_tool(Workspace(), None))
    assert run.ran == 1
    assert run.turns == 2
    assert run.result is not None and run.result.terminal_reason != "hook_stopped"


@engine
def test_of_two_calls_in_one_turn_the_accepted_one_ends_and_the_queued_one_is_refused():
    """
    The model asks for two calls at once and the user is removed during the
    first: it runs to its end and its result is kept, the second never runs,
    and no turn follows.
    """
    run = asyncio.run(run_with_tool(Workspace(), "remove", calls=2))
    assert run.ran == 1
    assert "the task finished" in run.results
    assert run.turns == 1
    assert run.result is not None and run.result.terminal_reason == "hook_stopped"
