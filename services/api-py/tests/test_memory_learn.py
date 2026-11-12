"""The background learner (memory_learn.py), as apps/agent/src/memory/learn.ts runs it.

Mirrors apps/agent/src/memory/learn.test.ts (sweeps), and learns from chats in a
real, migrated Postgres with a stand-in for the small model.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator

import httpx
import psycopg
import pytest
from support import ALICE, BOB, SECRET, URL, Client

from api_py.config import idle_minutes, settings_from_env
from api_py.memory_learn import LEARN_TOOL, SYSTEM, TOOL, MemoryLearner, propose_changes, transcript

pytestmark = [pytest.mark.anyio]
needs_database = pytest.mark.skipif(not URL, reason="TEST_DATABASE_URL is not set")


def chat(chat_id: str, user: str) -> dict[str, str]:
    return {"id": chat_id, "user_id": user, "last_run_at": "2026-11-12 00:00:00+00"}


def learner_with(due: list[dict[str, str]], learn) -> MemoryLearner:
    learner = MemoryLearner(lambda: None, lambda: None)  # type: ignore[arg-type,return-value]

    async def fixed(limit: int = 5):
        return due

    learner.due = fixed  # type: ignore[method-assign]
    learner.learn = learn  # type: ignore[method-assign]
    return learner


async def test_sweeps_learn_from_users_at_once_and_each_users_chats_in_order():
    active: dict[str, int] = {}
    most_per_user = most = 0
    order: list[str] = []

    async def learn(c):
        nonlocal most_per_user, most
        active[c["user_id"]] = active.get(c["user_id"], 0) + 1
        most_per_user = max(most_per_user, active[c["user_id"]])
        most = max(most, sum(active.values()))
        # Later chats finish sooner, so only the sequencing keeps them in order.
        await asyncio.sleep(0.04 if c["id"].endswith("1") else 0.005)
        order.append(c["id"])
        active[c["user_id"]] -= 1
        return {"made": 1, "proposed": 0}

    due = [
        chat("a1", "alice"),
        chat("b1", "bob"),
        chat("a2", "alice"),
        chat("a3", "alice"),
        chat("b2", "bob"),
    ]
    assert await learner_with(due, learn).sweep() == 5
    assert (most_per_user, most) == (1, 2)
    assert [i for i in order if i.startswith("a")] == ["a1", "a2", "a3"]
    assert [i for i in order if i.startswith("b")] == ["b1", "b2"]


async def test_a_sweep_holds_its_guard_until_every_chat_settles(caplog):
    finished: list[str] = []
    slow_started = asyncio.Event()

    async def learn(c):
        if c["id"] == "fails":
            await slow_started.wait()
            raise RuntimeError("couldn't record the chat")
        if c["id"] == "slow":
            slow_started.set()
            await asyncio.sleep(0.05)
        finished.append(c["id"])
        return {"made": 1, "proposed": 0}

    learner = learner_with(
        [chat("fails", "alice"), chat("after-fail", "alice"), chat("slow", "bob")], learn
    )
    sweep = asyncio.create_task(learner.sweep())
    await slow_started.wait()
    assert await learner.sweep() == 0, "no second pass while one is running"
    assert await sweep == 1
    assert finished == ["slow"]
    assert "couldn't record the chat" in caplog.text


def test_the_transcript_and_settings():
    messages = [
        {"role": "user", "content": "hi " + "x" * 2_100},
        {
            "role": "assistant",
            "content": [{"type": "text", "text": "Hello"}],
            "toolCalls": [{"function": {"name": "read_file"}}],
        },
        {"role": "tool", "content": "secret"},
        {"role": "assistant", "content": "", "toolCalls": []},
    ]
    said = transcript(messages)
    assert said.startswith("User: hi xx") and said.split("\n\n")[0].endswith("x…")
    assert said.endswith("Claude: Hello\n(Claude used read_file)") and "secret" not in said
    # The newest lines that fit, always at least one.
    many = [{"role": "user", "content": f"{i} " + "y" * 1_990} for i in range(10)]
    assert transcript(many).split("\n\n")[0].startswith("User: 4 ")
    assert idle_minutes(None) == 10 and idle_minutes("") == 0 and idle_minutes(" 2.5 ") == 2.5
    assert (
        idle_minutes("-1") == 10 and idle_minutes("soon") == 10 and idle_minutes("Infinity") == 10
    )
    env = {"MEMORY": "on", "MEMORY_LEARN": " OFF ", "MEMORY_IDLE_MINUTES": "1"}
    settings = settings_from_env(env)
    assert (settings.memory_learn, settings.memory_idle_minutes) == (False, 1)
    assert settings_from_env({"MEMORY_LEARN": "on"}).memory_learn is True


def model(changes: list | Exception, calls: list | None = None):
    async def create(params: dict) -> dict:
        if calls is not None:
            calls.append(params)
        if isinstance(changes, Exception):
            raise changes
        return {
            "content": [
                {"type": "tool_use", "id": "t", "name": LEARN_TOOL, "input": {"changes": changes}}
            ]
        }

    return create


async def test_the_model_call():
    calls: list[dict] = []
    messages = [{"role": "user", "content": "I run the etch line."}]
    changes = await propose_changes(
        "",
        messages,
        model([{"op": "add", "name": f"n{i}"} for i in range(7)] + [{"name": 5}], calls),
        "2026-11-12",
    )
    assert [c["name"] for c in changes] == ["n0", "n1", "n2", "n3", "n4"]
    (call,) = calls
    assert (call["max_tokens"], call["system"], call["tools"], call["tool_choice"]) == (
        4000,
        SYSTEM,
        [TOOL],
        {"type": "tool", "name": LEARN_TOOL},
    )
    assert call["messages"][0]["content"] == (
        '<notes>\n(none yet)\n</notes>\n\n<chat date="2026-11-12">\nUser: I run the etch line.\n</chat>'
    )
    assert (
        await propose_changes("", [{"role": "assistant", "content": "Hi"}], model(RuntimeError()))
        == []
    )
    with pytest.raises(ValueError, match="didn't call memory_changes"):
        await propose_changes("", messages, model(None))  # type: ignore[arg-type]


@pytest.fixture
async def memory_api(database) -> AsyncIterator[tuple[httpx.AsyncClient, object]]:
    async with Client(database, SECRET, memory=True) as (client, app):
        yield client, app


async def say(api: httpx.AsyncClient, chat_id: str, said: str, who: dict = ALICE) -> None:
    body = {
        "agentId": "default",
        "runId": f"{chat_id}-run",
        "events": [],
        "messages": [{"id": f"{chat_id}-1", "role": "user", "content": said}],
    }
    assert (await api.post(f"/chats/{chat_id}/runs", headers=who, json=body)).status_code == 201


async def quiet(database: str, *chats: str) -> None:
    """The chats' last runs 20 minutes ago (all of them, without names)."""
    async with await psycopg.AsyncConnection.connect(database, autocommit=True) as conn:
        await conn.execute(
            "UPDATE chats SET last_run_at = now() - interval '20 minutes'"
            " WHERE cardinality(%s::text[]) = 0 OR id = ANY(%s::text[])",
            (list(chats), list(chats)),
        )


@needs_database
async def test_learning_from_quiet_chats(memory_api, database):
    api, app = memory_api
    await api.put(
        "/memory/notes/reply-style",
        headers=ALICE,
        json={"description": "Short answers", "type": "preference", "body": "Short."},
    )
    # Started with storage, as the search indexer is.
    learner: MemoryLearner = app.state.learner  # type: ignore[attr-defined]
    await say(
        api, "c-1", "I'm a process engineer on the etch line. Keep answers short, with tables."
    )
    await say(api, "c-new", "Just now")
    await say(api, "c-hidden", "Incognito")
    await api.put("/memory/settings", headers=ALICE, json={"thread": "c-hidden", "incognito": True})
    await say(api, "c-bob", "Bob's chat", BOB)
    await api.put("/memory/settings", headers=BOB, json={"mode": "off"})
    await quiet(database)
    await say(api, "c-new", "Still going")  # active again: not quiet yet

    assert [c["id"] for c in await learner.due()] == ["c-1"]

    calls: list[dict] = []
    app.state.create_message = model(  # type: ignore[attr-defined]
        [
            {
                "op": "add",
                "name": "work-role",
                "description": "Process engineer",
                "type": "profile",
                "body": "Etch line.",
                "reason": "They said so",
            },
            {
                "op": "update",
                "name": "reply-style",
                "description": "Short answers, tables",
                "type": "preference",
                "body": "Short; tables.",
                "reason": "More detail",
            },
            {"op": "delete", "name": "never-seen", "reason": "x"},
            {
                "op": "add",
                "name": "Bad Name",
                "description": "x",
                "type": "profile",
                "body": "x",
                "reason": "x",
            },
        ],
        calls,
    )
    assert await learner.sweep() == 1
    assert '<note name="reply-style" type="preference"' in calls[0]["messages"][0]["content"]
    notes = {n["name"]: n for n in (await api.get("/memory", headers=ALICE)).json()["notes"]}
    assert set(notes) == {"reply-style", "work-role"}
    assert (notes["reply-style"]["version"], notes["work-role"]["updatedBy"]) == (2, "agent")
    activity = (await api.get("/memory/activity", headers=ALICE)).json()["activity"]
    assert {(a["name"], a["kind"], a["source"], a["threadId"]) for a in activity} == {
        ("work-role", "create", "learn", "c-1"),
        ("reply-style", "update", "learn", "c-1"),
    }
    # Learned from: not due again until it has new runs.
    assert await learner.due() == []
    await say(api, "c-1", "I moved to litho.")
    await quiet(database, "c-1")
    assert [c["id"] for c in await learner.due()] == ["c-1"]

    # Ask first: the changes wait in the inbox, against the version the model saw.
    await api.put("/memory/settings", headers=ALICE, json={"mode": "ask"})
    app.state.create_message = model(  # type: ignore[attr-defined]
        [
            {
                "op": "update",
                "name": "work-role",
                "description": "Process engineer",
                "type": "profile",
                "body": "Litho.",
                "reason": "Moved",
            }
        ]
    )
    assert await learner.learn((await learner.due())[0]) == {"made": 0, "proposed": 1}
    inbox = (await api.get("/memory", headers=ALICE)).json()["inbox"]
    assert [(i["op"], i["name"], i["source"], i["reason"], i["baseVersion"]) for i in inbox] == [
        ("update", "work-role", "learn", "Moved", 1)
    ]

    # A model that fails: the chat is recorded with the error, and isn't tried again.
    await say(api, "c-1", "One more thing.")
    await quiet(database, "c-1")
    app.state.create_message = model(RuntimeError("no key"))  # type: ignore[attr-defined]
    assert await learner.learn((await learner.due())[0]) == {
        "made": 0,
        "proposed": 0,
        "error": "no key",
    }
    async with await psycopg.AsyncConnection.connect(database) as conn:
        cur = await conn.execute("SELECT chat_id, error FROM memory_learned_chats")
        assert await cur.fetchall() == [("c-1", "no key")]
    assert await learner.due() == []
