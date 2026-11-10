"""The run's skills: fetched from the agent server, written to the user's folder, used."""

from __future__ import annotations

import asyncio
import base64
import json
import time
from pathlib import Path
from typing import Any

import claude_agent_sdk
import httpx
import pytest
from agent_py.app import create_app, make_adapter
from agent_py.skills import RunSkill, fetch_skills, materialize, slash_command
from agent_py.workspace import Storage
from conftest import FakeClaude
from fastapi.testclient import TestClient

SKILL_MD = b"---\nname: demo\ndescription: A demo skill\n---\n\nSay demo.\n"


def b64(data: bytes) -> str:
    return base64.b64encode(data).decode()


class AgentServer:
    """GET /skills/run and POST /skills/used, recording each request."""

    def __init__(self) -> None:
        self.requests: list[httpx.Request] = []
        self.skills: list[dict[str, Any]] = [
            {
                "name": "demo",
                "mode": "auto",
                "source": "workspace",
                "userInvocable": True,
                "needsExecution": False,
                "files": [{"path": "SKILL.md", "content": b64(SKILL_MD)}],
            },
            {"name": "quiet", "mode": "auto", "source": "builtin", "userInvocable": False, "needsExecution": False, "files": []},
            {"name": "later", "mode": "manual", "source": "hub", "userInvocable": True, "needsExecution": False, "files": []},
        ]

    def handle(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if request.url.path == "/skills/run":
            return httpx.Response(200, json={"skills": self.skills})
        if request.url.path == "/skills/used":
            return httpx.Response(200, json=json.loads(request.content))
        return httpx.Response(500, json={"error": f"unexpected {request.method} {request.url.path}"})

    def uses(self) -> list[dict[str, Any]]:
        return [json.loads(r.content) for r in self.requests if r.url.path == "/skills/used"]


@pytest.fixture
def agent_server() -> AgentServer:
    return AgentServer()


@pytest.fixture
def client(claude, agent_server, tmp_path):
    env = {"AGENT_PY_WORKDIR": str(tmp_path)}
    adapter = make_adapter(env, transport=httpx.MockTransport(agent_server.handle))
    with TestClient(create_app(env=env, adapter=adapter)) as c:
        yield c


def run_input(text: str, thread: str = "t1", context: list[dict[str, str]] | None = None) -> dict[str, Any]:
    return {
        "threadId": thread,
        "runId": f"r-{time.monotonic_ns()}",
        "state": {},
        "messages": [{"id": "m1", "role": "user", "content": text}],
        "tools": [],
        "context": context or [],
        "forwardedProps": {"knowledge_chatroom": {"version": 2, "user": {"id": "local"}, "storage": "server"}},
    }


def events(response) -> list[dict[str, Any]]:
    assert response.status_code == 200, response.text
    return [json.loads(line[6:]) for line in response.text.splitlines() if line.startswith("data: ")]


def wait_for(check, seconds: float = 2.0):
    deadline = time.monotonic() + seconds
    while not (result := check()) and time.monotonic() < deadline:
        time.sleep(0.01)
    return result


def test_fetch_skills_asks_for_the_chats_skills_with_the_runs_token(agent_server):
    agent_server.skills.append({"name": "../evil", "mode": "auto", "source": "hub", "files": []})
    agent_server.skills.append({"name": "off-one", "mode": "off", "source": "hub", "files": []})
    storage = Storage("http://agent.test", "tok", httpx.MockTransport(agent_server.handle))
    skills = asyncio.run(fetch_skills(storage, "t1"))
    assert [s.name for s in skills] == ["demo", "quiet", "later"]  # bad names and off ones are left out
    assert skills[0].files == (("SKILL.md", SKILL_MD),)
    request = agent_server.requests[-1]
    assert dict(request.url.params) == {"thread": "t1"} and request.headers["x-knowledge-storage"] == "tok"


def test_materialize_writes_each_users_skills_once_per_set(tmp_path: Path):
    demo = RunSkill("demo", "auto", "workspace", files=(("SKILL.md", b"v1"), ("ref/a.md", b"a"), ("../../x", b"no")))
    cwd = materialize(tmp_path, "alice", [demo])
    skills = cwd / ".claude" / "skills"
    assert (skills / "demo" / "SKILL.md").read_bytes() == b"v1"
    assert (skills / "demo" / "ref" / "a.md").read_bytes() == b"a"
    assert not (tmp_path / "x").exists() and not (cwd / ".claude" / "x").exists()
    marker = (skills / ".fingerprint").stat().st_mtime_ns
    assert materialize(tmp_path, "alice", [demo]) == cwd
    assert (skills / ".fingerprint").stat().st_mtime_ns == marker  # unchanged set: not written again
    other = RunSkill("other", "manual", "hub", files=(("SKILL.md", b"o"),))
    assert materialize(tmp_path, "alice", [other]) == cwd
    assert sorted(p.name for p in skills.iterdir()) == [".fingerprint", "other"]
    assert sorted(p.name for p in (cwd / ".claude").iterdir()) == ["skills"]  # nothing left over
    assert materialize(tmp_path, "bob", []) != cwd


def test_only_slash_commands_for_the_runs_own_skills_stay_commands():
    skills = [RunSkill("demo", "auto", "workspace"), RunSkill("quiet", "auto", "builtin", user_invocable=False)]
    assert slash_command("/demo now", skills) == ("/demo now", skills[0])
    assert slash_command("/clear", skills) == (" /clear", None)
    assert slash_command("/quiet", skills) == (" /quiet", None)  # user-invocable: false
    assert slash_command("a /demo", skills) == ("a /demo", None)


def test_the_session_gets_the_runs_skills_in_the_users_folder(client, claude, agent_server):
    events(client.post("/agent/report", json=run_input("hi")))
    options = claude.created[0].options
    assert options.skills == ["demo", "quiet", "later"]
    assert options.tools == ["Skill"]
    assert options.setting_sources == ["project"]
    assert json.loads(options.settings) == {
        "skillOverrides": {"demo": "on", "quiet": "on", "later": "user-invocable-only"},
        "disableSkillShellExecution": True,
    }
    assert (Path(options.cwd) / ".claude" / "skills" / "demo" / "SKILL.md").read_bytes() == SKILL_MD
    assert any(m.matcher == "Skill" for m in options.hooks["PreToolUse"])


def test_a_slash_command_stays_first_and_is_reported(client, claude, agent_server):
    context = [{"description": "openFile", "value": '{"path": "notes/a.md", "content": "1\\thello"}'}]
    evts = events(client.post("/agent/report", json=run_input("/demo go", context=context)))
    (prompt,) = claude.created[0].prompts
    assert prompt.startswith("/demo go\n\n<workspace>")  # its note goes after it
    used = [e for e in evts if e.get("name") == "skill_used"]
    assert used == [{"type": "CUSTOM", "name": "skill_used", "value": {"skill": "demo", "source": "workspace", "trigger": "slash"}}]
    assert evts.index(used[0]) == 1  # right after RUN_STARTED
    assert wait_for(agent_server.uses) == [{"thread": "t1", "skill": "demo", "trigger": "slash"}]


def test_other_slash_commands_go_as_text(client, claude):
    events(client.post("/agent/report", json=run_input("/clear")))
    assert claude.created[0].prompts == [" /clear"]


class SkillPickingClaude(FakeClaude):
    """Claude picking the demo skill: the run's Skill hook hears it."""

    async def receive_response(self):
        for matcher in self.options.hooks["PreToolUse"]:
            if matcher.matcher == "Skill":
                for hook in matcher.hooks:
                    await hook({"tool_name": "Skill", "tool_input": {"skill": "demo"}}, "tu1", None)
        async for message in super().receive_response():
            yield message


def test_a_skill_claude_picks_is_reported(client, claude, agent_server, monkeypatch):
    monkeypatch.setattr(claude_agent_sdk, "ClaudeSDKClient", SkillPickingClaude)
    evts = events(client.post("/agent/report", json=run_input("do the demo thing")))
    used = [e["value"] for e in evts if e.get("name") == "skill_used"]
    assert used == [{"skill": "demo", "source": "workspace", "trigger": "model"}]
    assert wait_for(agent_server.uses) == [{"thread": "t1", "skill": "demo", "trigger": "model"}]


def test_without_the_agent_server_the_run_goes_on_without_skills(claude, tmp_path):
    env = {"AGENT_PY_WORKDIR": str(tmp_path)}
    down = httpx.MockTransport(lambda r: httpx.Response(503, json={"error": "Storage is not available"}))
    with TestClient(create_app(env=env, adapter=make_adapter(env, transport=down))) as c:
        evts = events(c.post("/agent/report", json=run_input("/demo")))
    assert evts[-1]["type"] == "RUN_FINISHED"
    options = claude.created[0].options
    assert options.tools == [] and not options.skills
    assert claude.created[0].prompts == [" /demo"]
