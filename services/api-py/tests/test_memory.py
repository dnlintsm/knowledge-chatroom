"""/memory's own notes served by api-py (memory.py, memory_routes.py), against a real, migrated Postgres."""

from __future__ import annotations

import io
import zipfile
from collections.abc import AsyncIterator

import httpx
import pytest
import support
from support import ALICE, BOB, SECRET, URL, Client, storage_token

from api_py.access import Principal
from api_py.config import settings_from_env
from api_py.memory import MemoryError_, MemoryService, check_input, to_markdown
from api_py.session import Session

pytestmark = [pytest.mark.anyio]
needs_database = pytest.mark.skipif(not URL, reason="TEST_DATABASE_URL is not set")
NOTE = {"description": "How alice likes answers", "type": "preference", "body": "Short sentences."}


def test_memory_setting_reads_like_the_agent():
    for on in ("on", " ON ", "1", "true", "Yes"):
        assert settings_from_env({"MEMORY": on}).memory, on
    for off in ("", "off", "0", "enabled"):
        assert not settings_from_env({"MEMORY": off}).memory, off
    assert not settings_from_env({}).memory


def test_input_is_cleaned_like_check_input():
    assert check_input({"description": "  One \n\t line ", "body": "a\r\nb\rc  "}) == {
        "description": "One line",
        "type": "preference",
        "body": "a\nb\nc",
    }
    assert check_input({"description": "x", "type": None})["type"] == "preference"
    cases = [
        ({}, "A memory needs a one-line description"),
        ({"description": 5}, "A memory needs a one-line description"),
        ({"description": "x" * 301}, "A memory's description is at most 300 characters"),
        # 150 emoji are 300 characters as JavaScript counts them; one more is too many.
        ({"description": "😀" * 151}, "A memory's description is at most 300 characters"),
        ({"description": "x", "type": "mood"}, "A memory's type is one of preference, profile, project"),
        ({"description": "x", "type": ["preference"]}, "A memory's type is one of"),
        ({"description": "x", "body": "😀" * 8001}, "A memory is at most 16000 characters"),
    ]
    for given, message in cases:
        with pytest.raises(MemoryError_, match=message.replace("(", r"\(")):
            check_input(given)
    assert check_input({"description": "😀" * 150, "body": 7})["body"] == ""
    assert to_markdown({"name": "a", "description": "b", "type": "profile", "body": "c"}) == (
        "---\nname: a\ndescription: b\ntype: profile\n---\n\nc\n"
    )


@pytest.fixture
async def memory_api(database) -> AsyncIterator[tuple[httpx.AsyncClient, object]]:
    async with Client(database, SECRET, memory=True) as (client, app):
        yield client, app


async def alice_memory(app) -> MemoryService:
    """Alice's MemoryService, for what only Claude does (its changes, the inbox)."""
    assert await app.state.storage_ready()
    storage = app.state.storage
    user_id = await storage.access.user_for_subject("kc|alice", email="alice@example.com", name="Alice")
    session = Session(storage, storage.access, Principal(user_id=user_id))
    return MemoryService(session.scoped, session.ws, user_id)


@needs_database
async def test_notes_from_create_to_delete(memory_api):
    api, _app = memory_api
    made = await api.put("/memory/notes/style?create=1", headers=ALICE, json=NOTE)
    assert made.status_code == 200, made.text
    assert made.headers["cache-control"] == "no-store"
    note = made.json()["note"]
    assert (note["name"], note["version"], note["createdBy"], note["archived"], note["lastUsedAt"]) == (
        "style",
        1,
        "user",
        False,
        None,
    )
    assert list(note) == [
        "name",
        "description",
        "type",
        "body",
        "version",
        "createdBy",
        "updatedBy",
        "archived",
        "createdAt",
        "updatedAt",
        "lastUsedAt",
    ]
    again = await api.put("/memory/notes/style?create=1", headers=ALICE, json=NOTE)
    assert (again.status_code, again.json()) == (409, {"error": "A memory named style already exists"})
    # The same content again is no new version.
    assert (await api.put("/memory/notes/style", headers=ALICE, json=NOTE)).json()["note"]["version"] == 1
    changed = await api.put("/memory/notes/style", headers=ALICE, json={**NOTE, "body": "Very short."})
    assert changed.json()["note"]["version"] == 2
    got = (await api.get("/memory/notes/style", headers=ALICE)).json()
    assert [(v["version"], v["body"], v["changedBy"], v["threadId"]) for v in got["versions"]] == [
        (2, "Very short.", "user", None),
        (1, "Short sentences.", "user", None),
    ]
    restored = await api.post("/memory/notes/style/restore", headers=ALICE, json={"version": "1"})
    assert (restored.json()["note"]["version"], restored.json()["note"]["body"]) == (3, "Short sentences.")
    for bad in ({}, {"version": 0}, {"version": 1.5}, {"version": "x"}, {"version": None}):
        answer = await api.post("/memory/notes/style/restore", headers=ALICE, json=bad)
        assert (answer.status_code, answer.json()) == (400, {"error": "Say which version"}), bad
    missing = await api.post("/memory/notes/style/restore", headers=ALICE, json={"version": 9})
    assert (missing.status_code, missing.json()) == (404, {"error": "No memory named style version 9"})
    huge = await api.post("/memory/notes/style/restore", headers=ALICE, json={"version": 2**40})
    assert (huge.status_code, huge.json()) == (500, {"error": "Memory request failed"})

    archived = await api.post("/memory/notes/style/archive", headers=ALICE, json={"archived": True})
    assert archived.json()["note"]["archived"] is True
    assert (await api.post("/memory/notes/style/archive", headers=ALICE, json={})).json()["note"]["archived"] is True
    back = await api.post("/memory/notes/style/archive", headers=ALICE, json={"archived": False})
    assert back.json()["note"]["archived"] is False

    # Bob sees none of it.
    assert (await api.get("/memory/notes/style", headers=BOB)).status_code == 404
    assert (await api.delete("/memory/notes/style", headers=BOB)).status_code == 404
    deleted = await api.delete("/memory/notes/style", headers=ALICE)
    assert deleted.json() == {"name": "style", "deleted": True}
    gone = await api.delete("/memory/notes/style", headers=ALICE)
    assert (gone.status_code, gone.json()) == (404, {"error": "No memory named style"})


@needs_database
async def test_refusals(memory_api):
    api, _app = memory_api
    assert (await api.get("/memory/notes/x")).json() == {"error": "Sign in first"}
    # Storage tokens don't reach memory.
    assert (await api.get("/memory/activity", headers=storage_token("kc|alice"))).status_code == 401
    cases = [
        ("GET", "/memory/notes/Not-A-Name", None, 404, "No memory named Not-A-Name"),
        ("PUT", "/memory/notes/Not-A-Name", NOTE, 400, "A memory's name is lowercase letters"),
        ("PUT", "/memory/notes/style", {**NOTE, "type": "mood"}, 400, "A memory's type is one of"),
        ("PUT", "/memory/notes/style", [NOTE], 400, "Invalid JSON body"),
        ("GET", "/memory/notes", None, 404, "Not found"),
        ("PUT", "/memory/notes", NOTE, 405, "Method not allowed"),
        ("POST", "/memory/notes/style", NOTE, 405, "Method not allowed"),
        ("GET", "/memory/notes/style/restore/more", None, 404, "Not found"),
        ("PUT", "/memory/settings", {"mode": "sometimes"}, 400, "mode is on, ask or off"),
        ("PUT", "/memory/settings", {"mode": None}, 400, "mode is on, ask or off"),
        ("PUT", "/memory/settings", {"incognito": True}, 400, "Say which chat: thread"),
        ("PUT", "/memory/settings", {"incognito": True, "thread": "😀" * 101}, 400, "Say which chat: thread"),
        ("POST", "/memory/inbox/not-an-id/accept", None, 404, "No memory named change in the inbox"),
        ("POST", "/memory/events/not-an-id/undo", None, 404, "No memory named for that change"),
        ("POST", "/memory/events/00000000-0000-0000-0000-000000000000/undo", None, 404, "No memory named for that"),
        ("GET", "/memory/events/00000000-0000-0000-0000-000000000000/undo", None, 404, "Not found"),
    ]
    for method, path, body, status, error in cases:
        answer = await api.request(method, path, headers=ALICE, json=body)
        assert answer.status_code == status and answer.json()["error"].startswith(error), (path, answer.text)
    bom = await api.put("/memory/settings", headers=ALICE, content="﻿{}".encode())
    assert (bom.status_code, bom.json()) == (400, {"error": "Invalid JSON body"})
    empty = await api.put("/memory/settings", headers=ALICE)
    assert empty.json() == {"mode": "on", "incognito": False}


@needs_database
async def test_settings_and_incognito_chats(memory_api):
    api, _app = memory_api
    assert (await api.put("/memory/settings", headers=ALICE, json={"mode": "ask"})).json() == {
        "mode": "ask",
        "incognito": False,
    }
    on = await api.put("/memory/settings", headers=ALICE, json={"mode": "on", "thread": "t1", "incognito": True})
    assert on.json() == {"mode": "on", "incognito": True}
    # The mode is set before the chat is checked, as on the TypeScript server.
    refused = await api.put("/memory/settings", headers=ALICE, json={"mode": "off", "incognito": True, "thread": ""})
    assert refused.status_code == 400
    assert (await api.put("/memory/settings", headers=ALICE, json={"thread": "t1"})).json() == {
        "mode": "off",
        "incognito": True,
    }
    off = await api.put("/memory/settings", headers=ALICE, json={"thread": "t1", "incognito": "yes"})
    assert off.json() == {"mode": "off", "incognito": False}
    assert (await api.put("/memory/settings", headers=BOB, json={"thread": "t1"})).json() == {
        "mode": "on",
        "incognito": False,
    }


@needs_database
async def test_claudes_changes_the_inbox_and_undo(memory_api, database):
    api, app = memory_api
    memory = await alice_memory(app)
    run = {"threadId": "t1", "runId": "r1"}
    _note, created = await memory.save("tone", NOTE, "agent", run=run)
    _note, updated = await memory.save("tone", {**NOTE, "body": "Warmer."}, "agent", run=run)
    assert created and updated and (created["kind"], updated["kind"]) == ("create", "update")
    activity = (await api.get("/memory/activity", headers=ALICE)).json()["activity"]
    assert [(a["kind"], a["version"], a["source"], a["undoable"]) for a in activity] == [
        ("update", 2, "chat", True),
        ("create", 1, "chat", False),
    ]
    undone = await api.post(f"/memory/events/{updated['id']}/undo", headers=ALICE)
    assert (undone.json()["name"], undone.json()["note"]["version"], undone.json()["note"]["body"]) == (
        "tone",
        3,
        "Short sentences.",
    )
    twice = await api.post(f"/memory/events/{updated['id']}/undo", headers=ALICE)
    assert (twice.status_code, twice.json()) == (409, {"error": "That change was already undone"})
    stale = await api.post(f"/memory/events/{created['id']}/undo", headers=ALICE)
    assert (stale.status_code, stale.json()["error"]) == (409, "tone changed since; restore an earlier version instead")
    assert (await api.post(f"/memory/events/{created['id']}/undo", headers=BOB)).status_code == 404

    # Archived by Claude, then undone: back in use.
    _note, archived = await memory.archive("tone", True, run)
    assert archived and archived["kind"] == "archive"
    back = (await api.post(f"/memory/events/{archived['id']}/undo", headers=ALICE)).json()
    assert back["note"]["archived"] is False and back["note"]["version"] == 3

    # Proposals, as the inbox holds them (written as the TypeScript server writes them).
    async def propose(op: str, name: str, base: int | None, **content) -> str:
        async with memory.scoped() as conn:
            cur = await conn.execute(
                """
                INSERT INTO memory_inbox (workspace_id, user_id, op, name, description, type, body, base_version,
                                          source, thread_id, reason)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, 'chat', 't2', 'because') RETURNING id::text""",
                (
                    memory.ws,
                    memory.user,
                    op,
                    name,
                    content.get("description"),
                    content.get("type"),
                    content.get("body"),
                    base,
                ),
            )
            return (await cur.fetchone())[0]

    add = await propose("add", "habits", None, **NOTE)
    stale_update = await propose("update", "tone", 1, **{**NOTE, "body": "Old base."})
    drop = await propose("delete", "tone", 3)
    accepted = await api.post(f"/memory/inbox/{add}/accept", headers=ALICE)
    assert accepted.status_code == 200, accepted.text
    assert (accepted.json()["id"], accepted.json()["status"], accepted.json()["note"]["createdBy"]) == (
        add,
        "accepted",
        "agent",
    )
    conflict = await api.post(f"/memory/inbox/{stale_update}/accept", headers=ALICE)
    assert (conflict.status_code, conflict.json()["error"]) == (
        409,
        "tone changed since Claude proposed this; reject it, or edit the note yourself",
    )
    # Still waiting after the conflict, so it can be rejected.
    assert stale_update in [i["id"] for i in await memory.inbox()]
    rejected = await api.post(f"/memory/inbox/{stale_update}/reject", headers=ALICE)
    assert rejected.json() == {"id": stale_update, "status": "rejected"}
    assert (await api.post(f"/memory/inbox/{stale_update}/reject", headers=ALICE)).status_code == 404
    dropped = await api.post(f"/memory/inbox/{drop}/accept", headers=ALICE)
    assert dropped.json()["note"]["archived"] is True
    activity = (await api.get("/memory/activity", headers=ALICE)).json()["activity"]
    assert [(a["name"], a["kind"], a["source"], a["threadId"]) for a in activity[:2]] == [
        ("tone", "archive", "inbox", "t2"),
        ("habits", "create", "inbox", "t2"),
    ]
    # Undoing an accepted add removes the note, its history with it.
    habits = next(a for a in activity if a["name"] == "habits")
    assert (await api.post(f"/memory/events/{habits['id']}/undo", headers=ALICE)).json() == {
        "name": "habits",
        "note": None,
    }
    assert (await api.get("/memory/notes/habits", headers=ALICE)).status_code == 404


@needs_database
async def test_export(memory_api):
    api, _app = memory_api
    await api.put("/memory/notes/style", headers=ALICE, json=NOTE)
    await api.put("/memory/notes/old", headers=ALICE, json={**NOTE, "body": ""})
    await api.post("/memory/notes/old/archive", headers=ALICE, json={})
    answer = await api.get("/memory/export", headers=ALICE)
    assert answer.status_code == 200
    assert answer.headers["content-type"] == "application/zip"
    assert answer.headers["content-disposition"] == 'attachment; filename="memory.zip"'
    assert answer.headers["cache-control"] == "no-store"
    with zipfile.ZipFile(io.BytesIO(answer.content)) as archive:
        assert archive.namelist() == ["memory/archived/old.md", "memory/style.md"]
        assert archive.read("memory/style.md").decode() == (
            "---\nname: style\ndescription: How alice likes answers\ntype: preference\n---\n\nShort sentences.\n"
        )
    with zipfile.ZipFile(io.BytesIO((await api.get("/memory/export", headers=BOB)).content)) as archive:
        assert archive.namelist() == []


@needs_database
async def test_the_rest_of_memory_stays_with_typescript(memory_api, database):
    api, _app = memory_api
    for method, path in [
        ("POST", "/memory/import"),
        ("GET", "/memory/agent"),
        ("GET", "/memory/%zz"),
        ("GET", "/memory/%6Eotes/x"),  # decoded: notes, served here
        ("GET", "/memoryx"),
    ]:
        answer = await api.request(method, path, headers=ALICE)
        if path == "/memory/%6Eotes/x":
            assert answer.status_code == 404 and answer.json() == {"error": "No memory named x"}
        else:
            assert answer.json() == {"from": "typescript"}, path
    assert support.forwarded == [
        "POST /memory/import",
        "GET /memory/agent",
        "GET /memory/%zz",
        "GET /memoryx",
    ]
    support.forwarded.clear()
    # Without MEMORY=on here, all of it goes to the TypeScript server, which answers 404.
    async with Client(database, SECRET) as (other, _):
        assert (await other.get("/memory/notes/x", headers=ALICE)).json() == {"from": "typescript"}
        assert support.forwarded == ["GET /memory/notes/x"]
        support.forwarded.clear()
