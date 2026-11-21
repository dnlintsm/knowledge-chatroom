"""The workspace inventory and adding an Owner (issue #255, step 4; platform.py).

The rules any client sees (who may ask, no content, the audit, recovery
without and with `fullAccess`) are in the conformance suite
(packages/contracts/conformance/workspaces.test.ts). These need the database:
sign-in times, departures, groups, local mode and the settings.
"""

from __future__ import annotations

import psycopg
import pytest
from support import SECRET, URL, Client, storage_token, user

from api_py.config import ConfigError, settings_from_env
from api_py.platform import parse_admins

pytestmark = [
    pytest.mark.skipif(not URL, reason="needs TEST_DATABASE_URL"),
    pytest.mark.anyio,
]

ADMIN = user("test|admin", "Admin")
ALICE = user("test|alice", "Alice")
BOB = user("test|bob", "Bob")


async def _id(api, who) -> str:
    return (await api.get("/access", headers=who)).json()["me"]["id"]


async def _lab(api) -> tuple[str, str, str]:
    """Alice's workspace, with Bob as a Member who reads its root; their ids."""
    alice_id, bob_id = await _id(api, ALICE), await _id(api, BOB)
    lab = (await api.post("/workspaces", headers=ALICE, json={"name": "Lab"})).json()["id"]
    added = await api.post(
        f"/workspaces/{lab}/members",
        headers=ALICE,
        json={"userId": bob_id, "role": "member", "access": "viewer"},
    )
    assert added.status_code == 201
    return lab, alice_id, bob_id


async def _entry(api, lab: str, headers=ADMIN) -> dict:
    listed = await api.get("/platform/workspaces", headers=headers)
    assert listed.status_code == 200, listed.text
    return next(w for w in listed.json()["workspaces"] if w["id"] == lab)


async def test_only_the_admins_it_names_by_subject_or_email(database):
    # Nobody is one by default.
    async with Client(database, SECRET) as (api, _app):
        assert (await api.get("/platform/workspaces", headers=ADMIN)).status_code == 403
    async with Client(database, SECRET, platform_admins="ADMIN@example.com, test|alice") as (
        api,
        _app,
    ):
        assert (await api.get("/platform/workspaces", headers=ADMIN)).status_code == 200
        assert (await api.get("/platform/workspaces", headers=ALICE)).status_code == 200
        refused = await api.get("/platform/workspaces", headers=BOB)
        assert refused.status_code == 403 and "PLATFORM_ADMINS" in refused.json()["error"]
        token = await api.get("/platform/workspaces", headers=storage_token("test|admin"))
        assert token.status_code == 403
        assert (await api.get("/platform/nothing", headers=ADMIN)).status_code == 404


async def test_in_local_mode_the_local_user_is_an_admin_and_cant_be_made_an_owner(database):
    async with Client(database, None) as (api, _app):
        listed = await api.get("/platform/workspaces")
        assert listed.status_code == 200
        default = listed.json()["workspaces"][0]
        assert default["slug"] == "default" and default["fullAccessHeld"] is False
        async with await psycopg.AsyncConnection.connect(database) as conn:
            cur = await conn.execute("SELECT id FROM users WHERE subject = 'local'")
            (local,) = await cur.fetchone()  # pyrefly: ignore[not-iterable]
        refused = await api.post(
            f"/platform/workspaces/{default['id']}/owners", json={"userId": str(local)}
        )
        assert refused.status_code == 400


async def test_full_access_held_counts_only_members_who_signed_in_lately(database):
    async with Client(database, SECRET, platform_admins="test|admin", recovery_idle_days=30) as (
        api,
        _app,
    ):
        lab, alice_id, bob_id = await _lab(api)
        entry = await _entry(api, lab)
        assert entry["fullAccessHeld"] is True
        assert [o["id"] for o in entry["owners"]] == [alice_id]
        assert entry["owners"][0]["email"] == "alice@example.com"
        assert entry["owners"][0]["lastSeenAt"].endswith("Z")
        assert entry["memberCount"] == 2 and entry["lastActiveAt"] is not None
        async with await psycopg.AsyncConnection.connect(database, autocommit=True) as conn:
            await conn.execute(
                "UPDATE users SET last_seen_at = now() - interval '31 days' WHERE id = %s",
                (alice_id,),
            )
            assert (await _entry(api, lab))["fullAccessHeld"] is False
        # Through a group counts too, for someone who signed in lately.
        in_lab = {**ALICE, "X-Knowledge-Workspace": lab}
        group = (
            await api.post(
                "/access/groups", headers=in_lab, json={"parentId": None, "name": "Leads"}
            )
        ).json()["id"]
        assert (
            await api.put(f"/access/groups/{group}/members/{bob_id}", headers=in_lab)
        ).status_code == 200
        shared = await api.post(
            "/access/grants",
            headers=in_lab,
            json={"node": None, "principalType": "group", "principalId": group, "role": "owner"},
        )
        assert shared.status_code == 200, shared.text
        assert (await _entry(api, lab))["fullAccessHeld"] is True


async def test_full_access_raises_an_existing_root_grant_and_audits_it(database):
    async with Client(database, SECRET, platform_admins="test|admin") as (api, _app):
        lab, _alice_id, bob_id = await _lab(api)
        admin_id = await _id(api, ADMIN)
        added = await api.post(
            f"/platform/workspaces/{lab}/owners",
            headers=ADMIN,
            json={"userId": bob_id.upper(), "fullAccess": True},
        )
        assert added.status_code == 200, added.text
        assert bob_id in [o["id"] for o in added.json()["workspace"]["owners"]]
        async with await psycopg.AsyncConnection.connect(database) as conn:
            cur = await conn.execute(
                "SELECT role FROM grants WHERE workspace_id = %s AND node_id IS NULL "
                "AND principal_type = 'user' AND principal_id = %s",
                (lab, bob_id),
            )
            assert await cur.fetchall() == [("owner",)]
            cur = await conn.execute(
                "SELECT actor_id::text, action, target FROM audit_log "
                "WHERE workspace_id = %s AND actor_id = %s ORDER BY id",
                (lab, admin_id),
            )
            logged = await cur.fetchall()
        assert [(a, act) for a, act, _ in logged] == [
            (admin_id, "platform.owner"),
            (admin_id, "grant.set"),
        ]
        assert logged[0][2] == {"user": bob_id, "previous": "member"}
        assert logged[1][2]["recovery"] is True and logged[1][2]["principalId"] == bob_id
        # The admin is still no member.
        assert (await api.get(f"/workspaces/{lab}", headers=ADMIN)).status_code == 404


async def test_adding_someone_who_left_clears_their_departure(database):
    async with Client(database, SECRET, platform_admins="test|admin") as (api, _app):
        _lab_id, _alice_id, bob_id = await _lab(api)
        # Bob leaves the default workspace; made its Owner, signing in keeps him there.
        default = (await api.get("/workspaces", headers=BOB)).json()["workspaces"][0]["id"]
        assert (
            await api.delete(f"/workspaces/{default}/members/{bob_id}", headers=BOB)
        ).status_code == 200
        added = await api.post(
            f"/platform/workspaces/{default}/owners", headers=ADMIN, json={"userId": bob_id}
        )
        assert added.status_code == 200
        async with await psycopg.AsyncConnection.connect(database) as conn:
            cur = await conn.execute(
                "SELECT count(*) FROM workspace_departures WHERE workspace_id = %s AND user_id = %s",
                (default, bob_id),
            )
            assert await cur.fetchone() == (0,)
        roles = (await api.get("/workspaces", headers=BOB)).json()["workspaces"]
        assert {"id": default, "role": "owner"}.items() <= roles[0].items()


def test_the_settings():
    assert parse_admins(" A@x.org,  kc|Bob ,,") == frozenset({"a@x.org", "kc|bob"})
    assert parse_admins(None) == frozenset()
    settings = settings_from_env(
        {"AUTH_MODE": "local", "PLATFORM_ADMINS": "a@x.org", "RECOVERY_IDLE_DAYS": "14"}
    )
    assert settings.platform_admins == "a@x.org" and settings.recovery_idle_days == 14
    assert settings_from_env({"AUTH_MODE": "local"}).recovery_idle_days == 90
    for bad in ("0", "-3", "soon"):
        with pytest.raises(ConfigError):
            settings_from_env({"AUTH_MODE": "local", "RECOVERY_IDLE_DAYS": bad})
