"""Restricted Knowledge nodes (028_restricted_nodes.sql, docs/restricted-knowledge.md).

Needs TEST_DATABASE_URL and S3_ENDPOINT, as test_files.py.
"""

from __future__ import annotations

import json

import psycopg
import pytest
from support import ALICE, BOB, Client, storage_token, user
from test_experiment_restore import user_id
from test_files import S3_ENDPOINT, SECRET, URL, s3

from api_py.storage import EVENTS_CHANNEL

pytestmark = [pytest.mark.anyio]
needs_services = pytest.mark.skipif(
    not URL or not S3_ENDPOINT, reason="TEST_DATABASE_URL and S3_ENDPOINT are not set"
)

CAROL = user("kc|carol", "Carol")


@pytest.fixture
async def api(database):
    async with Client(database, SECRET, s3=s3()) as (client, _app):
        for who in (ALICE, BOB, CAROL):
            await client.get("/access", headers=who)
        yield client


async def make_node(api, name: str, parent: str | None = None) -> str:
    made = await api.post("/nodes", headers=ALICE, json={"parentId": parent, "name": name})
    assert made.status_code == 201, made.text
    return made.json()["id"]


async def grant(
    api, node: str | None, who: str, role: str, kind: str = "user", headers=ALICE
) -> str:
    made = await api.post(
        "/access/grants",
        headers=headers,
        json={"node": node, "principalType": kind, "principalId": who, "role": role},
    )
    assert made.status_code in (200, 201), made.text
    return made.json()["id"]


async def restrict(api, node: str, on: bool = True, keep: list[str] | None = None, headers=ALICE):
    return await api.put(
        f"/nodes/{node}/restriction", headers=headers, json={"restricted": on, "keep": keep or []}
    )


async def tree(api, headers) -> dict[str, dict]:
    return {n["name"]: n for n in (await api.get("/nodes", headers=headers)).json()["nodes"]}


async def make_admin(api, who: str) -> None:
    workspace = (await api.get("/workspaces", headers=ALICE)).json()["workspaces"][0]["id"]
    changed = await api.patch(
        f"/workspaces/{workspace}/members/{who}", headers=ALICE, json={"role": "admin"}
    )
    assert changed.status_code == 200, changed.text


async def setup(api) -> dict[str, str]:
    """Etch › Secret › Inner, a file in each; Bob views everything, Carol edits Etch."""
    ids = {name: await user_id(api, name) for name in ("Alice", "Bob", "Carol")}
    ids["etch"] = await make_node(api, "Etch")
    ids["secret"] = await make_node(api, "Secret", ids["etch"])
    ids["inner"] = await make_node(api, "Inner", ids["secret"])
    for place in ("secret", "inner"):
        put = await api.put(
            f"/files/notes.md?node={ids[place]}", headers=ALICE, content=place.encode()
        )
        assert put.status_code in (200, 201), put.text
    await grant(api, None, ids["Bob"], "viewer")
    await grant(api, ids["etch"], ids["Carol"], "editor")
    return ids


def reads(api, place: str, headers):
    return api.get(f"/files/notes.md?node={place}", headers=headers)


@needs_services
async def test_restricting_a_node_stops_inherited_access(api):
    ids = await setup(api)
    secret, inner = ids["secret"], ids["inner"]
    assert (await reads(api, secret, BOB)).content == b"secret"

    # The preview says who loses what, and through which grant.
    preview = await api.get(f"/nodes/{secret}/restriction", headers=ALICE)
    assert preview.status_code == 200, preview.text
    body = preview.json()
    assert body["restricted"] is False and body["restrictedBy"] is None
    lose = {c["user"]["name"]: c for c in body["changes"]}
    assert set(lose) == {"Alice", "Bob", "Carol"}
    assert (lose["Bob"]["role"], lose["Bob"]["becomes"], lose["Bob"]["through"]["node"]) == (
        "viewer", None, None,
    )  # fmt: skip
    assert lose["Carol"]["through"]["node"] == {"id": ids["etch"], "name": "Etch"}
    assert lose["Carol"]["through"]["group"] is None

    # Only Full access restricts it, and only people who would lose access can be kept.
    assert (await restrict(api, secret, headers=BOB)).status_code == 403
    assert (await restrict(api, secret, keep=[ids["Bob"], "nope"])).status_code == 400
    assert (await restrict(api, secret, on="yes")).status_code == 400  # type: ignore[arg-type]

    done = await restrict(api, secret, keep=[ids["Carol"]])
    assert done.status_code == 200, done.text
    assert done.json()["restricted"] is True and done.json()["restrictedBy"]["name"] == "Alice"
    # Lifting it would give Bob his access back.
    assert [(c["user"]["name"], c["role"], c["becomes"]) for c in done.json()["changes"]] == [
        ("Bob", None, "viewer")
    ]

    # Bob loses it all; Etch stays.
    for place in (secret, inner):
        assert (await reads(api, place, BOB)).status_code == 404
        assert (await api.get(f"/nodes/{place}", headers=BOB)).status_code == 404
    assert set(await tree(api, BOB)) == {"Etch"}
    # Carol was kept at her role; Alice keeps Full access.
    assert (
        await api.put(f"/files/c.md?node={secret}", headers=CAROL, content=b"c")
    ).status_code in (200, 201)
    assert (await reads(api, inner, ALICE)).content == b"inner"
    shown = await tree(api, CAROL)
    assert shown["Secret"]["restricted"] is True and shown["Secret"]["role"] == "editor"

    # A grant below still works, and shows the path to it.
    await grant(api, inner, ids["Bob"], "viewer")
    shown = await tree(api, BOB)
    assert shown["Secret"]["role"] is None and shown["Secret"]["fileCount"] == 0
    assert shown["Inner"]["role"] == "viewer"
    assert (await reads(api, inner, BOB)).content == b"inner"
    assert (await reads(api, secret, BOB)).status_code == 404

    # A restricted node inside it stops the outer one's grants too.
    assert (await restrict(api, inner, keep=[])).status_code == 200
    assert (await reads(api, inner, CAROL)).status_code == 404
    assert (await reads(api, inner, BOB)).content == b"inner"

    # Lifting the outer one brings Bob's inherited access back there.
    lifted = await restrict(api, secret, on=False)
    assert lifted.status_code == 200 and lifted.json()["restricted"] is False
    assert (await reads(api, secret, BOB)).content == b"secret"
    assert (await reads(api, inner, CAROL)).status_code == 404

    entries = (await api.get("/access/audit?kind=node", headers=ALICE)).json()["entries"]
    by_action = {e["action"]: e["target"] for e in entries}
    assert by_action["node.unrestrict"] == {"node": secret, "gained": [ids["Bob"]]}
    first = [e for e in entries if e["action"] == "node.restrict"][-1]["target"]
    assert first["kept"] == [ids["Carol"]] and first["lost"] == [ids["Bob"]]


@needs_services
async def test_everything_follows_the_boundary(api, database):
    ids = await setup(api)
    secret = ids["secret"]
    await api.put(f"/files/plan.md?node={secret}", headers=ALICE, content=b"The plasma plan")
    made = await api.post("/experiments", headers=BOB, json={"nodeId": secret, "title": "Bob's"})
    assert made.status_code == 201, made.text
    exp = made.json()["id"]
    lose = {
        c["user"]["name"]: c
        for c in (await api.get(f"/nodes/{secret}/restriction", headers=ALICE)).json()["changes"]
    }
    assert lose["Bob"]["experiments"] == 1 and lose["Carol"]["experiments"] == 0

    async with await psycopg.AsyncConnection.connect(database, autocommit=True) as listener:
        await listener.execute(f"LISTEN {EVENTS_CHANNEL}")
        assert (await restrict(api, secret)).status_code == 200
        [event] = [json.loads(n.payload) async for n in listener.notifies(timeout=5, stop_after=1)]
    assert (event["op"], event["change"], event["id"]) == ("node", "restrict", secret)
    assert sorted(event["left"]) == sorted([ids["Bob"], ids["Carol"]])

    # Experiments, search, proposals and Claude all stop at it.
    assert (await api.get(f"/experiments/{exp}", headers=BOB)).status_code == 404
    assert exp not in [
        e["id"] for e in (await api.get("/experiments", headers=BOB)).json()["experiments"]
    ]
    assert (await api.get("/search?q=plasma", headers=BOB)).json()["results"] == []
    assert [
        r["path"] for r in (await api.get("/search?q=plasma", headers=ALICE)).json()["results"]
    ] == ["plan.md"]
    proposed = await api.put(f"/files/plan.md?node={secret}&propose", headers=BOB, content=b"x")
    assert proposed.status_code == 404
    claude = storage_token("kc|bob", via="remote")
    assert (await reads(api, secret, claude)).status_code == 404

    # Row security holds without the app's own check.
    async with await psycopg.AsyncConnection.connect(database) as conn:
        await conn.execute("SET ROLE knowledge_user")
        await conn.execute("SELECT set_config('app.user_id', %s, false)", (ids["Bob"],))
        cur = await conn.execute("SELECT count(*) FROM files WHERE node_id = %s", (secret,))
        assert await cur.fetchone() == (0,)
        cur = await conn.execute("SELECT count(*) FROM nodes WHERE id = %s", (secret,))
        assert await cur.fetchone() == (0,)
        await conn.execute("SELECT set_config('app.user_id', %s, false)", (ids["Alice"],))
        cur = await conn.execute("SELECT count(*) FROM files WHERE node_id = %s", (secret,))
        assert await cur.fetchone() == (2,)
        # Only Full access changes it, even with the route's check skipped.
        await conn.execute("SELECT set_config('app.user_id', %s, false)", (ids["Carol"],))
        await conn.execute("RESET ROLE")
        with pytest.raises(psycopg.errors.RaiseException):
            await conn.execute("UPDATE nodes SET restricted = false WHERE id = %s", (secret,))


@needs_services
async def test_owners_and_admins_manage_around_it(api):
    ids = await setup(api)
    secret = ids["secret"]
    await make_admin(api, ids["Bob"])
    team = (
        await api.post("/access/groups", headers=ALICE, json={"parentId": None, "name": "Team"})
    ).json()["id"]
    await grant(api, secret, team, "viewer", kind="group")
    assert (await restrict(api, secret)).status_code == 200

    # An Admin sees its name and who has access, never its content.
    shown = await tree(api, BOB)
    assert shown["Secret"]["restricted"] is True and shown["Secret"]["role"] is None
    assert shown["Secret"]["fileCount"] == 0 and "Inner" not in shown
    assert (await reads(api, secret, BOB)).status_code == 404
    who = await api.get(f"/nodes/{secret}/access", headers=BOB)
    assert who.status_code == 200, who.text
    assert [(p["user"]["name"], p["role"]) for p in who.json()["people"]] == [("Alice", "owner")]
    # A member without access sees nothing of it.
    assert "Secret" not in await tree(api, CAROL)
    assert (await api.get(f"/nodes/{secret}/access", headers=CAROL)).status_code == 404

    # Adding someone to a group that reaches inside needs Full access there.
    refused = await api.put(f"/access/groups/{team}/members/{ids['Carol']}", headers=BOB)
    assert refused.status_code == 403
    assert "Secret" in refused.json()["error"]
    sub = (
        await api.post("/access/groups", headers=BOB, json={"parentId": team, "name": "Sub"})
    ).json()["id"]
    assert (
        await api.put(f"/access/groups/{sub}/members/{ids['Carol']}", headers=BOB)
    ).status_code == 403
    assert (
        await api.put(f"/access/groups/{team}/members/{ids['Carol']}", headers=ALICE)
    ).status_code == 200
    assert (await reads(api, secret, CAROL)).content == b"secret"
    # Taking access away stays open to Admins.
    assert (
        await api.delete(f"/access/groups/{team}/members/{ids['Carol']}", headers=BOB)
    ).status_code == 200
    assert (await reads(api, secret, CAROL)).status_code == 404

    # The last Full access grant on it stays.
    [mine] = [
        g
        for g in (await api.get(f"/access/grants?node={secret}", headers=ALICE)).json()["grants"]
        if g["principalId"] == ids["Alice"]
    ]
    last = await api.delete(f"/access/grants/{mine['id']}", headers=ALICE)
    assert last.status_code == 400
    assert "needs someone with Full access" in last.json()["error"]
    lowered = await api.post(
        "/access/grants",
        headers=ALICE,
        json={
            "node": secret,
            "principalType": "user",
            "principalId": ids["Alice"],
            "role": "editor",
        },
    )
    assert lowered.status_code == 400

    # Once someone else has it, Alice can go; then, as an Owner, take it back over.
    await grant(api, secret, ids["Carol"], "owner")
    assert (await api.delete(f"/access/grants/{mine['id']}", headers=ALICE)).status_code == 200
    assert (await reads(api, secret, ALICE)).status_code == 404
    assert (await api.post(f"/nodes/{secret}/takeover", headers=BOB)).status_code == 403
    assert (await api.post(f"/nodes/{secret}/takeover", headers=CAROL)).status_code == 403
    took = await api.post(f"/nodes/{secret}/takeover", headers=ALICE)
    assert took.status_code == 200, took.text
    alice = next(p for p in took.json()["people"] if p["user"]["name"] == "Alice")
    assert alice["role"] == "owner" and alice["sources"][0]["takeover"] is True
    assert (await reads(api, secret, ALICE)).content == b"secret"
    entries = (await api.get("/access/audit?kind=node", headers=ALICE)).json()["entries"]
    assert entries[0]["action"] == "node.takeover" and entries[0]["target"] == {"node": secret}
    # Only a restricted node is taken over.
    assert (await api.post(f"/nodes/{ids['etch']}/takeover", headers=ALICE)).status_code == 400


@needs_services
async def test_who_has_access_and_why(api):
    ids = await setup(api)
    etch, secret = ids["etch"], ids["secret"]
    team = (
        await api.post("/access/groups", headers=ALICE, json={"parentId": None, "name": "Team"})
    ).json()["id"]
    await api.put(f"/access/groups/{team}/members/{ids['Carol']}", headers=ALICE)
    await grant(api, etch, team, "viewer", kind="group")

    answer = await api.get(f"/nodes/{secret}/access", headers=ALICE)
    assert answer.status_code == 200, answer.text
    body = answer.json()
    assert body["restricted"] is False and body["inheritanceStopsAt"] is None
    people = {p["user"]["name"]: p for p in body["people"]}
    assert people["Bob"]["role"] == "viewer"
    assert people["Bob"]["sources"][0] | {"since": None} == {
        "role": "viewer", "node": None, "group": None, "takeover": False, "since": None,
    }  # fmt: skip
    # Carol's strongest source first, then the weaker one through her group.
    assert [
        (s["role"], s["node"]["name"], s["group"] and s["group"]["name"])
        for s in people["Carol"]["sources"]
    ] == [
        ("editor", "Etch", None),
        ("viewer", "Etch", "Team"),
    ]
    # Only Full access (or an Owner or Admin) asks.
    assert (await api.get(f"/nodes/{secret}/access", headers=BOB)).status_code == 403

    await restrict(api, secret)
    body = (await api.get(f"/nodes/{ids['inner']}/access", headers=ALICE)).json()
    assert body["inheritanceStopsAt"] == {"id": secret, "name": "Secret"}
    assert [p["user"]["name"] for p in body["people"]] == ["Alice"]


@needs_services
async def test_claude_doesnt_manage_restriction(api):
    ids = await setup(api)
    claude = storage_token("kc|alice", via="remote")
    refusal = {"error": "Claude doesn't manage access"}
    for answer in (
        await api.get(f"/nodes/{ids['secret']}/access", headers=claude),
        await api.get(f"/nodes/{ids['secret']}/restriction", headers=claude),
        await restrict(api, ids["secret"], headers=claude),
        await api.post(f"/nodes/{ids['secret']}/takeover", headers=claude),
    ):
        assert answer.status_code == 403
        assert answer.json() == refusal
    assert (await api.post(f"/nodes/{ids['secret']}/access", headers=ALICE)).status_code == 405
    assert (await api.get(f"/nodes/{ids['secret']}/nope", headers=ALICE)).status_code == 404
