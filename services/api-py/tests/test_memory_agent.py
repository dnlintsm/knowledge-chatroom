"""/memory/agent served by api-py for a remote backend's run (memory_agent.py), against a real, migrated Postgres.

Mirrors apps/agent/src/storage/memory-agent.test.ts and memory-recall.test.ts:
a run's memory tools through X-Knowledge-Memory tokens `via` "remote", with a
stand-in embedding model. Outside MCP servers' tokens still go to the
TypeScript server.
"""

from __future__ import annotations

import base64
import json
import math
import re
import time
from collections.abc import AsyncIterator

import httpx
import psycopg
import pytest
import support
from support import ALICE, SECRET, URL, Client, user

from api_py import tokens
from api_py.memory_agent import TOOL_SPECS, MemoryRecall, parse_args

pytestmark = [pytest.mark.anyio]
needs_database = pytest.mark.skipif(not URL, reason="TEST_DATABASE_URL is not set")

BOB = user("kc|bob", "Bob")
DROP = object()


def token(**claims) -> dict[str, str]:
    """A run's memory token: Alice's, from a remote backend, for chat t-1."""
    base = {
        "sub": "kc|alice",
        "name": "Alice",
        "email": "alice@example.com",
        "aud": tokens.MEMORY_AUDIENCE,
        "via": "remote",
        "thread": "t-1",
        "node": None,
        "exp": int(time.time()) + 600,
    }
    base.update(claims)
    return {
        tokens.MEMORY_HEADER: tokens.sign({k: v for k, v in base.items() if v is not DROP}, SECRET)
    }


def local_token(**claims) -> dict[str, str]:
    data = json.dumps({"via": "remote", "thread": "t-9", "node": None, **claims}).encode()
    return {tokens.MEMORY_HEADER: "local." + base64.urlsafe_b64encode(data).decode().rstrip("=")}


def note(body: str, description: str, kind: str = "preference") -> dict:
    return {"description": description, "type": kind, "body": body}


CONCEPTS = [
    ["chart", "charts", "plot", "plots", "graph", "axes", "figure", "figures"],
    ["coffee", "tea", "drink"],
    ["etch", "wafer", "line", "process"],
]


class FakeEmbedder:
    """Words that mean the same thing share a dimension: a tiny embedding model."""

    model = "fake-concepts"
    source = "fake-concepts"

    def __init__(self) -> None:
        self.calls = 0

    async def embed(self, texts: list[str], kind: str) -> list[list[float]]:
        self.calls += len(texts)
        out = []
        for text in texts:
            words = re.findall(r"[a-z]+", text.lower())
            v = [sum(1 for w in words if w in c) for c in CONCEPTS] + [0.01]
            norm = math.hypot(*v)
            out.append([x / norm for x in v])
        return out


class FakeSemantic:
    def __init__(self) -> None:
        self.ready = True
        self.embedder = FakeEmbedder()
        self.min_similarity = 0.5

    async def stop(self) -> None:
        pass


def test_arguments_are_read_as_zod_reads_them():
    specs = {t["name"]: t for t in TOOL_SPECS}
    assert [t["name"] for t in TOOL_SPECS] == [
        "memory_view",
        "memory_search",
        "memory_save",
        "memory_edit",
        "memory_delete",
        "chats_search",
        "chats_read",
    ]
    save = specs["memory_save"]
    full = {"name": "a", "description": "d", "type": "profile", "body": "b"}
    assert parse_args(save, {**full, "extra": 1}) == full
    assert parse_args(save, {**full, "scope": "node"}) == {**full, "scope": "node"}
    for bad in (
        {**full, "type": "mood"},
        {**full, "scope": None},
        {"name": "a"},
        {**full, "body": 5},
        [],
        None,
    ):
        assert parse_args(save, bad) is None, bad
    search = specs["chats_search"]
    assert parse_args(search, {"query": "x", "limit": 2.0}) == {"query": "x", "limit": 2}
    for limit in (0, 21, 1.5, True, "2"):
        assert parse_args(search, {"query": "x", "limit": limit}) is None, limit
    assert parse_args(specs["chats_read"], {"id": "c", "offset": -1}) is None


async def test_recall_embeds_each_text_once():
    class Notes:
        def __init__(self, rows):
            self.rows = rows

        async def texts(self, *_args):
            return self.rows

    mine = Notes(
        [
            {
                "name": "plot-style",
                "description": "How they want figures",
                "type": "preference",
                "body": "No titles; units on the axes.",
            },
            {
                "name": "morning",
                "description": "Daily routine",
                "type": "profile",
                "body": "Starts with coffee at 7.",
            },
        ]
    )
    embedder = FakeEmbedder()
    recall = MemoryRecall(embedder, 0.5)
    hits = await recall.search(mine, Notes([]), None, "how should charts look")  # type: ignore[arg-type]
    assert [h["name"] for h in hits] == ["plot-style"] and hits[0]["similarity"] > 0.9
    before = embedder.calls
    await recall.search(mine, Notes([]), None, "what do they drink")  # type: ignore[arg-type]
    assert embedder.calls - before == 1, "only the query is embedded again"
    assert await recall.search(mine, Notes([]), None, "  ") == []  # type: ignore[arg-type]
    # A run with more notes than the cache holds still gets every vector.
    tiny = MemoryRecall(embedder, 0.5, 1)
    hits = await tiny.search(mine, Notes([]), None, "charts")  # type: ignore[arg-type]
    assert [h["name"] for h in hits] == ["plot-style"] and len(tiny.cache) == 1


@pytest.fixture
async def memory_api(database) -> AsyncIterator[tuple[httpx.AsyncClient, object]]:
    async with Client(database, SECRET, memory=True) as (client, app):
        await client.get("/access", headers=ALICE)  # the first to sign in owns the workspace
        await client.put(
            "/memory/notes/reply-style",
            headers=ALICE,
            json=note("Lead with the result.", "Short answers"),
        )
        yield client, app


async def tool(api: httpx.AsyncClient, name: str, args: dict, query: str = "", **claims) -> dict:
    answer = await api.post(
        f"/memory/agent/tools/{name}{query}", headers=token(**claims), json=args
    )
    assert answer.status_code == 200, answer.text
    assert answer.headers["cache-control"] == "no-store"
    return answer.json()


@needs_database
async def test_a_remote_run_gets_claudes_memory_tools(memory_api, database):
    api, _app = memory_api
    got = await api.get("/memory/agent", headers=token())
    assert got.status_code == 200, got.text
    body = got.json()
    assert "- reply-style (preference): Short answers" in body["prompt"]
    assert "with Undo" in body["prompt"]
    assert "chats_search and chats_read" in body["prompt"]
    assert body["tools"] == TOOL_SPECS
    tainted = (await api.get("/memory/agent?tainted=1", headers=token())).json()["prompt"]
    assert "they wait in their Memory inbox" in tainted

    view = await tool(api, "memory_view", {"name": "reply-style"}, "?run=r-1")
    assert "Lead with the result." in view["text"] and "(version 1, updated " in view["text"]
    assert (view["isError"], view["tainted"]) == (False, False)
    assert [(e["kind"], e["name"]) for e in view["events"]] == [("read", "reply-style")]

    # Not tainted, memory on: made directly, with Undo.
    save = await tool(
        api,
        "memory_save",
        {**note("Runs the etch line.", "Process engineer", "profile"), "name": "lab-role"},
        "?run=r-1",
    )
    assert save["text"] == (
        "Saved lab-role (version 1). The user sees the change under your reply and can undo it."
    )
    assert [e["kind"] for e in save["events"]] == ["create"]
    edit = await tool(
        api, "memory_edit", {"name": "lab-role", "old_text": "etch", "new_text": "litho"}
    )
    assert edit["text"].startswith("Edited lab-role (version 2).")
    saved = (await api.get("/memory/notes/lab-role", headers=ALICE)).json()["note"]
    assert (saved["body"], saved["updatedBy"]) == ("Runs the litho line.", "agent")
    async with await psycopg.AsyncConnection.connect(database) as conn:
        cur = await conn.execute("SELECT DISTINCT kind, thread_id, run_id FROM memory_events")
        runs = set(await cur.fetchall())
    # ?run= names the run; without it, the run is the token's via.
    assert runs == {("read", "t-1", "r-1"), ("create", "t-1", "r-1"), ("update", "t-1", "remote")}
    same = await tool(
        api,
        "memory_save",
        {**note("Runs the litho line.", "Process engineer", "profile"), "name": "lab-role"},
    )
    assert same["text"] == "Saved lab-role (version 2). (No change.)" and same["events"] == []

    # Tainted: it waits in the inbox, and the answer says the run is tainted.
    proposed = await tool(api, "memory_delete", {"name": "lab-role"}, "?tainted=true")
    assert "waits in the user's Memory inbox" in proposed["text"]
    assert proposed["tainted"] is True
    assert [(e["kind"], e["version"]) for e in proposed["events"]] == [("propose", 2)]
    inbox = (await api.get("/memory", headers=ALICE)).json()["inbox"]
    assert [(i["op"], i["name"], i["source"], i["threadId"]) for i in inbox] == [
        ("delete", "lab-role", "chat", "t-1")
    ]
    deleted = await tool(api, "memory_delete", {"name": "lab-role"})
    assert deleted["text"].startswith("Deleted lab-role.")
    assert (await api.get("/memory/notes/lab-role", headers=ALICE)).json()["note"]["archived"]

    missing = await tool(api, "memory_view", {"name": "nope"})
    assert (missing["isError"], missing["text"]) == (True, "No memory named nope")
    bad = await tool(api, "memory_edit", {"name": "reply-style", "old_text": "x", "new_text": "y"})
    assert (bad["isError"], bad["text"]) == (
        True,
        "That text isn't in reply-style; view it and copy the text exactly",
    )
    wrong = await api.post("/memory/agent/tools/memory_view", headers=token(), json={"wrong": 1})
    assert (wrong.status_code, wrong.json()) == (
        400,
        {"error": "Invalid arguments for memory_view"},
    )
    junk = await api.post("/memory/agent/tools/memory_view", headers=token(), content=b"{")
    assert junk.status_code == 400
    unknown = await api.post("/memory/agent/tools/rm_rf", headers=token(), json={})
    assert (unknown.status_code, unknown.json()) == (404, {"error": "No memory tool rm_rf"})
    assert (await api.get("/memory/agent/tools", headers=token())).status_code == 404
    assert (await api.put("/memory/agent", headers=token())).status_code == 405
    assert (await api.post("/memory/agent/tools/memory_view/x", headers=token())).status_code == 405


@needs_database
async def test_shared_notes_are_only_proposed(memory_api):
    api, _app = memory_api
    shared = await api.post(
        "/memory/shared",
        headers=ALICE,
        json={
            "scope": "workspace",
            "name": "units",
            **note("nm, not Å.", "Lab units", "reference"),
        },
    )
    note_id = shared.json()["note"]["id"]
    prompt = (await api.get("/memory/agent", headers=token())).json()["prompt"]
    assert f"- shared:{note_id} [Workspace] units (reference): Lab units" in prompt

    view = await tool(api, "memory_view", {"name": f"shared:{note_id}"})
    assert "nm, not Å." in view["text"] and "(shared in Workspace, version 1" in view["text"]
    assert view["tainted"] is True, "someone else's words"
    assert view["events"][0]["shared"] == {"id": note_id, "label": "Workspace"}
    edit = await tool(
        api, "memory_edit", {"name": f"shared:{note_id}", "old_text": "nm", "new_text": "µm"}
    )
    assert edit["text"] == (
        "Proposed a change to units (Workspace): the user can accept or reject it in the "
        "Memory panel. Tell the user in one line."
    )
    proposals = (await api.get("/memory", headers=ALICE)).json()["sharedProposals"]
    assert [(p["op"], p["body"], p["authorType"]) for p in proposals] == [
        ("update", "µm, not Å.", "agent")
    ]
    new = await tool(
        api,
        "memory_save",
        {**note("Mondays.", "Standup day", "reference"), "name": "standup", "scope": "workspace"},
    )
    assert new["text"].startswith("Proposed a new shared note standup (Workspace)")
    no_node = await tool(api, "memory_save", {**note("x", "x"), "name": "x", "scope": "node"})
    assert no_node == {
        "text": "The user isn't in a knowledge node: use scope workspace",
        "isError": True,
        "events": [],
        "tainted": False,
    }
    bad = await tool(api, "memory_view", {"name": "shared:nope"})
    assert bad["text"] == "shared:nope isn't a shared note's name: use shared:<id> from the index"
    gone = await tool(api, "memory_view", {"name": "shared:00000000-0000-0000-0000-000000000000"})
    assert gone["isError"] is True

    found = await tool(api, "memory_search", {"query": "units nm"})
    assert (
        f"- shared:{note_id} [Workspace] units (reference): Lab units\n  nm, not Å."
        in found["text"]
    )
    assert found["tainted"] is True


@needs_database
async def test_search_by_meaning_and_past_chats(memory_api):
    api, app = memory_api
    app.state.storage.semantic = FakeSemantic()  # type: ignore[attr-defined]
    await api.put(
        "/memory/notes/plot-style",
        headers=ALICE,
        json=note("No titles; units on the axes.", "How they want figures"),
    )
    found = await tool(api, "memory_search", {"query": "graph"})
    assert "Close in meaning:\n- plot-style (preference): How they want figures" in found["text"]
    both = await tool(api, "memory_search", {"query": "axes"})
    assert "Close in meaning" not in both["text"] and "plot-style" in both["text"]
    assert both["tainted"] is False, "personal notes don't mark the run"

    async def say(chat: str, said: str, answer: str, who: dict = ALICE) -> None:
        messages = [
            {"id": f"{chat}-1", "role": "user", "content": said},
            {"id": f"{chat}-2", "role": "assistant", "content": [{"type": "text", "text": answer}]},
            {"id": f"{chat}-3", "role": "tool", "content": "secret tool output mentioning anodize"},
        ]
        body = {
            "agentId": "default",
            "runId": f"{chat}-run",
            "events": [],
            "messages": messages,
            "name": said,
        }
        assert (await api.post(f"/chats/{chat}/runs", headers=who, json=body)).status_code == 201

    await say(
        "c-etch",
        "What was the etch rate on the wafer line?",
        "About 40 nm/min with the new recipe.",
    )
    await say("c-lunch", "Where should we get lunch?", "The place by the lab.")
    await say("c-secret", "Etch numbers for the audit", "Here they are.")
    await api.put("/memory/settings", headers=ALICE, json={"thread": "c-secret", "incognito": True})
    await say("t-1", "etch again", "Sure.")
    await say("c-theirs", "My etch notes", "Noted.", BOB)

    hits = await tool(api, "chats_search", {"query": "etch rate"})
    assert hits["text"].startswith("- c-etch: What was the etch rate")
    assert "\n  user: What was the etch rate" in hits["text"]
    for absent in ("c-secret", "c-theirs", "- t-1:", "c-lunch"):
        assert absent not in hits["text"]
    assert hits["tainted"] is True, "past chats count as outside content"
    assert (await tool(api, "chats_search", {"query": "anodize"}))["text"] == "No past chats match."
    assert (await tool(api, "chats_search", {"query": "%_"}))["text"] == "No past chats match."
    await say("c-newer", "wafer only", "ok")
    ranked = await tool(api, "chats_search", {"query": "wafer etch rate", "limit": 1})
    assert ranked["text"].startswith("- c-etch:")

    read = await tool(api, "chats_read", {"id": "c-etch"})
    assert "User: What was the etch rate on the wafer line?\n\nYou: About 40 nm/min" in read["text"]
    assert "anodize" not in read["text"]
    assert (await tool(api, "chats_read", {"id": "c-secret"}))["isError"] is True
    assert (await tool(api, "chats_read", {"id": "c-theirs"}))["text"] == (
        "No past chat c-theirs (or it is incognito)."
    )
    await say("c-long", "Tell me everything", "x" * 20_000)
    first = await tool(api, "chats_read", {"id": "c-long"})
    assert first["text"].endswith("(more: chats_read with offset 12000)")
    second = await tool(api, "chats_read", {"id": "c-long", "offset": 12_000})
    assert "(more:" not in second["text"]


@needs_database
async def test_nothing_in_an_incognito_chat_or_with_memory_off(memory_api):
    api, _app = memory_api
    await api.put("/memory/settings", headers=ALICE, json={"thread": "t-2", "incognito": True})
    off = await api.get("/memory/agent", headers=token(thread="t-2"))
    assert (off.status_code, off.json()) == (
        403,
        {"error": "Memory is off in this chat (incognito, or turned off)"},
    )
    await api.put("/memory/settings", headers=ALICE, json={"mode": "off"})
    blocked = await api.post(
        "/memory/agent/tools/memory_search", headers=token(), json={"query": "short"}
    )
    assert blocked.status_code == 403
    await api.put("/memory/settings", headers=ALICE, json={"mode": "ask"})
    asked = await tool(api, "memory_save", {**note("x", "x"), "name": "x"})
    assert "waits in the user's Memory inbox" in asked["text"]


@needs_database
async def test_outside_servers_and_bad_tokens_go_to_typescript(memory_api, database):
    api, _app = memory_api
    for headers in (
        {},
        token(via="mcp:lab"),
        token(aud=tokens.STORAGE_AUDIENCE),
        token(thread=DROP),
        token(exp=1),
        local_token(),
    ):
        answer = await api.get("/memory/agent", headers=headers)
        assert answer.json() == {"from": "typescript"}, headers
    assert support.forwarded == ["GET /memory/agent"] * 6
    support.forwarded.clear()

    # Without login, the unsigned local token is the local user's.
    async with Client(database, None, memory=True) as (local, _):
        await local.put("/memory/notes/local-note", json=note("Here.", "Local", "reference"))
        ok = await local.get("/memory/agent", headers=local_token())
        assert ok.status_code == 200 and "local-note" in ok.json()["prompt"]
        assert (await local.get("/memory/agent", headers=token())).json() == {"from": "typescript"}
        assert (await local.get("/memory/agent", headers=local_token(via="mcp:x"))).json() == {
            "from": "typescript"
        }
        assert support.forwarded == ["GET /memory/agent"] * 2
        support.forwarded.clear()
