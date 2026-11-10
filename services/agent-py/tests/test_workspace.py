"""The workspace tools against a fake storage API (httpx.MockTransport).

They were also run against the real agent server (with and without login);
these pin the requests they make and what Claude gets back.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any

import httpx
import pytest
from agent_py.text import EditError, apply_edit, read_lines
from agent_py.workspace import Storage, file_route, file_tools, format_tree

NODE = "6d0e0000-0000-0000-0000-000000000001"


class FakeStorage:
    """Answers the storage API's routes from a dict of files; records each request."""

    def __init__(self) -> None:
        self.files: dict[str, tuple[bytes, str]] = {}
        self.requests: list[httpx.Request] = []
        self.proposals: list[dict[str, Any]] = []

    def handle(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        path = request.url.path
        if path == "/access":
            return httpx.Response(200, json={"me": {"id": "u1"}, "rootRole": "owner"})
        if path == "/proposals" and request.method == "GET":
            return httpx.Response(200, json={"proposals": self.proposals})
        if path.startswith("/proposals/") and path.endswith("/content"):
            return httpx.Response(200, content=b"RF 40 W\n", headers={"content-type": "text/markdown"})
        if path.startswith("/files/"):
            name = path[len("/files/") :]
            if request.method == "PUT":
                if "propose" in request.url.params:
                    return httpx.Response(201, json={"path": name, "node": request.url.params.get("node"), "isNew": True})
                self.files[name] = (request.content, "text/markdown")
                return httpx.Response(200, json={"path": name})
            if name not in self.files:
                return httpx.Response(404, json={"error": "File not found"})
            data, mime = self.files[name]
            if mime == "image/png":
                return httpx.Response(302, headers={"location": "https://s3.example/x.png"})
            return httpx.Response(200, content=data, headers={"content-type": mime})
        return httpx.Response(500, json={"error": f"unexpected {request.method} {path}"})


@pytest.fixture
def api() -> FakeStorage:
    return FakeStorage()


def tools_for(api: FakeStorage, token: str | None = "tok") -> dict[str, Any]:
    storage = Storage("http://storage.test", token, transport=httpx.MockTransport(api.handle))
    return {t.name: t for t in file_tools(lambda: storage)}


def call(api: FakeStorage, name: str, token: str | None = "tok", **args: Any) -> tuple[str, bool]:
    result = asyncio.run(tools_for(api, token)[name].handler(args))
    return "\n".join(c["text"] for c in result["content"]), bool(result.get("is_error"))


def test_the_tools_have_the_typescript_agents_names(api):
    assert sorted(tools_for(api)) == sorted(
        [
            "list_nodes",
            "create_node",
            "list_files",
            "read_file",
            "search_files",
            "write_file",
            "edit_file",
            "list_experiments",
            "update_experiment",
            "propose_experiment",
        ]
    )


def test_each_call_carries_the_runs_storage_token(api):
    call(api, "write_file", path="notes/a.md", content="hi")
    assert api.requests[-1].headers["x-knowledge-storage"] == "tok"
    call(api, "write_file", token=None, path="notes/a.md", content="hi")
    assert "x-knowledge-storage" not in api.requests[-1].headers


def test_writes_at_the_root_and_in_an_experiment_change_the_file(api):
    out, failed = call(api, "write_file", path="notes/a.md", content="hello")
    assert not failed and json.loads(out)["ok"] and "proposed" not in out
    call(api, "write_file", path="artifacts/r.md", content="x", node=NODE, experiment="e1")
    request = api.requests[-1]
    assert dict(request.url.params) == {"experiment": "e1"}  # the experiment's, never its node's


def test_writes_in_a_node_and_to_skills_are_proposals(api):
    out, _ = call(api, "write_file", path="notes/r.md", content="x", node=NODE, summary="why")
    assert json.loads(out)["proposed"] is True and "this node" in out
    assert dict(api.requests[-1].url.params) == {"node": NODE, "propose": "", "note": "why"}
    out, _ = call(api, "write_file", path="skills/demo/SKILL.md", content="x")
    assert "the workspace" in out and "propose" in api.requests[-1].url.params


def test_read_file_numbers_lines_and_pages(api):
    api.files["notes/a.md"] = (b"one\ntwo\nthree", "text/markdown")
    assert call(api, "read_file", path="notes/a.md") == ("notes/a.md\n1\tone\n2\ttwo\n3\tthree", False)
    out, _ = call(api, "read_file", path="notes/a.md", offset=2, limit=1)
    assert out == "notes/a.md (lines 2-2 of 3; continue with offset 3)\n2\ttwo"


def test_read_file_names_missing_and_binary_files(api):
    assert call(api, "read_file", path="nope.md") == ("No file at nope.md", True)
    api.files["img/a.png"] = (b"", "image/png")
    out, failed = call(api, "read_file", path="img/a.png")
    assert not failed and "Binary file" in out


def test_edit_file_changes_part_of_a_file(api):
    api.files["notes/a.md"] = (b"one\ntwo\nthree\n", "text/markdown")
    out, failed = call(api, "edit_file", path="notes/a.md", oldText="two", newText="2")
    assert not failed
    assert api.files["notes/a.md"][0] == b"one\n2\nthree\n"
    assert "1 replacement" in out and "2\t2" in out


def test_edit_file_builds_on_claudes_own_open_proposal(api):
    api.proposals = [
        {"id": "p1", "path": "notes/r.md", "author": "agent", "authorId": "u1", "status": "open"},
    ]
    out, failed = call(api, "edit_file", path="notes/r.md", oldText="40 W", newText="45 W", node=NODE)
    assert not failed and "RF 45 W" in out
    assert api.requests[-1].content == b"RF 45 W\n"
    assert "propose" in api.requests[-1].url.params


def test_edit_file_errors_reach_claude(api):
    assert call(api, "edit_file", path="nope.md", oldText="a", newText="b") == (
        "No file at nope.md. Use write_file to create it.",
        True,
    )
    api.files["notes/a.md"] = (b"x x", "text/markdown")
    out, failed = call(api, "edit_file", path="notes/a.md", oldText="x", newText="y")
    assert failed and "occurs 2 times" in out


def test_storage_refusals_and_outages_reach_claude():
    refuse = Storage("http://storage.test", "tok", transport=httpx.MockTransport(lambda r: httpx.Response(403, json={"error": "No"})))
    down = Storage("http://storage.test", "tok", transport=httpx.MockTransport(lambda r: (_ for _ in ()).throw(httpx.ConnectError("refused"))))
    for storage, expected in ((refuse, "No"), (down, "unavailable")):
        tool = {t.name: t for t in file_tools(lambda s=storage: s)}["list_nodes"]
        result = asyncio.run(tool.handler({}))
        assert result["is_error"] and expected in result["content"][0]["text"]


def test_file_routes_encode_each_segment():
    assert file_route("/notes/a b#1.md") == "/files/notes/a%20b%231.md"


def test_format_tree():
    nodes = [
        {"id": "a", "parentId": None, "name": "Etch", "type": "tech", "fileCount": 1, "role": "editor"},
        {"id": "b", "parentId": "a", "name": "M3", "type": "module", "fileCount": 0, "role": None},
    ]
    assert format_tree(nodes) == "- Etch [tech] id=a (1 file, editor)\n  - M3 [module] id=b (no access, shown as a path)"


def test_read_lines_cuts_long_lines():
    out = read_lines("a.txt", "x" * 10, max_chars=4)
    assert out == "a.txt (lines 1-1 of 1; line 1 cut before column 5; continue with offset 1 column 5)\n1\txxxx"


def test_apply_edit_keeps_crlf_and_reports_lines():
    edit = apply_edit("a\r\nb\r\nc", "b\nc", "B\nC")
    assert edit.content == "a\r\nB\r\nC" and edit.lines == (2, 3)
    with pytest.raises(EditError, match="line numbers"):
        apply_edit("abc", "1\tabc", "x")
