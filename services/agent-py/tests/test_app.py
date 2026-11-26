from __future__ import annotations

import base64
import json
import os
import time
from pathlib import Path
from typing import Any

import httpx
import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
from fastapi.testclient import TestClient

from agent_py.app import create_app, make_adapter
from agent_py.prompt import SYSTEM_PROMPT
from knowledge_chatroom.identity import LoginConfigError

KEY = Ed25519PrivateKey.generate()
PUBLIC_KEY = base64.urlsafe_b64encode(
    KEY.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
).decode()


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
# The session id the fake engine gives every chat (conftest.py).
SESSION = "11111111-2222-3333-4444-555555555555"
OPEN_FILE = [{"description": "openFile", "value": '{"path": "notes/a.md", "content": "1\\thello"}'}]


def events(response) -> list[dict[str, Any]]:
    assert response.status_code == 200, response.text
    return [
        json.loads(line[6:]) for line in response.text.splitlines() if line.startswith("data: ")
    ]


def types(evts: list[dict[str, Any]]) -> list[str]:
    return [e["type"] for e in evts]


def no_skills(request: httpx.Request) -> httpx.Response:
    """api-py, as far as a run without skills sees it."""
    if request.url.path == "/skills/run":
        return httpx.Response(200, json={"skills": []})
    return httpx.Response(500, json={"error": f"unexpected {request.method} {request.url.path}"})


@pytest.fixture
def client(claude):
    adapter = make_adapter({}, transport=httpx.MockTransport(no_skills))
    with TestClient(create_app(env={"AUTH_MODE": "local"}, adapter=adapter)) as c:
        yield c


def test_health(client):
    assert client.get("/health").json() == {"status": "ok"}


def test_a_run_streams_the_models_answer(client, claude):
    evts = events(client.post("/agent/report", json=run_input(user=LOCAL)))
    assert types(evts)[0] == "RUN_STARTED"
    assert types(evts)[-1] == "RUN_FINISHED"
    text = "".join(e.get("delta", "") for e in evts if e["type"] == "TEXT_MESSAGE_CONTENT")
    assert text == claude.reply


def test_model_discovery_and_switching_in_one_thread(claude):
    env = {
        "AUTH_MODE": "local",
        "CLAUDE_MODEL": "claude-sonnet-5",
        "CHAT_MODELS": "claude-haiku-4.5, claude-sonnet-5",
    }
    adapter = make_adapter(env, transport=httpx.MockTransport(no_skills))
    with TestClient(create_app(env=env, adapter=adapter)) as client:
        assert client.get("/agent/models").json() == {
            "default": "claude-sonnet-5",
            "models": ["claude-sonnet-5", "claude-haiku-4-5"],
        }
        bad = client.post("/agent/report", json=run_input(user=LOCAL, model="unavailable"))
        assert types(events(bad)) == ["RUN_ERROR"]
        assert claude.created == []
        for model in ("claude-haiku-4-5", None, "claude-haiku-4-5"):
            response = client.post("/agent/report", json=run_input(user=LOCAL, model=model))
            assert types(events(response))[-1] == "RUN_FINISHED"
        # Each run starts the engine with its model, resuming the chat's session.
        assert [c.options.model for c in claude.created] == [
            "claude-haiku-4-5",
            "claude-sonnet-5",
            "claude-haiku-4-5",
        ]
        assert [c.options.resume for c in claude.created] == [None, SESSION, SESSION]


def test_the_session_has_the_chatrooms_options(client, claude):
    body = run_input(user=LOCAL, context=OPEN_FILE)
    # The browser can't pick the model or resume another chat's session.
    body["forwardedProps"].update(
        model="claude-evil", resume="99999999-2222-3333-4444-555555555555"
    )
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
    # One session for the whole chat: each run's engine resumes it.
    assert [c.options.resume for c in claude.created] == [None, SESSION, SESSION]
    first, second, third = (prompt for c in claude.created for prompt in c.prompts)
    assert (
        first.startswith("<workspace>\nopenFile\n")
        and "notes/a.md" in first
        and first.endswith("\n\none")
    )
    assert second == "two"
    assert "notes/b.md" in third and third.endswith("\n\nthree")


def test_each_chat_gets_its_own_note(client, claude):
    events(
        client.post(
            "/agent/report", json=run_input("one", thread="a", user=LOCAL, context=OPEN_FILE)
        )
    )
    events(
        client.post(
            "/agent/report", json=run_input("one", thread="b", user=LOCAL, context=OPEN_FILE)
        )
    )
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
    response = client.post(
        "/agent/report", json=run_input(user=LOCAL), headers={"X-Knowledge-User": ALICE}
    )
    assert response.status_code == 401
    assert "KNOWLEDGE_PUBLIC_KEY" in response.json()["detail"]


def test_login_is_never_guessed_from_a_missing_key(claude):
    """A setting left out must not turn login off."""
    with pytest.raises(LoginConfigError, match="Login is not configured"):
        create_app(env={}, adapter=make_adapter({}, httpx.MockTransport(no_skills)))
    with pytest.raises(LoginConfigError, match="must not be set"):
        env = {"AUTH_MODE": "local", "KNOWLEDGE_PUBLIC_KEY": PUBLIC_KEY}
        create_app(env=env, adapter=make_adapter(env, httpx.MockTransport(no_skills)))
    # Login is on (the mode says so, or the shared .env has the app's secret) but
    # the key is missing: nobody is the local user, signed or not.
    for env in ({"AUTH_MODE": "oidc"}, {"AUTH_SECRET": "0123456789abcdef0123456789abcdef"}):
        app = create_app(env=env, adapter=make_adapter(env, httpx.MockTransport(no_skills)))
        with TestClient(app) as c:
            for headers in ({}, {"X-Knowledge-User": ALICE}):
                response = c.post("/agent/report", json=run_input(user=LOCAL), headers=headers)
                assert response.status_code == 401
                assert "KNOWLEDGE_PUBLIC_KEY" in response.json()["detail"]
            assert c.get("/agent/models").status_code == 401
    assert claude.created == []


@pytest.fixture
def login_client(claude):
    env = {"KNOWLEDGE_PUBLIC_KEY": PUBLIC_KEY}
    with TestClient(
        create_app(env=env, adapter=make_adapter(env, httpx.MockTransport(no_skills)))
    ) as c:
        yield c


def test_with_login_runs_need_the_apps_signature(login_client, claude):
    alice = {"id": "test|alice", "signed_in": True}
    assert login_client.post("/agent/report", json=run_input(user=alice)).status_code == 401
    forged = sign({"sub": "test|alice", "exp": time.time() + 300}, Ed25519PrivateKey.generate())
    response = login_client.post(
        "/agent/report", json=run_input(user=alice), headers={"X-Knowledge-User": forged}
    )
    assert response.status_code == 401
    expired = sign({"sub": "test|alice", "exp": time.time() - 1})
    response = login_client.post(
        "/agent/report", json=run_input(user=alice), headers={"X-Knowledge-User": expired}
    )
    assert response.status_code == 401
    evts = events(
        login_client.post(
            "/agent/report", json=run_input(user=alice), headers={"X-Knowledge-User": ALICE}
        )
    )
    assert types(evts)[-1] == "RUN_FINISHED"


def test_with_login_the_run_must_be_for_the_signed_in_user(login_client, claude):
    bob = {"id": "test|bob", "signed_in": True}
    response = login_client.post(
        "/agent/report", json=run_input(user=bob), headers={"X-Knowledge-User": ALICE}
    )
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
    env = {"AUTH_MODE": "local", "LOCAL_AGENT_URL": "http://storage.test/"}
    with TestClient(
        create_app(env=env, adapter=make_adapter(env, httpx.MockTransport(no_skills)))
    ) as c:
        response = c.post(
            "/agent/report", json=run_input(user=LOCAL), headers={"X-Knowledge-Storage": "tok-1"}
        )
        events(response)
        adapter_tokens = c.app.state.adapter._tokens
    options = claude.created[0].options
    assert "copilotkit" in options.mcp_servers
    assert "mcp__copilotkit__read_file" in options.allowed_tools
    assert adapter_tokens["t1"] == "tok-1"


def test_the_runs_workspace_goes_with_its_storage_calls(claude):
    """Without login there is no storage token: the app's workspace header names it."""
    ws = "11111111-2222-4333-8444-555555555555"
    seen: list[httpx.Request] = []

    def server(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return no_skills(request)

    env = {"AUTH_MODE": "local", "LOCAL_AGENT_URL": "http://storage.test/"}
    with TestClient(
        create_app(env=env, adapter=make_adapter(env, httpx.MockTransport(server)))
    ) as c:
        events(
            c.post(
                "/agent/report", json=run_input(user=LOCAL), headers={"X-Knowledge-Workspace": ws}
            )
        )
        storage = c.app.state.adapter._storage("t1")
    assert storage.workspace == ws and storage.token is None
    # Skills, then the working folder's copy (workdir.py): all in the page's workspace.
    assert {"/skills/run", "/nodes", "/experiments"} <= {r.url.path for r in seen}
    assert {r.headers.get("x-knowledge-workspace") for r in seen} == {ws}


def test_an_unexpected_failure_getting_a_run_ready_is_a_run_error(client, claude, monkeypatch):
    """It used to break the stream with no event at all; the chat showed nothing."""
    from agent_py.adapter import ChatroomAdapter

    load_skills = ChatroomAdapter._skills_for
    failed = False

    async def fails_once(self, thread_id):
        nonlocal failed
        if not failed:
            failed = True
            raise RuntimeError("the disk under /var/lib/agent-py is full")
        return await load_skills(self, thread_id)

    monkeypatch.setattr(ChatroomAdapter, "_skills_for", fails_once)
    evts = events(client.post("/agent/report", json=run_input(user=LOCAL)))
    assert types(evts) == ["RUN_ERROR"]
    # What went wrong is for the log, not the chat.
    assert evts[0]["message"] == "Couldn't start the run. Please try again."
    assert claude.created == []

    # Nothing is left half set up: the next run of the same chat works.
    again = events(client.post("/agent/report", json=run_input(user=LOCAL)))
    assert (types(again)[0], types(again)[-1]) == ("RUN_STARTED", "RUN_FINISHED")


def test_a_run_marks_its_folder_and_idle_ones_are_removed_as_runs_start(claude, tmp_path):
    from agent_py.skills import run_folder
    from agent_py.workdir import LAST_USED, mark_used

    stale = run_folder(tmp_path, "someone-who-left")
    mark_used(stale)
    (stale / "workspace").mkdir()
    long_ago = time.time() - 3 * 24 * 3600
    os.utime(stale / LAST_USED, (long_ago, long_ago))

    env = {"AUTH_MODE": "local", "AGENT_PY_WORKDIR": str(tmp_path)}
    adapter = make_adapter(env, transport=httpx.MockTransport(no_skills))
    with TestClient(create_app(env=env, adapter=adapter)) as c:
        evts = events(c.post("/agent/report", json=run_input(user=LOCAL)))
        assert types(evts)[-1] == "RUN_FINISHED"
        mine = run_folder(tmp_path, LOCAL["id"])
        assert (mine / LAST_USED).exists()
        assert not stale.exists()
        # Held only while the run lasts.
        assert not adapter._in_use


def test_a_folders_idle_time_counts_from_the_end_of_its_last_run(claude, tmp_path, monkeypatch):
    """A run longer than the idle wait must not leave its folder due for removal as it finishes."""
    from agent_py.skills import run_folder
    from agent_py.workdir import LAST_USED

    mark = run_folder(tmp_path, LOCAL["id"]) / LAST_USED
    long_ago = time.time() - 3 * 24 * 3600
    answer = claude.query

    async def after_days(self, prompt, session_id="default"):
        # As if the run had started three days ago.
        os.utime(mark, (long_ago, long_ago))
        await answer(self, prompt, session_id)

    monkeypatch.setattr(claude, "query", after_days)
    env = {"AUTH_MODE": "local", "AGENT_PY_WORKDIR": str(tmp_path)}
    adapter = make_adapter(env, transport=httpx.MockTransport(no_skills))
    with TestClient(create_app(env=env, adapter=adapter)) as c:
        evts = events(c.post("/agent/report", json=run_input(user=LOCAL)))
        assert types(evts)[-1] == "RUN_FINISHED"
        assert time.time() - mark.stat().st_mtime < 60
        # Another chat's run, starting right after, leaves the folder alone.
        adapter._swept_at = None
        other = run_input(user=LOCAL)
        other["threadId"] = "t2"
        events(c.post("/agent/report", json=other))
        assert mark.exists()


def test_one_run_at_a_time_in_a_users_run_folder(claude, tmp_path, monkeypatch):
    """
    Two chats of one user share a run folder. Their runs used to overlap: the
    second swapped the skills, cleared run-inputs/ and re-copied the workspace
    under the first.
    """
    import asyncio

    running = 0
    most: dict[str, int] = {}
    answer = claude.query

    async def slowly(self, prompt, session_id="default"):
        nonlocal running
        running += 1
        folder = Path(self.options.cwd).name
        most[folder] = max(most.get(folder, 0), running)
        try:
            await asyncio.sleep(0.2)
            await answer(self, prompt, session_id)
        finally:
            running -= 1

    monkeypatch.setattr(claude, "query", slowly)
    env = {"AUTH_MODE": "local", "AGENT_PY_WORKDIR": str(tmp_path)}
    adapter = make_adapter(env, transport=httpx.MockTransport(no_skills))
    app = create_app(env=env, adapter=adapter)

    async def run(api: httpx.AsyncClient, thread: str, workspace: str | None = None) -> list[str]:
        body = run_input(user=LOCAL)
        body["threadId"] = thread
        headers = {"X-Knowledge-Workspace": workspace} if workspace else {}
        return types(events(await api.post("/agent/report", json=body, headers=headers)))

    async def both() -> None:
        nonlocal running
        async with (
            app.router.lifespan_context(app),
            httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://a") as api,
        ):
            # Two chats, one workspace: the second waits, and both finish.
            first, second = await asyncio.gather(run(api, "chat-1"), run(api, "chat-2"))
            assert first[-1] == second[-1] == "RUN_FINISHED"
            assert list(most.values()) == [1]  # one folder, never two runs in it
            # Another workspace is another folder: its run doesn't wait.
            most.clear()
            await asyncio.gather(run(api, "chat-3"), run(api, "chat-4", workspace="w2"))
            assert max(most.values()) == 2 and len(most) == 2
        # Nothing is held once the runs are over.
        assert not adapter._in_use and not any(lock.locked() for lock in adapter._folders.values())

    asyncio.run(both())


def test_a_waiting_run_that_is_stopped_frees_its_place(claude, tmp_path, monkeypatch):
    """Stop in the chat that waits ends the wait, and later runs are not held up by it."""
    import asyncio

    answer = claude.query

    async def slowly(self, prompt, session_id="default"):
        await asyncio.sleep(0.3)
        await answer(self, prompt, session_id)

    monkeypatch.setattr(claude, "query", slowly)
    env = {"AUTH_MODE": "local", "AGENT_PY_WORKDIR": str(tmp_path)}
    adapter = make_adapter(env, transport=httpx.MockTransport(no_skills))
    app = create_app(env=env, adapter=adapter)

    async def run(api: httpx.AsyncClient, thread: str) -> list[str]:
        body = run_input(user=LOCAL)
        body["threadId"] = thread
        return types(events(await api.post("/agent/report", json=body)))

    async def stopped_while_waiting() -> None:
        async with (
            app.router.lifespan_context(app),
            httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://a") as api,
        ):
            first = asyncio.create_task(run(api, "chat-1"))
            await asyncio.sleep(0.1)  # chat-1's run is in the folder
            waiting = asyncio.create_task(run(api, "chat-2"))
            await asyncio.sleep(0.05)
            waiting.cancel()  # the browser's Stop closes the request
            with pytest.raises(asyncio.CancelledError):
                await waiting
            assert (await first)[-1] == "RUN_FINISHED"
            # The stopped run started nothing, and the next one goes straight in.
            assert len(claude.created) == 1
            assert (await asyncio.wait_for(run(api, "chat-2"), 5))[-1] == "RUN_FINISHED"
        assert not adapter._in_use

    asyncio.run(stopped_while_waiting())


def test_a_run_waits_no_longer_than_its_tokens_allow(claude, tmp_path, monkeypatch):
    """
    A run's storage and memory tokens are signed when it is sent. One that
    waited behind another chat until they ran out started anyway, and every
    call it made was refused.
    """
    import asyncio

    from agent_py.adapter import patience, token_expiry

    def token(expires_in: float) -> str:
        claims = {"sub": "kc|alice", "aud": "storage", "exp": time.time() + expires_in}
        body = base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip("=")
        return f"v2.{body}.signature"

    # Half of what the shortest-lived token has left; nothing to go by without one.
    assert patience(None, None) is None and patience("local.e30") is None
    assert token_expiry(token(100)) == pytest.approx(time.time() + 100, abs=1)
    assert patience(token(3600), token(600)) == pytest.approx(300, abs=1)
    assert patience(token(-5)) == 0

    answer = claude.query

    async def slowly(self, prompt, session_id="default"):
        await asyncio.sleep(0.6)
        await answer(self, prompt, session_id)

    monkeypatch.setattr(claude, "query", slowly)
    env = {"AUTH_MODE": "local", "AGENT_PY_WORKDIR": str(tmp_path)}
    adapter = make_adapter(env, transport=httpx.MockTransport(no_skills))
    app = create_app(env=env, adapter=adapter)

    async def run(api: httpx.AsyncClient, thread: str, storage: str | None) -> list[dict]:
        body = run_input(user=LOCAL)
        body["threadId"] = thread
        headers = {"X-Knowledge-Storage": storage} if storage else {}
        return events(await api.post("/agent/report", json=body, headers=headers))

    async def waiting() -> None:
        async with (
            app.router.lifespan_context(app),
            httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://a") as api,
        ):
            first = asyncio.create_task(run(api, "chat-1", token(3600)))
            await asyncio.sleep(0.1)  # chat-1's run is in the folder
            # 0.4 s of token left: it may wait 0.2 s, and the folder is taken for longer.
            short = await run(api, "chat-2", token(0.4))
            assert types(short) == ["RUN_ERROR"]
            assert "Send it again" in short[0]["message"]
            assert len(claude.created) == 1  # it never started
            # A token with life to spare waits and runs.
            patient = await run(api, "chat-3", token(3600))
            assert types(patient)[-1] == "RUN_FINISHED"
            assert types(await first)[-1] == "RUN_FINISHED"
            # Nobody ahead of it: a run starts whatever its token has left.
            alone = await run(api, "chat-4", token(0.2))
            assert types(alone)[-1] == "RUN_FINISHED"
        assert not adapter._in_use and not any(lock.locked() for lock in adapter._folders.values())

    asyncio.run(waiting())


def test_a_chat_keeps_its_session_when_the_server_restarts(claude, tmp_path, monkeypatch):
    """Claude used to forget the chat: the link to its session was only in memory."""
    import claude_agent_sdk

    env = {"AUTH_MODE": "local", "AGENT_PY_WORKDIR": str(tmp_path)}

    def restarted() -> TestClient:
        adapter = make_adapter(env, transport=httpx.MockTransport(no_skills))
        return TestClient(create_app(env=env, adapter=adapter))

    with restarted() as c:
        events(c.post("/agent/report", json=run_input("one", user=LOCAL)))
    with restarted() as c:
        events(c.post("/agent/report", json=run_input("two", user=LOCAL)))
        # Another chat of the same user starts its own session.
        events(c.post("/agent/report", json=run_input("hi", thread="t2", user=LOCAL)))
    assert [c.options.resume for c in claude.created] == [None, SESSION, None]

    # Claude Code's home was not kept: the transcript is gone, so the chat
    # starts a new session instead of failing every run from now on.
    monkeypatch.setattr(claude_agent_sdk, "get_session_info", lambda sid, directory=None: None)
    with restarted() as c:
        evts = events(c.post("/agent/report", json=run_input("three", user=LOCAL)))
    assert types(evts)[-1] == "RUN_FINISHED"
    assert claude.created[-1].options.resume is None


def test_the_note_is_not_sent_again_to_a_session_that_has_it(claude, tmp_path):
    """
    With the browser's tools (every run of the real app) each run starts a new
    engine process, which used to count as a new session: the note with the
    open file went with every message.
    """
    env = {"AUTH_MODE": "local", "AGENT_PY_WORKDIR": str(tmp_path)}
    tools = [{"name": "writeWorkspaceFile", "description": "Writes a file", "parameters": {}}]

    def ask(c: TestClient, text: str, context: list[dict[str, str]]) -> None:
        body = run_input(text, user=LOCAL, context=context)
        body["tools"] = tools
        events(c.post("/agent/report", json=body))

    adapter = make_adapter(env, transport=httpx.MockTransport(no_skills))
    with TestClient(create_app(env=env, adapter=adapter)) as c:
        ask(c, "one", OPEN_FILE)
        ask(c, "two", OPEN_FILE)
    first, second = (prompt for c in claude.created for prompt in c.prompts)
    assert first.startswith("<workspace>") and second == "two"
    # After a restart the server no longer knows what the session was told: it says it again.
    adapter = make_adapter(env, transport=httpx.MockTransport(no_skills))
    with TestClient(create_app(env=env, adapter=adapter)) as c:
        ask(c, "three", OPEN_FILE)
    assert claude.created[-1].options.resume == SESSION
    assert claude.created[-1].prompts[0].startswith("<workspace>")


def test_every_storage_call_of_the_server_goes_through_one_http_client(claude, monkeypatch):
    """A client per call meant a new connection for each of the several calls a tool call makes."""
    made: list[httpx.AsyncClient] = []
    init = httpx.AsyncClient.__init__

    def counting(self, *args, **kwargs):
        made.append(self)
        init(self, *args, **kwargs)

    monkeypatch.setattr(httpx.AsyncClient, "__init__", counting)
    ws = "11111111-2222-4333-8444-555555555555"
    seen: list[httpx.Request] = []

    def api(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return no_skills(request)

    env = {"AUTH_MODE": "local", "LOCAL_AGENT_URL": "http://storage.test/"}
    adapter = make_adapter(env, httpx.MockTransport(api))
    with TestClient(create_app(env=env, adapter=adapter)) as c:
        for thread in ("t1", "t2"):
            body = run_input(user=LOCAL)
            body["threadId"] = thread
            headers = {"X-Knowledge-Storage": f"tok-{thread}", "X-Knowledge-Workspace": ws}
            events(c.post("/agent/report", json=body, headers=headers))
        client = adapter._http
        assert client is not None and not client.is_closed
        assert adapter._storage("t1").client is adapter._storage("t2").client is client
    # Several calls per run (skills, the working folder's listing), all on that client.
    to_storage = [m for m in made if str(m.base_url).startswith("http://storage.test")]
    assert len(seen) >= 4 and to_storage == [client]
    # Each call still carries its own run's token and workspace.
    assert {r.headers.get("x-knowledge-storage") for r in seen} == {"tok-t1", "tok-t2"}
    assert {r.headers.get("x-knowledge-workspace") for r in seen} == {ws}
    # Closed with the server.
    assert client.is_closed and adapter._http is None
