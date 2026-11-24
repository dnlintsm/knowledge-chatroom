"""The working folder: a read-only copy of the user's workspace for Read/Glob/Grep."""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import stat
import urllib.parse
from pathlib import Path
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient
from test_skills import events, run_input

from agent_py.app import create_app, make_adapter
from agent_py.workdir import (
    Limits,
    clear_workdir,
    confine_hook,
    folder_name,
    sync_workdir,
    workdir_prompt,
)
from agent_py.workspace import Storage, file_tools

NODES = [
    {"id": "n1aaaaaaaa", "parentId": None, "name": "Etch", "role": "editor"},
    {"id": "n2bbbbbbbb", "parentId": "n1aaaaaaaa", "name": "Module 3", "role": "viewer"},
    # Shown only because something below it is visible: no role, so no files.
    {"id": "n3cccccccc", "parentId": None, "name": "Litho", "role": None},
    {"id": "n4dddddddd", "parentId": "n3cccccccc", "name": "Resist", "role": "viewer"},
    {"id": "n5eeeeeeee", "parentId": "n3cccccccc", "name": "resist", "role": "viewer"},
]


class StorageAPI:
    """GET /nodes, /experiments, /files and /files/<path>, with one binary file behind a store link."""

    def __init__(self) -> None:
        self.requests: list[httpx.Request] = []
        self.places: dict[str, dict[str, bytes]] = {
            "root": {"notes/welcome.md": b"# Welcome\n", "uploads/map.png": b"\x89PNG..."},
            "n1aaaaaaaa": {"etch.md": b"etch", "Module 3/clash.md": b"clash"},
            "n2bbbbbbbb": {"m3.md": b"m3"},
            "n3cccccccc": {"hidden.md": b"never listed"},
            "n4dddddddd": {"a.md": b"a"},
            "n5eeeeeeee": {"b.md": b"b"},
            "e1ffffffff": {"report.md": b"report", "inputs/data.csv": b"x,y\n1,2\n"},
        }
        self.down = False
        self.puts: list[httpx.Request] = []

    def place(self, request: httpx.Request) -> str:
        params = request.url.params
        return params.get("experiment") or params.get("node") or "root"

    def handle(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        path = request.url.path
        if request.url.host == "store.test":
            assert "x-knowledge-storage" not in request.headers  # the link goes without the token
            return httpx.Response(200, content=self.places["root"]["uploads/map.png"])
        if self.down:
            return httpx.Response(503, json={"error": "Storage is not available"})
        if path == "/nodes":
            return httpx.Response(200, json={"types": [], "rootRole": "owner", "nodes": NODES})
        if path == "/experiments":
            experiment = {"id": "e1ffffffff", "title": "Run / A", "access": "writer"}
            return httpx.Response(200, json={"experiments": [experiment]})
        if path == "/files":
            files = self.places[self.place(request)]
            return httpx.Response(
                200,
                json={
                    "files": [
                        {"path": p, "size": len(b), "sha256": hashlib.sha256(b).hexdigest()}
                        for p, b in files.items()
                    ]
                },
            )
        if path.startswith("/files/") and request.method == "GET":
            name = urllib.parse.unquote(path.removeprefix("/files/"))
            data = self.places[self.place(request)].get(name)
            if data is None:
                return httpx.Response(404, json={"error": "Not found"})
            if name.endswith(".png"):
                return httpx.Response(302, headers={"Location": "http://store.test/blob?sig=1"})
            return httpx.Response(200, content=data)
        if path.startswith("/files/") and request.method == "PUT":
            self.puts.append(request)
            name = urllib.parse.unquote(path.removeprefix("/files/"))
            return httpx.Response(200, json={"path": name})
        if path == "/experiments/runs":
            run = {
                "id": "e1ffffffff",
                "title": "Run / A",
                "state": "running",
                "fileCount": 2,
                "provenance": {"inputs": [{"path": "inputs/data.csv"}]},
            }
            return httpx.Response(201, json=run)
        if path == "/skills/run":
            return httpx.Response(200, json={"skills": []})
        return httpx.Response(500, json={"error": f"unexpected {request.method} {path}"})

    def gets(self) -> list[str]:
        return [
            urllib.parse.unquote(r.url.path)
            for r in self.requests
            if r.method == "GET" and r.url.path.startswith("/files/")
        ]


@pytest.fixture
def api() -> StorageAPI:
    return StorageAPI()


def storage(api: StorageAPI, token: str | None = "tok") -> Storage:
    return Storage("http://agent.test", token, httpx.MockTransport(api.handle))


def tree(folder: Path) -> list[str]:
    return sorted(str(p.relative_to(folder)) for p in folder.rglob("*") if p.is_file())


def test_folder_names_are_one_safe_segment():
    assert folder_name("a/b\\c") == "a-b-c"
    assert folder_name("..hidden") == "hidden"
    assert folder_name("  ") == "untitled"


def test_the_copy_holds_every_place_the_user_can_read(api, tmp_path: Path):
    summary = asyncio.run(sync_workdir(storage(api), tmp_path))
    root = tmp_path / "workspace"
    assert tree(root) == [
        ".places.json",
        "experiments/Run - A (e1ffffff)/inputs/data.csv",
        "experiments/Run - A (e1ffffff)/report.md",
        "nodes/Etch/Module 3/m3.md",
        "nodes/Etch/etch.md",
        "nodes/Litho/Resist (n4dddddd)/a.md",  # siblings of the same name, told apart
        "nodes/Litho/resist (n5eeeeee)/b.md",
        "root/notes/welcome.md",
        "root/uploads/map.png",
    ]
    assert (root / "root/uploads/map.png").read_bytes() == b"\x89PNG..."  # through the store link
    assert not stat.S_IMODE((root / "nodes/Etch/etch.md").stat().st_mode) & 0o222  # read-only
    places = json.loads((root / ".places.json").read_text())
    assert places["places"][:3] == [
        {"folder": "workspace/root", "root": True, "role": "owner"},
        {"folder": "workspace/nodes/Etch", "node": "n1aaaaaaaa", "role": "editor"},
        {"folder": "workspace/nodes/Etch/Module 3", "node": "n2bbbbbbbb", "role": "viewer"},
    ]
    assert places["places"][-1] == {
        "folder": "workspace/experiments/Run - A (e1ffffff)",
        "experiment": "e1ffffffff",
        "role": "writer",
    }
    assert places["skipped"] == [
        {"path": "nodes/Etch/Module 3/clash.md", "reason": "a child node has this name"}
    ]
    assert summary.files == 8 and summary.dir == root
    assert all(
        r.headers["x-knowledge-storage"] == "tok"
        for r in api.requests
        if r.url.host != "store.test"
    )


def test_a_sync_downloads_only_what_changed_and_removes_what_went(api, tmp_path: Path):
    asyncio.run(sync_workdir(storage(api), tmp_path))
    root = tmp_path / "workspace"
    stray = root / "root" / "stray.txt"
    stray.write_text("not from the workspace")
    api.places["root"]["notes/welcome.md"] = b"# Welcome back\n"
    del api.places["n1aaaaaaaa"]["etch.md"]
    api.requests.clear()
    asyncio.run(sync_workdir(storage(api), tmp_path))
    assert api.gets() == ["/files/notes/welcome.md"]
    assert (root / "root/notes/welcome.md").read_bytes() == b"# Welcome back\n"
    assert not (root / "nodes/Etch/etch.md").exists() and not stray.exists()


def test_files_over_the_limits_are_left_out(api, tmp_path: Path):
    api.places["root"]["big.bin"] = b"x" * 3000
    summary = asyncio.run(
        sync_workdir(storage(api), tmp_path, Limits(max_bytes=20, max_file_bytes=2000))
    )
    reasons = {s["path"]: s["reason"] for s in summary.skipped}
    assert reasons["root/big.bin"].startswith("larger than")
    assert any(r.startswith("the folder is full") for r in reasons.values())
    assert summary.bytes <= 20


def test_clearing_removes_the_copy(api, tmp_path: Path):
    asyncio.run(sync_workdir(storage(api), tmp_path))
    (tmp_path / "keep.txt").write_text("a script's output")
    asyncio.run(clear_workdir(tmp_path))
    assert tree(tmp_path) == ["keep.txt"]


def hook_answer(cwd: Path, name: str, args: dict[str, Any]) -> dict[str, Any]:
    (hook,) = confine_hook(cwd).hooks
    return asyncio.run(hook({"tool_name": name, "tool_input": args}, "tu1", None))


def denied(answer: dict[str, Any]) -> bool:
    return answer.get("hookSpecificOutput", {}).get("permissionDecision") == "deny"


def test_read_glob_and_grep_stay_in_the_run_folder(tmp_path: Path):
    cwd = tmp_path / "run"
    (cwd / "workspace").mkdir(parents=True)
    os.symlink("/etc", cwd / "escape")
    assert confine_hook(cwd).matcher == "Read|Glob|Grep"
    assert not denied(hook_answer(cwd, "Read", {"file_path": "workspace/root/a.md"}))
    assert not denied(hook_answer(cwd, "Read", {"file_path": str(cwd / "workspace/x")}))
    assert denied(hook_answer(cwd, "Read", {"file_path": "/etc/passwd"}))
    assert denied(hook_answer(cwd, "Read", {"file_path": "../other/secret"}))
    assert denied(hook_answer(cwd, "Read", {"file_path": "escape/passwd"}))  # links are followed
    assert denied(hook_answer(cwd, "Read", {}))
    assert not denied(hook_answer(cwd, "Glob", {"pattern": "workspace/**/*.md"}))
    assert denied(hook_answer(cwd, "Glob", {"pattern": "../**"}))
    assert denied(hook_answer(cwd, "Glob", {"pattern": "/etc/*"}))
    assert denied(hook_answer(cwd, "Glob", {"pattern": "*.md", "path": "/home"}))
    # Grep's pattern is a regex, not a path.
    assert not denied(hook_answer(cwd, "Grep", {"pattern": "/etc/../x", "path": "workspace"}))
    assert denied(hook_answer(cwd, "Grep", {"pattern": "x", "glob": "../*.md"}))


def tool(tools, name: str):
    return next(t for t in tools if t.name == name)


def test_save_file_stores_a_file_from_the_folder(api, tmp_path: Path):
    (tmp_path / "out").mkdir()
    (tmp_path / "out" / "plot.png").write_bytes(b"png bytes")
    (tmp_path / ".claude" / "skills").mkdir(parents=True)
    (tmp_path / ".claude" / "skills" / "x.md").write_text("skill")
    tools = file_tools(lambda: storage(api), {}, tmp_path)
    save = tool(tools, "save_file")
    done = asyncio.run(save.handler({"from": "out/plot.png", "path": "artifacts/plot.png"}))
    assert not done.get("is_error"), done
    (put,) = api.puts
    assert (
        urllib.parse.unquote(put.url.path) == "/files/artifacts/plot.png"
        and put.content == b"png bytes"
    )
    for given, message in (
        ("../outside.txt", "is not in the working folder"),
        (".claude/skills/x.md", "Skills can't be saved"),
        ("out/missing.png", "No file at out/missing.png"),
    ):
        refused = asyncio.run(save.handler({"from": given, "path": "artifacts/x"}))
        assert refused["is_error"] and message in refused["content"][0]["text"], given
    assert "save_file" not in [t.name for t in file_tools(lambda: storage(api), {})]


def test_save_file_with_a_relative_working_folder(api, tmp_path: Path, monkeypatch):
    # AGENT_PY_WORKDIR=runs gives a relative folder: its files still count as inside.
    monkeypatch.chdir(tmp_path)
    folder = Path("runs") / "h"
    (folder / "out").mkdir(parents=True)
    (folder / "out" / "plot.png").write_bytes(b"png bytes")
    (folder / ".claude").mkdir()
    save = tool(file_tools(lambda: storage(api), {}, folder), "save_file")
    done = asyncio.run(save.handler({"from": "out/plot.png", "path": "artifacts/plot.png"}))
    assert not done.get("is_error"), done
    assert api.puts[0].content == b"png bytes"


def test_a_run_claude_starts_gets_its_inputs_in_the_folder(api, tmp_path: Path):
    tools = file_tools(lambda: storage(api), {}, tmp_path)
    answer = asyncio.run(
        tool(tools, "create_experiment").handler(
            {"title": "Run / A", "inputs": [{"path": "uploads/data.csv"}]}
        )
    )
    result = json.loads(answer["content"][0]["text"])
    assert result["inputsInWorkingFolder"] == {"inputs/data.csv": "run-inputs/e1ffffffff/data.csv"}
    assert (tmp_path / "run-inputs/e1ffffffff/data.csv").read_bytes() == b"x,y\n1,2\n"
    # Without a folder, nothing is copied.
    plain = file_tools(lambda: storage(api), {})
    result = json.loads(
        asyncio.run(tool(plain, "create_experiment").handler({"title": "B"}))["content"][0]["text"]
    )
    assert "inputsInWorkingFolder" not in result


def test_run_inputs_never_land_outside_the_folder(api, tmp_path: Path):
    # A script pointed run-inputs (or a folder in it) elsewhere: nothing is written there.
    cwd, outside = tmp_path / "run", tmp_path / "outside"
    cwd.mkdir()
    outside.mkdir()
    create = tool(file_tools(lambda: storage(api), {}, cwd), "create_experiment")
    for link in (cwd / "run-inputs", cwd / "run-inputs" / "e1ffffffff"):
        link.parent.mkdir(exist_ok=True)
        link.symlink_to(outside, target_is_directory=True)
        answer = asyncio.run(
            create.handler({"title": "A", "inputs": [{"path": "uploads/data.csv"}]})
        )
        assert "inputsInWorkingFolder" not in json.loads(answer["content"][0]["text"])
        assert list(outside.iterdir()) == []
        link.unlink()
    # Each turn's copy starts it again as a real folder.
    (cwd / "run-inputs").rmdir()
    (cwd / "run-inputs").symlink_to(outside, target_is_directory=True)
    asyncio.run(sync_workdir(storage(api), cwd))
    assert (cwd / "run-inputs").is_dir() and not (cwd / "run-inputs").is_symlink()


def test_the_prompt_describes_the_folder():
    from agent_py.workdir import Summary

    summary = Summary(Path("/runs/x/workspace"), files=3)
    assert "It has 3 files" in workdir_prompt(summary, scripts=False)
    assert "save_file" not in workdir_prompt(summary, scripts=False)
    assert "save_file" in workdir_prompt(summary, scripts=True)


def run_once(api: StorageAPI, env: dict[str, str], claude, headers: dict[str, str] | None = None):
    adapter = make_adapter(env, transport=httpx.MockTransport(api.handle))
    with TestClient(create_app(env=env, adapter=adapter)) as c:
        events(c.post("/agent/report", json=run_input("hi"), headers=headers or {}))
    return claude.created[-1].options


def test_a_run_reads_its_copy_with_confined_tools(api, claude, tmp_path: Path):
    options = run_once(api, {"AUTH_MODE": "local", "AGENT_PY_WORKDIR": str(tmp_path)}, claude)
    cwd = Path(options.cwd)
    assert (cwd / "workspace/root/notes/welcome.md").read_bytes() == b"# Welcome\n"
    assert options.tools == ["Read", "Glob", "Grep"]
    assert {"Read", "Glob", "Grep", "mcp__copilotkit__save_file"} <= set(options.allowed_tools)
    assert "Working folder: the current directory holds workspace/" in options.system_prompt
    assert any(m.matcher == "Read|Glob|Grep" for m in options.hooks["PreToolUse"])


def test_without_a_copy_the_old_one_goes_and_the_tools_too(api, claude, tmp_path: Path):
    env = {"AUTH_MODE": "local", "AGENT_PY_WORKDIR": str(tmp_path)}
    cwd = Path(run_once(api, env, claude).cwd)
    assert (cwd / "workspace").is_dir()
    for off, down in (({"AGENT_WORKDIR": "off"}, False), ({}, True)):
        api.down = down
        options = run_once(api, {**env, **off}, claude)
        assert Path(options.cwd) == cwd and not (cwd / "workspace").exists()
        assert options.tools == [] and "Working folder" not in options.system_prompt
        assert "mcp__copilotkit__save_file" not in options.allowed_tools
        run_once(api, env, claude) if not down else None  # make a copy again for the next case


def test_each_workspace_has_its_own_folder(api, claude, tmp_path: Path):
    env = {"AUTH_MODE": "local", "AGENT_PY_WORKDIR": str(tmp_path)}
    default = Path(run_once(api, env, claude).cwd)
    other = Path(run_once(api, env, claude, {"X-Knowledge-Workspace": "w2"}).cwd)
    assert default != other and default.parent == other.parent == tmp_path


def test_run_folders_nobody_used_for_a_while_are_removed(tmp_path):
    """A run folder holds a copy of what its user could read; it used to stay on disk for good."""
    import os

    from agent_py.skills import run_folder
    from agent_py.workdir import LAST_USED, mark_used, remove_idle

    day = 24 * 3600.0
    now = 1_800_000_000.0

    def folder(user: str, used_ago: float | None) -> Path:
        cwd = run_folder(tmp_path, user)
        mark_used(cwd)
        (cwd / "workspace").mkdir()
        (cwd / "workspace" / "notes.md").write_text("what they could read")
        if used_ago is None:
            (cwd / LAST_USED).unlink()
        else:
            os.utime(cwd / LAST_USED, (now - used_ago, now - used_ago))
        return cwd

    idle = folder("alice", 2 * day)
    recent = folder("bob", 3600)
    busy = folder("carol", 9 * day)  # idle by the clock, but a run is in it
    unmarked = folder("dave", None)  # from before folders were marked
    (tmp_path / "notes.txt").write_text("not a run folder")
    (tmp_path / "other").mkdir()
    leftover = tmp_path / ".removing-abc"
    (leftover / "workspace").mkdir(parents=True)

    assert asyncio.run(remove_idle(tmp_path, day, {busy}, now=now)) == 1
    assert not idle.exists() and not leftover.exists()
    assert (recent / "workspace" / "notes.md").exists()
    assert (busy / "workspace" / "notes.md").exists()
    # Kept this time and marked: it goes after the same wait as any other.
    assert (unmarked / LAST_USED).exists()
    assert (tmp_path / "notes.txt").exists() and (tmp_path / "other").is_dir()
    assert sorted(p.name for p in tmp_path.iterdir() if p.name.startswith(".removing-")) == []

    os.utime(unmarked / LAST_USED, (now - 2 * day, now - 2 * day))
    assert asyncio.run(remove_idle(tmp_path, day, set(), now=now)) == 2  # dave's and carol's
    assert sorted(p.name for p in tmp_path.iterdir()) == sorted([recent.name, "notes.txt", "other"])
    # A root that is gone is nothing to remove, not an error.
    assert asyncio.run(remove_idle(tmp_path / "missing", day, set(), now=now)) == 0


def test_the_idle_setting_has_a_floor_and_can_be_turned_off():
    from agent_py.workdir import idle_seconds_from_env

    assert idle_seconds_from_env({}) == 24 * 3600
    assert idle_seconds_from_env({"AGENT_WORKDIR_IDLE_HOURS": "72"}) == 72 * 3600
    # Never sooner than a Claude Code session idles out.
    assert idle_seconds_from_env({"AGENT_WORKDIR_IDLE_HOURS": "0.1"}) == 3600
    for off in ("0", "off", " OFF "):
        assert idle_seconds_from_env({"AGENT_WORKDIR_IDLE_HOURS": off}) is None
    for bad in ("soon", "-3", "nan"):
        assert idle_seconds_from_env({"AGENT_WORKDIR_IDLE_HOURS": bad}) == 24 * 3600
