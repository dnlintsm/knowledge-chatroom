"""Skills' scripts: Bash in Claude Code's sandbox, with a stand-in key."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

import httpx
from fastapi.testclient import TestClient
from test_skills import AgentServer, events, run_input

from agent_py.app import create_app, make_adapter
from agent_py.keyproxy import KeyProxy, KeyRoute
from agent_py.scripts import Scripts, script_options, scripts_from_env
from agent_py.skills import RunSkill

ROUTE = KeyRoute("http://127.0.0.1:1", "sk-ant-run-x")
SCRIPTED = [RunSkill("one", "auto", "builtin", needs_execution=True)]


def test_scripts_are_on_only_with_skill_scripts_on():
    assert scripts_from_env({}) is None
    assert scripts_from_env({"SKILL_SCRIPTS": "yes"}) is None
    on = scripts_from_env(
        {"SKILL_SCRIPTS": "on", "SKILL_SCRIPTS_DENY_READ": "/srv/keys, relative, /opt/creds"}
    )
    assert on is not None and on.deny_read == ("/srv/keys", "/opt/creds")


def test_script_options_only_for_a_run_with_scripts_and_a_key_route(tmp_path: Path):
    scripts = Scripts(app_root=tmp_path / "app")
    cwd = tmp_path / "runs" / "abc"
    plain = [RunSkill("one", "auto", "builtin")]
    assert script_options(None, cwd, SCRIPTED, ROUTE, tmp_path / "runs") is None
    assert script_options(scripts, cwd, plain, ROUTE, tmp_path / "runs") is None
    assert script_options(scripts, cwd, SCRIPTED, None, tmp_path / "runs") is None
    assert script_options(scripts, None, SCRIPTED, ROUTE, tmp_path / "runs") is None


def test_script_runs_are_sandboxed_and_hold_no_secrets(tmp_path: Path):
    app, runs = tmp_path / "app", tmp_path / "runs"
    cwd = runs / "abc"
    scripts = Scripts(app_root=app, deny_read=("/srv/keys",))
    inherited = {
        "ANTHROPIC_API_KEY": "sk-real",
        "ANTHROPIC_AUTH_TOKEN": "tok",
        "ANTHROPIC_MODEL": "claude-x",
        "DATABASE_URL": "postgres://secret",
        "HTTPS_PROXY": "http://user:pass@proxy",
        "KNOWLEDGE_PUBLIC_KEY": "pk",
        "VIRTUAL_ENV": str(app / ".venv"),
        "PATH": f"{app / '.venv' / 'bin'}:/usr/local/bin:/usr/bin",
        "LANG": "C.UTF-8",
    }
    options = script_options(scripts, cwd, SCRIPTED, ROUTE, runs, inherited)
    assert options is not None
    env = options["env"]
    assert env["ANTHROPIC_API_KEY"] == "sk-ant-run-x"
    assert env["ANTHROPIC_BASE_URL"] == "http://127.0.0.1:1"
    assert env["ANTHROPIC_MODEL"] == "claude-x" and env["LANG"] == "C.UTF-8"
    # The virtualenv is unreadable for scripts: commands are found elsewhere.
    assert env["PATH"] == "/usr/local/bin:/usr/bin"
    assert env["NO_PROXY"] == env["no_proxy"] == "127.0.0.1,localhost"
    # The SDK adds this server's environment under the run's: secrets are blanked.
    for key in (
        "ANTHROPIC_AUTH_TOKEN",
        "DATABASE_URL",
        "HTTPS_PROXY",
        "KNOWLEDGE_PUBLIC_KEY",
        "VIRTUAL_ENV",
    ):
        assert env[key] == "", key
    sandbox = options["sandbox"]
    assert sandbox["enabled"] and sandbox["failIfUnavailable"]
    assert sandbox["allowUnsandboxedCommands"] is False
    assert sandbox["network"] == {"allowedDomains": []}
    fs = sandbox["filesystem"]
    assert fs["denyWrite"] == [
        str(cwd / ".claude"),
        str(cwd / "CLAUDE.md"),
        str(cwd / "CLAUDE.local.md"),
        str(cwd / ".mcp.json"),
        str(cwd / "workspace"),
        str(cwd / ".workspace-manifest.json"),
        str(cwd / "run-inputs"),
    ]
    assert fs["denyRead"] == [
        str(app.resolve()),
        str(runs.resolve()),
        str(Path.home().resolve()),
        "/run/secrets",
        "/var/run/secrets",
        "/etc/secrets",
        "/srv/keys",
    ]
    assert fs["allowRead"] == [str(cwd)]


class Upstream:
    """Anthropic, as the key proxy reaches it."""

    def __init__(self) -> None:
        self.requests: list[httpx.Request] = []

    def handle(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        return httpx.Response(200, json={"ok": True}, headers={"request-id": "req_1"})


def test_the_key_proxy_swaps_its_stand_in_for_the_real_key():
    upstream = Upstream()

    async def go():
        proxy = KeyProxy(
            "https://anthropic.test/",
            {"ANTHROPIC_API_KEY": "sk-real"},
            httpx.MockTransport(upstream.handle),
        )
        route = await proxy.start()
        try:
            async with httpx.AsyncClient(base_url=route.base_url) as client:
                ok = await client.post(
                    "/v1/messages?beta=true",
                    headers={"x-api-key": route.api_key, "anthropic-version": "2023-06-01"},
                    content=b'{"model":"m"}',
                )
                bearer = await client.get(
                    "/v1/models", headers={"authorization": f"Bearer {route.api_key}"}
                )
                wrong = await client.post("/v1/messages", headers={"x-api-key": "sk-real"})
                none = await client.post("/v1/messages")
        finally:
            await proxy.close()
        return route, ok, bearer, wrong, none

    route, ok, bearer, wrong, none = asyncio.run(go())
    assert route.api_key.startswith("sk-ant-run-") and route.base_url.startswith(
        "http://127.0.0.1:"
    )
    assert ok.status_code == 200 and ok.json() == {"ok": True}
    assert ok.headers["request-id"] == "req_1"
    assert bearer.status_code == 200
    assert wrong.status_code == 401 and none.status_code == 401
    assert wrong.json()["error"]["type"] == "authentication_error"
    sent, models = upstream.requests  # the refused ones never went out
    assert str(sent.url) == "https://anthropic.test/v1/messages?beta=true"
    assert sent.headers["x-api-key"] == "sk-real" and "authorization" not in sent.headers
    assert sent.headers["anthropic-version"] == "2023-06-01"
    assert sent.content == b'{"model":"m"}'
    assert models.method == "GET" and models.headers["x-api-key"] == "sk-real"


def test_the_key_proxy_sends_a_bearer_token_without_an_api_key_and_answers_502_when_down():
    def down(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused", request=request)

    seen: list[httpx.Request] = []

    async def go(env, handler):
        proxy = KeyProxy("https://anthropic.test", env, httpx.MockTransport(handler))
        route = await proxy.start()
        try:
            async with httpx.AsyncClient(base_url=route.base_url) as client:
                return await client.post("/v1/messages", headers={"x-api-key": route.api_key})
        finally:
            await proxy.close()

    answer = asyncio.run(
        go({"ANTHROPIC_AUTH_TOKEN": "tok"}, lambda r: seen.append(r) or httpx.Response(204))
    )
    assert answer.status_code == 204
    assert seen[0].headers["authorization"] == "Bearer tok" and "x-api-key" not in seen[0].headers
    answer = asyncio.run(go({"ANTHROPIC_API_KEY": "sk-real"}, down))
    assert answer.status_code == 502 and answer.json()["error"]["type"] == "api_error"


def scripted_server() -> AgentServer:
    server = AgentServer()
    server.skills[0]["needsExecution"] = True
    return server


def test_a_run_with_a_scripted_skill_gets_sandboxed_bash(claude, tmp_path, monkeypatch):
    monkeypatch.setenv("DATABASE_URL", "postgres://secret")
    server = scripted_server()
    env = {"AUTH_MODE": "local", "AGENT_PY_WORKDIR": str(tmp_path), "SKILL_SCRIPTS": "on"}
    adapter = make_adapter(env, transport=httpx.MockTransport(server.handle))
    with TestClient(create_app(env=env, adapter=adapter)) as c:
        events(c.post("/agent/report", json=run_input("hi")))
        options = claude.created[0].options
        assert options.tools == ["Skill", "Bash"]
        assert "Bash" in options.allowed_tools
        assert options.env["ANTHROPIC_API_KEY"].startswith("sk-ant-run-")
        assert options.env["DATABASE_URL"] == ""
        assert options.sandbox["failIfUnavailable"] is True
        assert options.sandbox["filesystem"]["allowRead"] == [options.cwd]
        # The stand-in reaches the proxy, which refuses any other key.
        base = options.env["ANTHROPIC_BASE_URL"]
        assert httpx.post(f"{base}/v1/messages", headers={"x-api-key": "nope"}).status_code == 401
        # Skill settings still keep `!` commands in SKILL.md off.
        assert json.loads(options.settings)["disableSkillShellExecution"] is True


def test_no_bash_with_scripts_off_or_no_scripted_skill(claude, tmp_path):
    for env, server in (
        ({"AUTH_MODE": "local", "AGENT_PY_WORKDIR": str(tmp_path)}, scripted_server()),
        (
            {"AUTH_MODE": "local", "AGENT_PY_WORKDIR": str(tmp_path), "SKILL_SCRIPTS": "on"},
            AgentServer(),
        ),
    ):
        claude.created = []
        adapter = make_adapter(env, transport=httpx.MockTransport(server.handle))
        with TestClient(create_app(env=env, adapter=adapter)) as c:
            events(c.post("/agent/report", json=run_input("hi")))
        options = claude.created[0].options
        assert options.tools == ["Skill"] and options.sandbox is None
        assert "ANTHROPIC_API_KEY" not in (options.env or {})
        assert adapter._key_proxy is None  # never started
