from __future__ import annotations

import base64
import json
import os
import time
from typing import Any

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
from fastapi.testclient import TestClient

import httpx
from agent_py.app import create_app, make_adapter
from agent_py.prompt import SYSTEM_PROMPT

KEY = Ed25519PrivateKey.generate()
PUBLIC_KEY = base64.urlsafe_b64encode(KEY.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)).decode()


def b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode().rstrip("=")


def sign(payload: dict[str, Any], key: Ed25519PrivateKey = KEY) -> str:
    body = "v2." + b64(json.dumps(payload).encode())
    return body + "." + b64(key.sign(body.encode()))


ALICE = sign({"sub": "test|alice", "name": "Alice", "exp": time.time() + 300})


def run_input(
    text: str = "Hi",
    thread: str = "t1",
    user: dict[str, Any] | None = None,
    context: list[dict[str, str]] | None = None,
    **props: Any,
) -> dict[str, Any]:
    return {
        "threadId": thread,
        "runId": f"r-{time.monotonic_ns()}",
        "state": {},
        "messages": [{"id": "m1", "role": "user", "content": text}],
        "tools": [],
        "context": context if context is not None else [],
        "forwardedProps": {
            "knowledge_chatroom": {"version": 2, "user": user, "storage": "server", **props},
        },
    }


LOCAL = {"id": "local", "signed_in": False}
OPEN_FILE = [{"description": "openFile", "value": '{"path": "notes/a.md", "content": "1\\thello"}'}]


def events(response) -> list[dict[str, Any]]:
    assert response.status_code == 200, response.text
    return [json.loads(line[6:]) for line in response.text.splitlines() if line.startswith("data: ")]


def types(evts: list[dict[str, Any]]) -> list[str]:
    return [e["type"] for e in evts]


def no_skills(request: httpx.Request) -> httpx.Response:
    """The agent server, as far as a run without skills sees it."""
    if request.url.path == "/skills/run":
        return httpx.Response(200, json={"skills": []})
    return httpx.Response(500, json={"error": f"unexpected {request.method} {request.url.path}"})


@pytest.fixture
def client(claude):
    adapter = make_adapter({}, transport=httpx.MockTransport(no_skills))
    with TestClient(create_app(env={}, adapter=adapter)) as c:
        yield c


def test_health(client):
    assert client.get("/health").json() == {"status": "ok"}


def test_a_run_streams_the_models_answer(client, claude):
    evts = events(client.post("/agent/report", json=run_input(user=LOCAL)))
    assert types(evts)[0] == "RUN_STARTED"
    assert types(evts)[-1] == "RUN_FINISHED"
    text = "".join(e.get("delta", "") for e in evts if e["type"] == "TEXT_MESSAGE_CONTENT")
    assert text == claude.reply


def test_the_session_has_the_chatrooms_options(client, claude):
    body = run_input(user=LOCAL, context=OPEN_FILE)
    # The browser can't pick the model or resume another chat's session.
    body["forwardedProps"].update(model="claude-evil", resume="99999999-2222-3333-4444-555555555555")
    events(client.post("/agent/report", json=body))
    options = claude.created[0].options
    assert options.model == "claude-sonnet-5"
    assert options.tools == []
    assert options.resume is None
    # The user's own folder, holding only their skills (none here).
    assert os.listdir(options.cwd) == [".claude"]
    assert os.listdir(os.path.join(options.cwd, ".claude", "skills")) == [".fingerprint"]
    # The run's context goes in the user's message, not the system prompt.
    assert options.system_prompt == SYSTEM_PROMPT


def test_the_workspace_note_comes_with_the_message_when_it_changes(client, claude):
    events(client.post("/agent/report", json=run_input("one", user=LOCAL, context=OPEN_FILE)))
    events(client.post("/agent/report", json=run_input("two", user=LOCAL, context=OPEN_FILE)))
    moved = [{"description": "openFile", "value": '{"path": "notes/b.md", "content": "1\\tbye"}'}]
    events(client.post("/agent/report", json=run_input("three", user=LOCAL, context=moved)))
    (session,) = claude.created  # one session for the whole chat
    first, second, third = session.prompts
    assert first.startswith("<workspace>\nopenFile\n") and "notes/a.md" in first and first.endswith("\n\none")
    assert second == "two"
    assert "notes/b.md" in third and third.endswith("\n\nthree")


def test_each_chat_gets_its_own_note(client, claude):
    events(client.post("/agent/report", json=run_input("one", thread="a", user=LOCAL, context=OPEN_FILE)))
    events(client.post("/agent/report", json=run_input("one", thread="b", user=LOCAL, context=OPEN_FILE)))
    assert all(s.prompts[0].startswith("<workspace>") for s in claude.created)


def test_without_login_the_run_must_be_the_local_users(client, claude):
    evts = events(client.post("/agent/report", json=run_input(user={"id": "test|alice"})))
    assert types(evts) == ["RUN_ERROR"]
    assert claude.created == []


def test_a_run_for_no_one_is_refused(client, claude):
    evts = events(client.post("/agent/report", json=run_input(user=None)))
    assert types(evts) == ["RUN_ERROR"]
    assert "who you are" in evts[0]["message"]


def test_a_header_without_a_key_is_refused(client):
    response = client.post("/agent/report", json=run_input(user=LOCAL), headers={"X-Knowledge-User": ALICE})
    assert response.status_code == 401
    assert "KNOWLEDGE_PUBLIC_KEY" in response.json()["detail"]


@pytest.fixture
def login_client(claude):
    env = {"KNOWLEDGE_PUBLIC_KEY": PUBLIC_KEY}
    with TestClient(create_app(env=env, adapter=make_adapter(env, httpx.MockTransport(no_skills)))) as c:
        yield c


def test_with_login_runs_need_the_apps_signature(login_client, claude):
    alice = {"id": "test|alice", "signed_in": True}
    assert login_client.post("/agent/report", json=run_input(user=alice)).status_code == 401
    forged = sign({"sub": "test|alice", "exp": time.time() + 300}, Ed25519PrivateKey.generate())
    response = login_client.post("/agent/report", json=run_input(user=alice), headers={"X-Knowledge-User": forged})
    assert response.status_code == 401
    expired = sign({"sub": "test|alice", "exp": time.time() - 1})
    response = login_client.post("/agent/report", json=run_input(user=alice), headers={"X-Knowledge-User": expired})
    assert response.status_code == 401
    evts = events(login_client.post("/agent/report", json=run_input(user=alice), headers={"X-Knowledge-User": ALICE}))
    assert types(evts)[-1] == "RUN_FINISHED"


def test_with_login_the_run_must_be_for_the_signed_in_user(login_client, claude):
    bob = {"id": "test|bob", "signed_in": True}
    response = login_client.post("/agent/report", json=run_input(user=bob), headers={"X-Knowledge-User": ALICE})
    assert types(events(response)) == ["RUN_ERROR"]
    assert claude.created == []


def test_the_note_also_goes_in_front_of_a_message_with_parts(client, claude):
    body = run_input(user=LOCAL, context=OPEN_FILE)
    body["messages"][0]["content"] = [{"type": "text", "text": "what is this?"}]
    events(client.post("/agent/report", json=body))
    (prompt,) = claude.created[0].prompts
    blocks = prompt[0]["message"]["content"]
    assert blocks[0]["text"].startswith("<workspace>")
    assert blocks[-1]["text"] == "what is this?"


def test_the_session_gets_the_workspace_tools_and_the_runs_token(claude):
    env = {"LOCAL_AGENT_URL": "http://storage.test/"}
    with TestClient(create_app(env=env, adapter=make_adapter(env, httpx.MockTransport(no_skills)))) as c:
        response = c.post("/agent/report", json=run_input(user=LOCAL), headers={"X-Knowledge-Storage": "tok-1"})
        events(response)
        adapter_tokens = c.app.state.adapter._tokens
    options = claude.created[0].options
    assert "copilotkit" in options.mcp_servers
    assert "mcp__copilotkit__read_file" in options.allowed_tools
    assert adapter_tokens["t1"] == "tok-1"
