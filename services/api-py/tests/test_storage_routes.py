"""/access and /nodes served by api-py, against a real, migrated Postgres.

Set TEST_DATABASE_URL to a Postgres this test may create databases on; each
test module run gets a new database with the agent server's migrations
applied, as the TypeScript server applies them. The TypeScript server is a
stand-in here that fails the test if a ported route reaches it.
The conformance suite (pnpm test:conformance) checks the same routes against
the spec, through the real TypeScript server.
"""

from __future__ import annotations

import asyncio
import json
import os
import time
import uuid
from collections.abc import AsyncIterator

import httpx
import psycopg
import pytest
from psycopg import conninfo

from api_py import db, tokens
from api_py.app import create_app
from api_py.config import DEFAULT_MIGRATIONS_DIR, Settings
from api_py.storage import EVENTS_CHANNEL

URL = os.environ.get("TEST_DATABASE_URL")
pytestmark = [pytest.mark.anyio, pytest.mark.skipif(not URL, reason="TEST_DATABASE_URL is not set")]
SECRET = "0123456789abcdef0123456789abcdef"


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def migrate(url: str) -> None:
    """What migrate() in apps/agent/src/storage/db.ts does: every migration, recorded."""
    async with await psycopg.AsyncConnection.connect(url, autocommit=True) as conn:
        await conn.execute("CREATE TABLE schema_migrations (name text PRIMARY KEY, applied_at timestamptz DEFAULT now())")
        for name in db.known_migrations(DEFAULT_MIGRATIONS_DIR):
            async with conn.transaction():
                await conn.execute((DEFAULT_MIGRATIONS_DIR / name).read_text())  # type: ignore[arg-type]
                await conn.execute("INSERT INTO schema_migrations (name) VALUES (%s)", (name,))


@pytest.fixture
async def database() -> AsyncIterator[str]:
    name = f"api_py_routes_{uuid.uuid4().hex[:12]}"
    async with await psycopg.AsyncConnection.connect(URL, autocommit=True) as admin:
        await admin.execute(f'CREATE DATABASE "{name}"')
        try:
            url = conninfo.make_conninfo(URL, dbname=name)
            await migrate(url)
            yield url
        finally:
            await admin.execute(f'DROP DATABASE "{name}" WITH (FORCE)')


forwarded: list[str] = []


async def typescript(request: httpx.Request) -> httpx.Response:
    forwarded.append(f"{request.method} {request.url.raw_path.decode().split('?')[0]}")  # as sent

    async def body() -> AsyncIterator[bytes]:  # streamed, as a real connection answers
        yield b'{"from":"typescript"}'

    return httpx.Response(200, headers={"content-type": "application/json"}, content=body())


@pytest.fixture
async def api(database) -> AsyncIterator[httpx.AsyncClient]:
    async with _client(database, SECRET) as (client, _app):
        yield client


class _client:
    def __init__(self, url: str, secret: str | None) -> None:
        self.app = create_app(
            Settings(ts_agent_url="http://ts", database_url=url, auth_secret=secret, migrations_dir=DEFAULT_MIGRATIONS_DIR),
            transport=httpx.MockTransport(typescript),
        )

    async def __aenter__(self):
        forwarded.clear()
        self._life = self.app.router.lifespan_context(self.app)
        await self._life.__aenter__()
        self._http = httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app), base_url="http://api")
        return self._http, self.app

    async def __aexit__(self, *exc):
        await self._http.aclose()
        await self._life.__aexit__(*exc)
        assert not forwarded, f"ported routes reached the TypeScript server: {forwarded}"


def user(sub: str, name: str) -> dict[str, str]:
    claims = {"sub": sub, "email": f"{name.lower()}@example.com", "name": name, "exp": int(time.time()) + 3600}
    return {tokens.IDENTITY_HEADER: tokens.sign(claims, SECRET)}


def storage_token(sub: str, via: str | None = "mcp:lab") -> dict[str, str]:
    claims: dict = {"sub": sub, "exp": int(time.time()) + 3600, "aud": tokens.STORAGE_AUDIENCE}
    if via:
        claims["via"] = via
    return {tokens.STORAGE_HEADER: tokens.sign(claims, SECRET)}


ALICE = user("kc|alice", "Alice")
BOB = user("kc|bob", "Bob")


async def test_without_login_everything_is_the_local_user(database):
    async with _client(database, None) as (api, _):
        me = (await api.get("/access")).json()
        assert me["rootRole"] == "owner"
        assert me["me"]["subject"] == "local"
        tree = (await api.get("/nodes")).json()
        assert tree["rootRole"] == "owner"
        assert [t["name"] for t in tree["types"]] == ["tech", "module", "loop", "process"]
        assert tree["nodes"] == []


async def test_sign_in_first_owner_and_refusals(api):
    assert (await api.get("/nodes")).status_code == 401
    assert (await api.get("/nodes")).json() == {"error": "Sign in to use the workspace"}
    # The first person to sign in owns the workspace; the next has no access.
    assert (await api.get("/access", headers=ALICE)).json()["rootRole"] == "owner"
    bob = (await api.get("/access", headers=BOB)).json()
    assert bob["rootRole"] is None and bob["me"]["name"] == "Bob"
    assert (await api.get("/access/people", headers=BOB)).status_code == 403
    refused = await api.post("/nodes", headers=BOB, json={"parentId": None, "name": "Etch"})
    assert (refused.status_code, refused.json()) == (403, {"error": "You have no access to this workspace"})
    people = (await api.get("/access/people", headers=ALICE)).json()["people"]
    assert [(p["name"], p["role"], p["effectiveRole"]) for p in people] == [("Alice", "owner", "owner"), ("Bob", None, None)]
    assert people[0]["createdAt"].endswith("Z") and len(people[0]["createdAt"]) == 24


async def test_knowledge_tree_and_sharing(api, database):
    async with await psycopg.AsyncConnection.connect(database, autocommit=True) as listener:
        await listener.execute(f"LISTEN {EVENTS_CHANNEL}")
        await api.get("/access", headers=ALICE)
        tech = await api.post("/nodes", headers=ALICE, json={"parentId": None, "name": "  Etch   tech "})
        assert tech.status_code == 201
        tech = tech.json()
        assert (tech["name"], tech["type"], tech["depth"], tech["fileCount"], tech["parentId"]) == (
            "Etch tech",
            "tech",
            1,
            0,
            None,
        )
        heard = await asyncio.wait_for(anext(listener.notifies()), timeout=5)
        event = json.loads(heard.payload)
        assert event == {"op": "node", "change": "create", "id": tech["id"], "workspaceId": event["workspaceId"]}

    mod = (await api.post("/nodes", headers=ALICE, json={"parentId": tech["id"], "name": "Module 3"})).json()
    assert mod["type"] == "module"
    duplicate = await api.post("/nodes", headers=ALICE, json={"parentId": tech["id"], "name": "module 3"})
    assert (duplicate.status_code, duplicate.json()) == (400, {"error": "A node with that name already exists here"})
    assert (await api.post("/nodes", headers=ALICE, json={"name": 1})).status_code == 400
    assert (await api.post("/nodes", headers=ALICE, json={"parentId": 5, "name": "x"})).status_code == 400

    got = (await api.get(f"/nodes/{mod['id']}", headers=ALICE)).json()
    assert [n["name"] for n in got["lineage"]] == ["Etch tech", "Module 3"] and got["node"]["id"] == mod["id"]
    renamed = await api.patch(f"/nodes/{mod['id']}", headers=ALICE, json={"name": "Module X"})
    assert renamed.json()["name"] == "Module X"

    # Bob sees nothing until Alice shares, and then only what she shared, as a viewer.
    bob_id = (await api.get("/access", headers=BOB)).json()["me"]["id"]
    assert (await api.get(f"/nodes/{mod['id']}", headers=BOB)).status_code == 404
    assert (await api.get("/nodes", headers=BOB)).json()["nodes"] == []
    grant = await api.post(
        "/access/grants",
        headers=ALICE,
        json={"node": tech["id"], "principalType": "user", "principalId": bob_id, "role": "viewer"},
    )
    assert grant.status_code == 200
    seen = (await api.get("/nodes", headers=BOB)).json()["nodes"]
    assert [(n["name"], n["role"]) for n in seen] == [("Etch tech", "viewer"), ("Module X", "viewer")]
    no = await api.patch(f"/nodes/{mod['id']}", headers=BOB, json={"name": "Mine"})
    assert (no.status_code, no.json()) == (403, {"error": "You can only view here; this needs editor access"})
    grants = (await api.get(f"/access/grants?node={tech['id']}", headers=ALICE)).json()["grants"]
    assert [(g["principalId"], g["role"]) for g in grants if g["principalType"] == "user"][-1] == (bob_id, "viewer")
    assert (await api.get(f"/access/grants?node={tech['id']}", headers=BOB)).status_code == 403

    assert (await api.delete(f"/access/grants/{grant.json()['id']}", headers=ALICE)).json() == {"ok": True}
    assert (await api.get("/nodes", headers=BOB)).json()["nodes"] == []

    assert (await api.delete(f"/nodes/{tech['id']}", headers=ALICE)).json() == {"deleted": tech["id"]}
    assert (await api.get(f"/nodes/{mod['id']}", headers=ALICE)).status_code == 404
    assert (await api.delete(f"/nodes/{tech['id']}", headers=ALICE)).status_code == 404

    actions = [e["action"] for e in (await api.get("/access/audit?limit=20", headers=ALICE)).json()["entries"]]
    assert actions[:6] == ["node.delete", "grant.revoke", "grant.set", "node.rename", "node.create", "node.create"]
    only = (await api.get("/access/audit?kind=grant&limit=x", headers=ALICE)).json()["entries"]
    assert {e["action"] for e in only} == {"grant.set", "grant.revoke"}


async def test_paths_methods_and_bodies(api):
    await api.get("/access", headers=ALICE)
    # A %2F is part of the id, not a separator, as the TypeScript server reads it.
    assert (await api.get("/nodes/a%2Fb", headers=ALICE)).json() == {"error": "Node not found"}
    assert (await api.put("/nodes", headers=ALICE)).status_code == 405
    assert (await api.post("/access", headers=ALICE)).status_code == 405
    assert (await api.get("/access/nope", headers=ALICE)).json() == {"error": "Not found"}
    assert (await api.post("/nodes", headers=ALICE, content=b"[1]")).status_code == 400
    big = json.dumps({"parentId": None, "name": "x" * (64 * 1024)})
    assert (await api.post("/nodes", headers=ALICE, content=big)).status_code == 400


async def test_groups_and_the_last_owner(api):
    alice = (await api.get("/access", headers=ALICE)).json()["me"]["id"]
    bob = (await api.get("/access", headers=BOB)).json()["me"]["id"]
    made = await api.post("/access/groups", headers=ALICE, json={"parentId": None, "name": "Etch team"})
    assert made.status_code == 201
    group = made.json()["id"]
    again = await api.post("/access/groups", headers=ALICE, json={"parentId": None, "name": "etch TEAM"})
    assert again.json() == {"error": "That name is already taken here"}
    assert (await api.post("/access/groups", headers=BOB, json={"parentId": None, "name": "Nope"})).status_code == 403
    assert (await api.put(f"/access/groups/{group}/members/{bob}", headers=ALICE)).json() == {"ok": True}
    groups = (await api.get("/access/groups", headers=BOB)).json()["groups"]
    assert groups == [{"id": group, "parentId": None, "name": "Etch team", "memberIds": [bob]}]
    assert (await api.patch(f"/access/groups/{group}", headers=ALICE, json={"name": "Etch"})).json() == {"ok": True}
    assert (await api.delete(f"/access/groups/{group}/members/{bob}", headers=ALICE)).json() == {"ok": True}
    assert (await api.delete(f"/access/groups/{group}", headers=ALICE)).json() == {"ok": True}
    assert (await api.delete(f"/access/groups/{group}", headers=ALICE)).status_code == 404

    # The workspace keeps a signed-in owner.
    root = (await api.get("/access/grants", headers=ALICE)).json()["grants"]
    mine = next(g for g in root if g["principalId"] == alice)
    last = await api.delete(f"/access/grants/{mine['id']}", headers=ALICE)
    assert last.json() == {"error": "The workspace needs at least one owner; make someone else owner first"}
    to_bob = {"node": None, "principalType": "user", "principalId": bob, "role": "owner"}
    assert (await api.post("/access/grants", headers=ALICE, json=to_bob)).status_code == 200
    assert (await api.delete(f"/access/grants/{mine['id']}", headers=ALICE)).json() == {"ok": True}
    assert (await api.get("/access", headers=ALICE)).json()["rootRole"] is None


async def test_storage_tokens_act_as_claude_for_the_user(api):
    await api.get("/access", headers=ALICE)
    claude = storage_token("kc|alice")
    assert (await api.get("/access", headers=claude)).json()["rootRole"] == "owner"
    assert (await api.get("/access/users", headers=claude)).json() == {"error": "Claude doesn't manage access"}
    made = await api.post("/nodes", headers=claude, json={"parentId": None, "name": "From Claude"})
    assert made.status_code == 201
    refused = await api.patch(f"/nodes/{made.json()['id']}", headers=claude, json={"name": "x"})
    assert (refused.status_code, refused.json()) == (403, {"error": "Claude doesn't rename or delete nodes"})
    assert (await api.post("/access/groups", headers=claude, json={"parentId": None, "name": "x"})).status_code == 403
    entry = (await api.get("/access/audit?limit=1", headers=ALICE)).json()["entries"][0]
    assert (entry["action"], entry["actorType"], entry["target"]["via"]) == ("node.create", "agent", "mcp:lab")
    # A storage token must name who it is for, and a user token is no storage token.
    assert (await api.get("/nodes", headers=storage_token("kc|alice", via=None))).status_code == 401
    assert (await api.get("/nodes", headers={tokens.STORAGE_HEADER: ALICE[tokens.IDENTITY_HEADER]})).status_code == 401
    # An encoded prefix is no way around those limits: the TypeScript server reads
    # /%61ccess/users as a file path, so it goes there, as do the other spellings.
    for path in ("/%61ccess/users", "/access%2Fusers", "/%6Eodes/x"):
        assert (await api.get(path, headers=claude)).json() == {"from": "typescript"}
    assert forwarded == ["GET /%61ccess/users", "GET /access%2Fusers", "GET /%6Eodes/x"]
    forwarded.clear()


async def test_passes_through_until_the_database_is_migrated():
    name = f"api_py_routes_{uuid.uuid4().hex[:12]}"
    async with await psycopg.AsyncConnection.connect(URL, autocommit=True) as admin:
        await admin.execute(f'CREATE DATABASE "{name}"')
        try:
            client = _client(conninfo.make_conninfo(URL, dbname=name), SECRET)
            async with client as (api, _):
                assert (await api.get("/nodes")).json() == {"from": "typescript"}
                forwarded.clear()
        finally:
            await admin.execute(f'DROP DATABASE "{name}" WITH (FORCE)')


@pytest.mark.parametrize("row_security", [True, False])
async def test_whoever_adds_a_node_owns_it(database, row_security):
    """By the trigger as the restricted role, or by own_new_node() without row security."""
    async with _client(database, SECRET) as (api, app):
        await api.get("/access", headers=ALICE)
        bob = (await api.get("/access", headers=BOB)).json()["me"]["id"]
        assert await app.state.storage_ready()
        app.state.storage.row_security = row_security
        root = {"node": None, "principalType": "user", "principalId": bob, "role": "editor"}
        assert (await api.post("/access/grants", headers=ALICE, json=root)).status_code == 200
        made = (await api.post("/nodes", headers=BOB, json={"parentId": None, "name": f"Bob's {row_security}"})).json()
        assert made["id"]
        # Bob may delete his own node (owner), though he only edits the workspace.
        assert (await api.delete(f"/nodes/{made['id']}", headers=BOB)).json() == {"deleted": made["id"]}
