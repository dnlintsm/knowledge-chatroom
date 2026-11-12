"""POST /memory/import served by api-py (memory_import.py, llm.py), against a real, migrated Postgres.

Mirrors the import tests in apps/agent/src/storage/memory-packs.test.ts, with a
stand-in for the small model.
"""

from __future__ import annotations

import io
import json
import zipfile
from collections.abc import AsyncIterator

import httpx
import pytest
from support import ALICE, BOB, SECRET, URL, Client

from api_py import llm
from api_py.memory import MemoryError_, slugify
from api_py.memory_import import IMPORT_TOOL, MAX_IMPORT, SYSTEM, TOOL, parse_notes, parse_zip

pytestmark = [pytest.mark.anyio]
needs_database = pytest.mark.skipif(not URL, reason="TEST_DATABASE_URL is not set")


def zipped(files: dict[str, bytes]) -> bytes:
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, content in files.items():
            archive.writestr(name, content)
    return out.getvalue()


def model(notes: list | Exception, calls: list | None = None):
    """A model that answers the import tool with `notes`, or fails."""

    async def create(params: dict) -> dict:
        if calls is not None:
            calls.append(params)
        if isinstance(notes, Exception):
            raise notes
        return {
            "content": [
                {"type": "tool_use", "id": "t", "name": IMPORT_TOOL, "input": {"notes": notes}}
            ]
        }

    return create


def test_reads_notes_with_front_matter_also_claude_codes():
    notes = parse_notes(
        "---\nname: reply-style\ndescription: Short answers\ntype: preference\n---\nLead with the result.\n"
        '---\nname: Lab Role\ndescription: "Their role"\nmetadata:\n  type: profile\n---\nProcess engineer.'
    )
    assert [(n["name"], n["type"], n["body"]) for n in notes] == [
        ("reply-style", "preference", "Lead with the result."),
        ("lab-role", "profile", "Process engineer."),
    ]
    assert notes[1]["description"] == "Their role"
    assert parse_notes("I like tables. I work on etch.") == []
    # Windows line ends, no description, an unknown type, a name to slug.
    assert parse_notes("\r\n---\r\nname: Écrire Bien!\r\ntype: mood\r\n---\r\n\r\nBody\r\n") == [
        {"name": "crire-bien", "description": "crire bien", "type": "reference", "body": "Body"}
    ]
    assert parse_notes("---\nname: !!!\n---\nx") == []
    assert parse_notes("---\ndescription: none\n---\nx") == []
    assert slugify("Writing style!") == "writing-style" and slugify("a" * 70 + "-b") == "a" * 64


def test_reads_zips_of_notes():
    data = zipped(
        {
            "memory/b.md": "﻿---\nname: b\ndescription: B\ntype: project\n---\nB body".encode(),
            "memory/a.md": b"---\nname: a\ndescription: A\n---\nA body",
            "memory/archived/c.md": b"---\nname: c\ndescription: C\n---\nC",
            "readme.txt": b"hi",
        }
    )
    assert [(n["name"], n["type"]) for n in parse_zip(data)] == [
        ("a", "reference"),
        ("b", "project"),
    ]
    with pytest.raises(MemoryError_, match="That isn't a .zip file we can read"):
        parse_zip(b"not a zip")
    many = zipped({f"memory/n{i}.md": b"---\nname: n\n---\nx" for i in range(201)})
    with pytest.raises(MemoryError_, match="too much to import"):
        parse_zip(many)
    with pytest.raises(MemoryError_, match="too much to import"):
        parse_zip(zipped({"big.md": bytes(5 * 1024 * 1024)}))


def test_the_model_is_chosen_as_the_agent_server_chooses_it():
    assert llm.learn_model({"MEMORY_MODEL": " claude-x.1 "}) == "claude-x-1"
    assert llm.learn_model({"SUGGESTIONS_MODEL": "claude-y.2"}) == "claude-y-2"
    assert llm.learn_model({}) == llm.DEFAULT_SUGGESTIONS_MODEL
    assert llm.learn_model({"CLAUDE_MODEL": "openrouter/some.model"}) == "openrouter/some.model"
    assert llm.learn_model({"ANTHROPIC_MODEL": "claude-z"}) == llm.DEFAULT_SUGGESTIONS_MODEL


async def test_the_messages_api_call():
    seen: list[httpx.Request] = []

    def answer(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if len(seen) == 1:
            return httpx.Response(529, json={"error": "overloaded"})
        return httpx.Response(200, json={"content": []})

    env = {"ANTHROPIC_API_KEY": "k", "ANTHROPIC_BASE_URL": "https://gateway.example/proxy/"}
    create = llm.message_creator(env, httpx.MockTransport(answer))
    assert await create({"model": "m"}) == {"content": []}
    assert [str(r.url) for r in seen] == ["https://gateway.example/proxy/v1/messages"] * 2
    assert (seen[0].headers["x-api-key"], seen[0].headers["anthropic-version"]) == (
        "k",
        "2023-06-01",
    )
    assert json.loads(seen[0].content) == {"model": "m"}

    bearer = llm.message_creator(
        {"ANTHROPIC_AUTH_TOKEN": "t"},
        httpx.MockTransport(lambda r: httpx.Response(400, text="bad")),
    )
    with pytest.raises(llm.ModelError, match="400"):
        await bearer({})
    with pytest.raises(llm.ModelError, match="no ANTHROPIC_API_KEY"):
        await llm.message_creator({})({})


@pytest.fixture
async def memory_api(database) -> AsyncIterator[tuple[httpx.AsyncClient, object]]:
    async with Client(database, SECRET, memory=True) as (client, app):
        yield client, app


@needs_database
async def test_importing_puts_every_note_in_the_inbox(memory_api):
    api, app = memory_api
    note = {"description": "Short answers", "type": "preference", "body": "Short."}
    await api.put("/memory/notes/reply-style", headers=ALICE, json=note)
    app.state.create_message = model(RuntimeError("not called"))
    files = await api.post(
        "/memory/import",
        headers=ALICE,
        json={
            "text": "---\nname: reply-style\ndescription: Short answers, tables\ntype: preference\n---\nShort; tables."
        },
    )
    assert files.status_code == 200, files.text
    assert files.headers["cache-control"] == "no-store"
    assert files.json() == {"proposed": 1, "skipped": 0, "how": "files"}
    inbox = (await api.get("/memory", headers=ALICE)).json()["inbox"]
    assert [(i["op"], i["name"], i["source"], i["reason"]) for i in inbox] == [
        ("update", "reply-style", "import", "Imported from memory files")
    ]

    # Plain text goes to the model, with the notes there are.
    calls: list[dict] = []
    app.state.create_message = model(
        [
            {
                "name": "work-role",
                "description": "Process engineer",
                "type": "profile",
                "body": "An engineer.",
            },
            {"name": "Bad Name!", "description": "x", "type": "preference", "body": "x"},
            {"name": "units", "description": "", "type": "preference", "body": "Metric."},
            {"name": 5},
        ],
        calls,
    )
    text = await api.post(
        "/memory/import",
        headers=ALICE,
        json={"text": "User is a process engineer.", "label": "ChatGPT"},
    )
    assert text.json() == {"proposed": 2, "skipped": 1, "how": "text"}
    (call,) = calls
    assert (call["max_tokens"], call["system"], call["tools"], call["tool_choice"]) == (
        8000,
        SYSTEM,
        [TOOL],
        {"type": "tool", "name": IMPORT_TOOL},
    )
    content = call["messages"][0]["content"]
    assert content.startswith('<notes>\n<note name="reply-style" type="preference" updated="')
    assert content.endswith("</notes>\n\n<imported>\nUser is a process engineer.\n</imported>")
    inbox = (await api.get("/memory", headers=ALICE)).json()["inbox"]
    assert {(i["name"], i["reason"]) for i in inbox} >= {
        ("work-role", "Imported from ChatGPT"),
        ("bad-name", "Imported from ChatGPT"),
    }

    # Without the model, the text is one note.
    app.state.create_message = model(RuntimeError("no key"))
    whole = await api.post("/memory/import", headers=ALICE, json={"text": "  Likes tables.  "})
    assert whole.json() == {"proposed": 1, "skipped": 0, "how": "whole"}
    inbox = (await api.get("/memory", headers=ALICE)).json()["inbox"]
    item = next(i for i in inbox if i["name"] == "imported-memory")
    assert (item["body"], item["description"]) == (
        "Likes tables.",
        "Memory imported from another assistant",
    )
    # The same change again replaces it.
    again = await api.post(
        "/memory/import", headers=ALICE, json={"text": "Likes charts.", "label": "x" * 150}
    )
    assert again.json()["proposed"] == 1
    inbox = (await api.get("/memory", headers=ALICE)).json()["inbox"]
    item = next(i for i in inbox if i["name"] == "imported-memory")
    assert item["description"] == "Memory imported from " + "x" * 100

    # Accepting one makes it a note.
    work = next(i for i in inbox if i["name"] == "work-role")
    assert (await api.post(f"/memory/inbox/{work['id']}/accept", headers=ALICE)).status_code == 200
    assert (await api.get("/memory/notes/work-role", headers=ALICE)).json()["note"][
        "body"
    ] == "An engineer."
    assert (await api.get("/memory", headers=BOB)).json()["inbox"] == []


@needs_database
async def test_importing_an_export_and_the_refusals(memory_api):
    api, app = memory_api
    app.state.create_message = model(RuntimeError("not called"))
    await api.put(
        "/memory/notes/style",
        headers=ALICE,
        json={"description": "S", "type": "profile", "body": "B"},
    )
    export = (await api.get("/memory/export", headers=ALICE)).content
    answer = await api.post(
        "/memory/import", headers={**BOB, "content-type": "application/zip"}, content=export
    )
    assert answer.json() == {"proposed": 1, "skipped": 0, "how": "files"}
    item = (await api.get("/memory", headers=BOB)).json()["inbox"][0]
    assert (item["op"], item["name"], item["type"], item["body"]) == (
        "add",
        "style",
        "profile",
        "B",
    )

    cases = [
        ({"json": {"text": " \n "}}, 400, "Nothing to import: paste the memory or pick a file"),
        ({"json": {"text": 5}}, 400, "Nothing to import: paste the memory or pick a file"),
        ({"json": [1]}, 400, "Invalid JSON body (2 MB at most)"),
        ({"content": b"x" * (2 * 1024 * 1024 + 1)}, 400, "Invalid JSON body (2 MB at most)"),
        (
            {
                "content": b"x" * (2 * 1024 * 1024 + 1),
                "headers": {"content-type": "application/zip"},
            },
            413,
            "That file is too big to import (2 MB at most)",
        ),
        (
            {"content": b"not a zip", "headers": {"content-type": "application/zip; x=y"}},
            400,
            "That isn't a .zip file we can read",
        ),
        (
            {"content": zipped({"a.txt": b"x"}), "headers": {"content-type": "application/zip"}},
            400,
            "No notes found to import",
        ),
    ]
    for given, status, error in cases:
        headers = {**ALICE, **given.pop("headers", {})}
        refused = await api.post("/memory/import", headers=headers, **given)
        assert (refused.status_code, refused.json()) == (status, {"error": error}), error
    assert (await api.get("/memory/import", headers=ALICE)).status_code == 404
    assert (await api.post("/memory/import/more", headers=ALICE)).status_code == 405
    assert (await api.post("/memory/import")).json() == {"error": "Sign in first"}


@needs_database
async def test_an_import_stops_when_the_inbox_is_full(memory_api):
    api, app = memory_api
    app.state.create_message = model(
        [
            {"name": f"n{i}", "description": "d", "type": "project", "body": "b"}
            for i in range(MAX_IMPORT + 5)
        ]
    )
    first = await api.post("/memory/import", headers=ALICE, json={"text": "lots"})
    assert first.json() == {"proposed": MAX_IMPORT, "skipped": 5, "how": "text"}
    app.state.create_message = model(
        [{"name": f"m{i}", "description": "d", "type": "project", "body": "b"} for i in range(25)]
    )
    second = await api.post("/memory/import", headers=ALICE, json={"text": "more"})
    assert second.json() == {"proposed": 20, "skipped": 5, "how": "text"}
    assert len((await api.get("/memory", headers=ALICE)).json()["inbox"]) == 50
