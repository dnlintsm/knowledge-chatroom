"""/chats served by api-py (chats.py), against a real, migrated Postgres (TEST_DATABASE_URL)."""

from __future__ import annotations

import psycopg
import pytest
from support import ALICE, BOB, URL, Client, storage_token

from api_py.chats import ChatError, _read_cursor, clean_name, valid_chat_id

pytestmark = [pytest.mark.anyio]
needs_database = pytest.mark.skipif(not URL, reason="TEST_DATABASE_URL is not set")


def run(run_id: str, **extra) -> dict:
    return {"agentId": "default", "runId": run_id, "events": [], "messages": [], **extra}


def test_names_ids_and_cursors():
    assert clean_name("  What is \n the   etch rate? ") == "What is the etch rate?"
    assert clean_name("   ") is None and clean_name(None) is None
    # 200 characters as JavaScript counts them; a pair cut in two becomes U+FFFD.
    assert clean_name("a" * 199 + "😀") == "a" * 199 + "�"
    assert valid_chat_id("x" * 200) and not valid_chat_id("x" * 201) and not valid_chat_id("")
    assert not valid_chat_id("😀" * 101)
    assert _read_cursor("2026-11-12 01:02:03.123456+00|abc|d") == ("2026-11-12 01:02:03.123456+00", "abc|d")
    for bad in ("nope", "|abc", "yesterday|abc"):
        with pytest.raises(ChatError, match="Invalid cursor"):
            _read_cursor(bad)


@needs_database
async def test_a_chat_from_first_run_to_delete(api):
    saved = await api.post(
        "/chats/t1/runs",
        headers=ALICE,
        json=run(
            "r1",
            events=[{"type": "RUN_STARTED", "n": 1.5}],
            messages=[{"id": "m1", "role": "user", "content": "hi"}],
            name="  What is   the etch rate? ",
        ),
    )
    assert saved.status_code == 201, saved.text
    chat = saved.json()
    assert (chat["id"], chat["name"], chat["agentId"], chat["archived"]) == (
        "t1",
        "What is the etch rate?",
        "default",
        False,
    )
    assert chat["lastRunAt"].endswith("Z") and len(chat["createdAt"]) == 24
    # Later runs keep the first name and replace the messages.
    second = run("r2", parentRunId="r1", messages=[{"id": "m2", "role": "assistant", "content": "8%"}], name="Other")
    assert (await api.post("/chats/t1/runs", headers=ALICE, json=second)).json()["name"] == "What is the etch rate?"

    got = (await api.get("/chats/t1", headers=ALICE)).json()
    assert got["chat"]["id"] == "t1" and got["messages"] == [{"id": "m2", "role": "assistant", "content": "8%"}]
    runs = (await api.get("/chats/t1/runs", headers=ALICE)).json()["runs"]
    assert [(r["runId"], r["parentRunId"], r["events"]) for r in runs] == [
        ("r1", None, [{"type": "RUN_STARTED", "n": 1.5}]),
        ("r2", "r1", []),
    ]  # fmt: skip

    renamed = await api.patch("/chats/t1", headers=ALICE, json={"name": " Etch  rate ", "archived": True})
    assert (renamed.json()["name"], renamed.json()["archived"]) == ("Etch rate", True)
    assert (await api.get("/chats", headers=ALICE)).json() == {"threads": [], "nextCursor": None}
    assert [t["id"] for t in (await api.get("/chats?archived", headers=ALICE)).json()["threads"]] == ["t1"]
    cleared = (await api.patch("/chats/t1", headers=ALICE, json={"name": None})).json()
    assert (cleared["name"], cleared["archived"]) == (None, True)

    assert (await api.delete("/chats/t1", headers=ALICE)).json() == {"deleted": "t1"}
    for answer in (await api.get("/chats/t1", headers=ALICE), await api.get("/chats/t1/runs", headers=ALICE)):
        assert (answer.status_code, answer.json()) == (404, {"error": "Chat not found"})
    assert (await api.delete("/chats/t1", headers=ALICE)).status_code == 404


@needs_database
async def test_chats_are_their_users_alone(api, database):
    await api.post("/chats/mine/runs", headers=ALICE, json=run("r1", messages=[{"role": "user", "content": "x"}]))
    # Bob can neither add to Alice's chat nor see, change or delete it; owners don't see others' either.
    taken = await api.post("/chats/mine/runs", headers=BOB, json=run("r2"))
    assert (taken.status_code, taken.json()) == (403, {"error": "This chat belongs to someone else"})
    assert (await api.get("/chats/mine", headers=BOB)).status_code == 404
    assert (await api.get("/chats/mine/runs", headers=BOB)).status_code == 404
    assert (await api.patch("/chats/mine", headers=BOB, json={"name": "x"})).status_code == 404
    assert (await api.delete("/chats/mine", headers=BOB)).status_code == 404
    assert (await api.get("/chats", headers=BOB)).json()["threads"] == []
    await api.post("/chats/his/runs", headers=BOB, json=run("r1"))
    assert [t["id"] for t in (await api.get("/chats", headers=ALICE)).json()["threads"]] == ["mine"]
    # Bob's refused run left nothing behind.
    async with await psycopg.AsyncConnection.connect(database) as conn:
        cur = await conn.execute("SELECT chat_id, run_id FROM chat_runs ORDER BY chat_id")
        assert await cur.fetchall() == [("his", "r1"), ("mine", "r1")]
    # Claude, through a storage token, can't reach chat history at all.
    for method in ("GET", "POST"):
        refused = await api.request(method, "/chats", headers=storage_token("kc|alice"))
        assert (refused.status_code, refused.json()) == (
            403, {"error": "Chat history stays with its user: storage tokens can't reach it"},
        )  # fmt: skip


@needs_database
async def test_pages_agents_and_refusals(api):
    for i in range(5):
        await api.post(f"/chats/c{i}/runs", headers=ALICE, json=run("r", agentId="lab" if i == 2 else "default"))
    first = (await api.get("/chats?limit=2", headers=ALICE)).json()
    assert [t["id"] for t in first["threads"]] == ["c4", "c3"] and first["nextCursor"].endswith("|c3")
    rest = (await api.get("/chats", headers=ALICE, params={"limit": "2", "cursor": first["nextCursor"]})).json()
    assert [t["id"] for t in rest["threads"]] == ["c2", "c1"]
    assert [t["id"] for t in (await api.get("/chats?agent=lab", headers=ALICE)).json()["threads"]] == ["c2"]
    assert len((await api.get("/chats?limit=0", headers=ALICE)).json()["threads"]) == 5  # 0 means the default
    assert len((await api.get("/chats?limit=-3", headers=ALICE)).json()["threads"]) == 1

    def refusal(status: int, message: str):
        return lambda answer: (answer.status_code, answer.json()) == (status, {"error": message})

    shape = "Expected {agentId, runId: string, parentRunId?: string, events, messages: array, name?: string}"
    cases = [
        (await api.get("/chats?cursor=nope", headers=ALICE), refusal(400, "Invalid cursor")),
        (await api.post("/chats", headers=ALICE, json={}), refusal(405, "Method not allowed")),
        (await api.post("/chats/c1/runs", headers=ALICE, json={"agentId": "default"}), refusal(400, shape)),
        (await api.post("/chats/c1/runs", headers=ALICE, content=b"[1]"), refusal(400, shape)),
        (await api.post("/chats/c1/runs", headers=ALICE, json=run("r", parentRunId=3)), refusal(400, shape)),
        (await api.post("/chats/c1/runs", headers=ALICE, json=run("")), refusal(400, "A run needs agentId and runId")),
        (await api.post(f"/chats/{'x' * 201}/runs", headers=ALICE, json=run("r")), refusal(400, "Invalid chat id")),
        (await api.post("/chats/%E0%A4%A/runs", headers=ALICE, json=run("r")), refusal(400, "Malformed chat id")),
        (await api.put("/chats/c1/runs", headers=ALICE, json=run("r")), refusal(405, "Method not allowed")),
        (await api.get("/chats/c1/other", headers=ALICE), refusal(404, "Not found")),
        (await api.put("/chats/c1", headers=ALICE, json={}), refusal(405, "Method not allowed")),
        (
            await api.patch("/chats/c1", headers=ALICE, json={"archived": "yes"}),
            refusal(400, "Expected {name?: string, archived?: boolean}"),
        ),
        (await api.get("/chats/c1", headers={}), refusal(401, "Sign in to use the workspace")),
    ]
    for answer, expected in cases:
        assert expected(answer), (answer.request.method, answer.request.url, answer.status_code, answer.text)
    # A byte order mark before the JSON is fine, as TextDecoder drops it.
    bom = await api.post(
        "/chats/c9/runs", headers=ALICE, content=b'\xef\xbb\xbf{"agentId":"a","runId":"r","events":[],"messages":[]}'
    )
    assert bom.status_code == 201
    # An id with a slash, sent encoded, is one chat.
    assert (await api.post("/chats/a%2Fb/runs", headers=ALICE, json=run("r"))).json()["id"] == "a/b"
    assert (await api.get("/chats/a%2Fb", headers=ALICE)).json()["chat"]["id"] == "a/b"


@needs_database
async def test_without_login_chats_are_the_local_users(database):
    async with Client(database, None) as (api, _):
        assert (await api.post("/chats/t/runs", json=run("r"))).status_code == 201
        assert [t["id"] for t in (await api.get("/chats")).json()["threads"]] == ["t"]
