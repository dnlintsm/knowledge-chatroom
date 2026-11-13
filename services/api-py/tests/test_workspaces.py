"""Workspace memberships (issue #226): the backfill, the one-time owner bootstrap and selectors.

The isolation rules across two workspaces are in the conformance suite
(packages/contracts/conformance/workspaces.test.ts); these need the database
before and after the migration, or many sign-ins at once.
"""

from __future__ import annotations

import asyncio
import base64
import json
import uuid
from collections.abc import AsyncIterator

import psycopg
import pytest
from psycopg import conninfo
from support import SECRET, URL, Client, user

from api_py import db
from api_py.access import AccessService
from api_py.config import DEFAULT_MIGRATIONS_DIR

pytestmark = [
    pytest.mark.skipif(not URL, reason="needs TEST_DATABASE_URL"),
    pytest.mark.anyio,
]
MEMBERSHIPS = "023_workspace_members.sql"


async def _apply(conn: psycopg.AsyncConnection, name: str) -> None:
    async with conn.transaction():
        await conn.execute((DEFAULT_MIGRATIONS_DIR / name).read_text())  # type: ignore[arg-type]
        await conn.execute("INSERT INTO schema_migrations (name) VALUES (%s)", (name,))


@pytest.fixture
async def before() -> AsyncIterator[tuple[str, psycopg.AsyncConnection]]:
    """A database with every migration before the memberships, and a connection to it."""
    name = f"api_py_ws_{uuid.uuid4().hex[:12]}"
    async with await psycopg.AsyncConnection.connect(URL, autocommit=True) as admin:  # pyrefly: ignore[bad-argument-type]
        await admin.execute(f'CREATE DATABASE "{name}"')  # pyrefly: ignore[bad-argument-type]
        try:
            url = conninfo.make_conninfo(URL, dbname=name)  # pyrefly: ignore[bad-argument-type]
            async with await psycopg.AsyncConnection.connect(url, autocommit=True) as conn:
                await conn.execute(
                    "CREATE TABLE schema_migrations (name text PRIMARY KEY, applied_at timestamptz DEFAULT now())"
                )
                for migration in db.known_migrations(DEFAULT_MIGRATIONS_DIR):
                    if migration == MEMBERSHIPS:
                        break
                    await _apply(conn, migration)
                yield url, conn
        finally:
            await admin.execute(f'DROP DATABASE "{name}" WITH (FORCE)')  # pyrefly: ignore[bad-argument-type]


async def _one(conn: psycopg.AsyncConnection, query: str, *params) -> object:
    cur = await conn.execute(query, params)  # pyrefly: ignore[bad-argument-type]
    row = await cur.fetchone()
    return row[0] if row else None


async def _user(conn: psycopg.AsyncConnection, subject: str) -> str:
    return str(
        await _one(
            conn, "INSERT INTO users (subject, name) VALUES (%s, %s) RETURNING id", subject, subject
        )
    )


async def _rights(conn: psycopg.AsyncConnection, ws: str) -> list[tuple]:
    """Every user's effective role on the root and on every node: what the backfill must not change."""
    cur = await conn.execute(
        """
        SELECT u.subject, n.name, effective_role(%(ws)s, u.id, n.id)
        FROM users u CROSS JOIN (SELECT id, name FROM nodes UNION ALL SELECT NULL, '(root)') n
        ORDER BY 1, 2""",
        {"ws": ws},
    )
    return await cur.fetchall()


async def test_backfill_keeps_effective_access_and_records_the_bootstrap(before):
    _, conn = before
    ws = str(await _one(conn, "SELECT id FROM workspaces WHERE slug = 'default'"))
    direct = await _user(conn, "test|direct-owner")
    nested = await _user(conn, "test|nested-owner")
    node_only = await _user(conn, "test|node-only")
    chats_only = await _user(conn, "test|chats-only")
    await _user(conn, "test|nothing")
    tech = await _one(
        conn,
        """
        INSERT INTO nodes (workspace_id, type_id, parent_id, name)
        SELECT %s, id, NULL, 'Etch' FROM node_types WHERE workspace_id = %s AND depth = 1 RETURNING id""",
        ws,
        ws,
    )
    # A root owner grant to a parent group reaches members of its sub-group.
    org = await _one(
        conn, "INSERT INTO groups (workspace_id, name) VALUES (%s, 'Org') RETURNING id", ws
    )
    team = await _one(
        conn,
        "INSERT INTO groups (workspace_id, parent_id, name) VALUES (%s, %s, 'Team') RETURNING id",
        ws,
        org,
    )
    await conn.execute(
        "INSERT INTO group_members (group_id, user_id) VALUES (%s, %s)", (team, nested)
    )
    grants = [
        (None, "user", direct, "owner"),
        (None, "group", org, "owner"),
        (tech, "user", node_only, "viewer"),
    ]
    for node, ptype, pid, role in grants:
        await conn.execute(
            "INSERT INTO grants (workspace_id, node_id, principal_type, principal_id, role) VALUES (%s, %s, %s, %s, %s)",
            (ws, node, ptype, pid, role),
        )
    await conn.execute(
        "INSERT INTO chats (id, workspace_id, user_id, agent_id) VALUES ('c1', %s, %s, 'default')",
        (ws, chats_only),
    )
    rights = await _rights(conn, ws)
    grant_rows = await (await conn.execute("SELECT * FROM grants ORDER BY id")).fetchall()

    await _apply(conn, MEMBERSHIPS)

    cur = await conn.execute(
        """
        SELECT u.subject, m.role FROM workspace_members m JOIN users u ON u.id = m.user_id
        WHERE m.workspace_id = %s ORDER BY u.subject""",
        (ws,),
    )
    assert await cur.fetchall() == [
        ("local", "owner"),
        ("test|chats-only", "member"),
        ("test|direct-owner", "owner"),
        ("test|nested-owner", "owner"),
        ("test|node-only", "member"),
    ]
    assert await _rights(conn, ws) == rights
    assert await (await conn.execute("SELECT * FROM grants ORDER BY id")).fetchall() == grant_rows
    assert await _one(
        conn, "SELECT auth_bootstrapped_at IS NOT NULL FROM workspaces WHERE id = %s", ws
    )

    # Running the backfill's statements again changes nothing.
    async with conn.transaction():
        await conn.execute(
            "INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (%s, %s, 'member') ON CONFLICT DO NOTHING",
            (ws, direct),
        )
    assert (
        await _one(
            conn,
            "SELECT role FROM workspace_members WHERE workspace_id = %s AND user_id = %s",
            ws,
            direct,
        )
        == "owner"
    )


async def test_a_database_only_the_local_user_owns_stays_open_for_the_first_sign_in(before):
    url, conn = before
    await _apply(conn, MEMBERSHIPS)
    ws = str(await _one(conn, "SELECT id FROM workspaces WHERE slug = 'default'"))
    assert await _one(conn, "SELECT auth_bootstrapped_at FROM workspaces WHERE id = %s", ws) is None

    pool = db.open_pool(url)
    await pool.open()
    try:
        access = AccessService(pool, ws)
        # Concurrent first sign-ins: exactly one becomes the owner.
        ids = await asyncio.gather(*(access.user_for_subject(f"test|first-{i}") for i in range(8)))
        cur = await conn.execute(
            """
            SELECT m.user_id::text, m.role, effective_role(m.workspace_id, m.user_id, NULL)
            FROM workspace_members m WHERE m.workspace_id = %s AND m.user_id = ANY(%s::uuid[])""",
            (ws, ids),
        )
        rows = await cur.fetchall()
        owners = [r for r in rows if r[1] == "owner"]
        assert len(owners) == 1 and owners[0][2] == "owner"
        # Everyone else is a Member of the default workspace (until the cut-off), with no access.
        assert sorted(r[1] for r in rows) == ["member"] * 7 + ["owner"]
        assert all(r[2] is None for r in rows if r[1] == "member")
        assert await _one(
            conn, "SELECT auth_bootstrapped_at IS NOT NULL FROM workspaces WHERE id = %s", ws
        )

        # Later sign-ins get no ownership, even after the bootstrap owner is gone.
        await conn.execute(
            "DELETE FROM grants WHERE workspace_id = %s AND principal_id = %s::uuid",
            (ws, owners[0][0]),
        )
        later = await access.user_for_subject("test|later")
        assert (
            await _one(
                conn,
                "SELECT role FROM workspace_members WHERE workspace_id = %s AND user_id = %s",
                ws,
                later,
            )
            == "member"
        )
        assert await _one(conn, "SELECT effective_role(%s, %s, NULL)", ws, later) is None
    finally:
        await pool.close()


async def test_the_last_owner_stays(before):
    _, conn = before
    await _apply(conn, MEMBERSHIPS)
    ws = await _one(conn, "SELECT id FROM workspaces WHERE slug = 'default'")
    with pytest.raises(psycopg.errors.RaiseException, match="at least one owner"):
        await conn.execute(
            "UPDATE workspace_members SET role = 'member' WHERE workspace_id = %s", (ws,)
        )


async def test_a_new_workspace_never_bootstraps_and_signing_in_joins_nothing_else(database):
    async with Client(database, SECRET) as (api, _app):
        alice, bob = user("test|alice", "Alice"), user("test|bob", "Bob")
        assert (await api.get("/access", headers=alice)).json()["rootRole"] == "owner"
        lab = (await api.post("/workspaces", headers=alice, json={"name": "Lab"})).json()
        assert lab["slug"] == "lab" and lab["role"] == "owner"
        again = (await api.post("/workspaces", headers=alice, json={"name": "Lab"})).json()
        assert again["slug"] == "lab-2"
        mine = (await api.get("/workspaces", headers=bob)).json()["workspaces"]
        assert [w["slug"] for w in mine] == ["default"]
        assert (
            await api.get("/nodes", headers={**bob, "X-Knowledge-Workspace": lab["id"]})
        ).status_code == 404
        # The new workspace has its levels, and its creator Full access on its root.
        here = {**alice, "X-Knowledge-Workspace": lab["id"]}
        tree = (await api.get("/nodes", headers=here)).json()
        assert [t["name"] for t in tree["types"]] == ["tech", "module", "loop", "process"]
        assert tree["rootRole"] == "owner"
        bare = (
            await api.post("/workspaces", headers=alice, json={"name": "Bare", "levels": []})
        ).json()
        tree = (
            await api.get("/nodes", headers={**alice, "X-Knowledge-Workspace": bare["id"]})
        ).json()
        assert tree["types"] == []


async def test_grants_and_groups_are_for_members(database):
    async with Client(database, SECRET) as (api, _app):
        alice, bob = user("test|alice", "Alice"), user("test|bob", "Bob")
        await api.get("/access", headers=alice)
        bob_id = (await api.get("/access", headers=bob)).json()["me"]["id"]
        lab = (await api.post("/workspaces", headers=alice, json={"name": "Lab"})).json()
        here = {**alice, "X-Knowledge-Workspace": lab["id"]}
        share = {"node": None, "principalType": "user", "principalId": bob_id, "role": "viewer"}
        refused = await api.post("/access/grants", headers=here, json=share)
        assert refused.status_code == 400 and "member" in refused.json()["error"]
        group = (
            await api.post("/access/groups", headers=here, json={"parentId": None, "name": "Team"})
        ).json()["id"]
        assert (
            await api.put(f"/access/groups/{group}/members/{bob_id}", headers=here)
        ).status_code == 400
        added = await api.post(
            f"/workspaces/{lab['id']}/members",
            headers=alice,
            json={"userId": bob_id, "role": "admin", "access": "none"},
        )
        assert added.status_code == 201
        grant = (await api.post("/access/grants", headers=here, json=share)).json()["id"]
        # An Admin manages groups and reads the audit log, like an Owner.
        as_admin = {**bob, "X-Knowledge-Workspace": lab["id"]}
        assert (
            await api.put(f"/access/groups/{group}/members/{bob_id}", headers=as_admin)
        ).status_code == 200
        entries = (await api.get("/access/audit", headers=as_admin)).json()["entries"]
        assert {"workspace.create", "member.add", "group.add_member"} <= {
            e["action"] for e in entries
        }

        # Without access to a target, an Admin sees its ids, not its name.
        assert (await api.delete(f"/access/grants/{grant}", headers=here)).status_code == 200
        node = (
            await api.post("/nodes", headers=here, json={"parentId": None, "name": "Secret"})
        ).json()["id"]
        entries = (await api.get("/access/audit", headers=as_admin)).json()["entries"]
        created = next(e for e in entries if e["action"] == "node.create")
        assert created["target"] == {"node": node, "parent": None, "redacted": True}
        own = (await api.get("/access/audit", headers=here)).json()["entries"]
        assert next(e for e in own if e["action"] == "node.create")["target"]["name"] == "Secret"
        renamed = next(e for e in entries if e["action"] == "group.create")
        assert renamed["target"]["name"] == "Team"


async def test_requests_for_the_typescript_server_stay_in_the_default_workspace(database):
    """Until it takes the workspace from the run (step 4b), also for unsigned local memory tokens."""
    other = "0b8f6c2e-3d1a-4f5b-9c7e-2a4d6e8f0a1b"
    claims = {"via": "mcp:lab", "thread": "t1", "node": None, "ws": other}
    local = "local." + base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip("=")
    async with Client(database, None) as (api, _app):
        refused = await api.get("/memory/agent", headers={"X-Knowledge-Memory": local})
        assert refused.status_code == 400
        assert (
            await api.get("/memory/agent", headers={"X-Knowledge-Workspace": other})
        ).status_code == 400
