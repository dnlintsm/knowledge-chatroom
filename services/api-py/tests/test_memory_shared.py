"""/memory's shared notes, memory packs and overview served by api-py (shared_memory.py, memory_packs.py),
against a real, migrated Postgres. Mirrors apps/agent/src/storage/shared-memory.test.ts and memory-packs.test.ts."""

from __future__ import annotations

from collections.abc import AsyncIterator

import httpx
import pytest
import support
from support import ALICE, BOB, SECRET, URL, Client, user

from api_py.memory import MEMORY_TYPES
from api_py.shared_memory import shared_ref

pytestmark = [pytest.mark.anyio]
needs_database = pytest.mark.skipif(not URL, reason="TEST_DATABASE_URL is not set")
CAROL = user("kc|carol", "Carol")


def note(body: str, description: str = "Lab conventions", **more) -> dict:
    return {"description": description, "type": "reference", "body": body, **more}


@pytest.fixture
async def place(database) -> AsyncIterator[tuple[httpx.AsyncClient, dict]]:
    """Alice owns the workspace; Bob views it, edits node Etch lab and is in group Etch team; Carol has no grants."""
    async with Client(database, SECRET, memory=True, hub_admins="kc|alice") as (api, _app):
        await api.get("/access", headers=ALICE)  # the first to sign in owns the workspace
        bob = (await api.get("/access", headers=BOB)).json()["me"]["id"]
        await api.get("/access", headers=CAROL)
        lab = (
            await api.post("/nodes", headers=ALICE, json={"parentId": None, "name": "Etch lab"})
        ).json()["id"]
        other = (
            await api.post("/nodes", headers=ALICE, json={"parentId": None, "name": "Litho"})
        ).json()["id"]
        for node, role in ((None, "viewer"), (lab, "editor")):
            grant = {"node": node, "principalType": "user", "principalId": bob, "role": role}
            assert (await api.post("/access/grants", headers=ALICE, json=grant)).status_code == 200
        etch = (
            await api.post(
                "/access/groups", headers=ALICE, json={"parentId": None, "name": "Etch team"}
            )
        ).json()
        assert (
            await api.put(f"/access/groups/{etch['id']}/members/{bob}", headers=ALICE)
        ).json() == {"ok": True}
        yield api, {"lab": lab, "other": other, "etch": etch["id"]}


@needs_database
async def test_who_shares_edits_and_proposes(place):
    api, ids = place
    ws = await api.post(
        "/memory/shared", headers=ALICE, json={"scope": "workspace", "name": "units", **note("nm.")}
    )
    assert ws.status_code == 200, ws.text
    assert ws.headers["cache-control"] == "no-store"
    made = ws.json()["note"]
    assert (made["name"], made["version"], made["canEdit"], made["place"]["scope"]) == (
        "units",
        1,
        True,
        "workspace",
    )
    assert ws.json()["proposal"] is None
    seen = (await api.get("/memory", headers=BOB)).json()["shared"]
    assert [(n["name"], n["canEdit"], n["mode"]) for n in seen] == [("units", False, "auto")]
    refused = await api.put(f"/memory/shared/{made['id']}", headers=BOB, json=note("mm."))
    assert (refused.status_code, refused.json()["error"]) == (
        400,
        "Only its place's editors change a shared note; Claude can propose a change",
    )
    assert (await api.get("/memory", headers=CAROL)).json()["shared"] == []
    hidden = await api.get(f"/memory/shared/{made['id']}", headers=CAROL)
    assert (hidden.status_code, hidden.json()) == (
        404,
        {"error": f"No memory named {shared_ref(made['id'])}"},
    )

    # Bob edits his node and his group directly.
    lab = {"scope": "node", "nodeId": ids["lab"]}
    at_lab = (
        await api.post("/memory/shared", headers=BOB, json={**lab, "name": "recipes", **note("B.")})
    ).json()
    assert at_lab["note"]["place"]["label"] == "Etch lab"
    team = {"scope": "group", "groupId": ids["etch"]}
    standup = (
        await api.post(
            "/memory/shared", headers=BOB, json={**team, "name": "standup", **note("9.")}
        )
    ).json()
    assert standup["note"]["place"]["label"] == "Etch team"
    assert (await api.get(f"/memory/shared/{standup['note']['id']}", headers=ALICE)).json()["note"][
        "canEdit"
    ] is True
    outsider = await api.post(
        "/memory/shared", headers=CAROL, json={**team, "name": "x", **note("x")}
    )
    assert (outsider.status_code, outsider.json()) == (
        400,
        {"error": "You can't share to that place"},
    )
    taken = await api.post(
        "/memory/shared", headers=BOB, json={**lab, "name": "recipes", **note("C.")}
    )
    assert (taken.status_code, taken.json()["error"]) == (
        409,
        "There is already a shared note named recipes there",
    )

    # Sharing where you only read is a proposal for the place's editors.
    tip = (
        await api.post(
            "/memory/shared", headers=BOB, json={"scope": "workspace", "name": "tip", **note("T")}
        )
    ).json()
    assert (
        tip["note"] is None
        and tip["proposal"]["mine"] is True
        and tip["proposal"]["canDecide"] is False
    )
    proposals = (await api.get("/memory", headers=ALICE)).json()["sharedProposals"]
    assert [(p["name"], p["canDecide"], p["author"]) for p in proposals] == [("tip", True, "Bob")]
    assert (await api.get("/memory", headers=CAROL)).json()["sharedProposals"] == []
    no = await api.post(f"/memory/shared/proposals/{tip['proposal']['id']}/accept", headers=BOB)
    assert (no.status_code, no.json()) == (
        400,
        {"error": "Only its place's editors decide a proposal"},
    )
    no = await api.post(f"/memory/shared/proposals/{tip['proposal']['id']}/withdraw", headers=ALICE)
    assert (no.status_code, no.json()) == (400, {"error": "Only its author withdraws a proposal"})
    accepted = await api.post(
        f"/memory/shared/proposals/{tip['proposal']['id']}/accept", headers=ALICE
    )
    assert accepted.status_code == 200, accepted.text
    assert (accepted.json()["id"], accepted.json()["status"]) == (tip["proposal"]["id"], "accept")
    shared = (await api.get("/memory", headers=ALICE)).json()["shared"]
    tip_note = next(n for n in shared if n["name"] == "tip")
    versions = (await api.get(f"/memory/shared/{tip_note['id']}", headers=ALICE)).json()["versions"]
    assert versions[0]["changedBy"] == "Bob"
    again = await api.post(
        f"/memory/shared/proposals/{tip['proposal']['id']}/accept", headers=ALICE
    )
    assert (again.status_code, again.json()) == (400, {"error": "No open proposal like that"})


@needs_database
async def test_versions_modes_and_deletes(place):
    api, _ids = place
    made = (
        await api.post(
            "/memory/shared",
            headers=ALICE,
            json={"scope": "workspace", "name": "units", **note("a")},
        )
    ).json()
    note_id = made["note"]["id"]
    changed = await api.put(f"/memory/shared/{note_id}", headers=ALICE, json=note("b", version=1))
    assert changed.json()["note"]["version"] == 2
    stale = await api.put(f"/memory/shared/{note_id}", headers=ALICE, json=note("c", version=1))
    assert (stale.status_code, stale.json()) == (409, {"error": "units changed since"})
    bad = await api.put(f"/memory/shared/{note_id}", headers=ALICE, json=note("c", version=1.5))
    assert (bad.status_code, bad.json()) == (400, {"error": "version is a number"})
    # null is Number(null), 0: no version is 0, so it conflicts.
    assert (
        await api.put(f"/memory/shared/{note_id}", headers=ALICE, json=note("c", version=None))
    ).status_code == 409

    # Modes: an editor sets everyone's; anyone sets their own; null clears it.
    mine = await api.put(f"/memory/shared/{note_id}/mode", headers=BOB, json={"mode": "off"})
    assert mine.json()["note"]["mode"] == "off"
    everyone = await api.put(
        f"/memory/shared/{note_id}/mode", headers=BOB, json={"mode": "off", "everyone": True}
    )
    assert (everyone.status_code, everyone.json()) == (
        400,
        {"error": "Only its place's editors set a shared note for everyone"},
    )
    set_all = await api.put(
        f"/memory/shared/{note_id}/mode", headers=ALICE, json={"mode": "manual", "everyone": True}
    )
    assert (set_all.json()["note"]["everyoneMode"], set_all.json()["note"]["mode"]) == (
        "manual",
        "manual",
    )
    cleared = await api.put(f"/memory/shared/{note_id}/mode", headers=BOB, json={"mode": None})
    assert cleared.json()["note"]["mode"] == "manual"
    bad_mode = await api.put(
        f"/memory/shared/{note_id}/mode", headers=ALICE, json={"mode": "sometimes"}
    )
    assert (bad_mode.status_code, bad_mode.json()) == (
        400,
        {"error": "mode is auto, manual or off"},
    )
    # No mode is null (input.mode ?? null): it clears your own.
    assert (
        await api.put(f"/memory/shared/{note_id}/mode", headers=ALICE, json={})
    ).status_code == 200
    no_everyone = await api.put(
        f"/memory/shared/{note_id}/mode", headers=ALICE, json={"mode": None, "everyone": True}
    )
    assert (no_everyone.status_code, no_everyone.json()) == (
        400,
        {"error": "Say the mode for everyone"},
    )

    assert (await api.delete(f"/memory/shared/{note_id}", headers=BOB)).json() == {
        "error": "Only its place's editors delete a shared note"
    }
    assert (await api.delete(f"/memory/shared/{note_id}", headers=ALICE)).json() == {
        "id": note_id,
        "deleted": True,
    }
    assert (await api.get(f"/memory/shared/{note_id}", headers=ALICE)).status_code == 404

    cases = [
        ("GET", "/memory/shared", None, 404, "Not found"),
        ("PUT", "/memory/shared", {}, 405, "Method not allowed"),
        (
            "POST",
            "/memory/shared",
            {"scope": "team", "name": "x"},
            400,
            "scope is workspace, node or group",
        ),
        ("POST", "/memory/shared", {"scope": "node", "name": "x"}, 400, "Say which node: nodeId"),
        ("POST", "/memory/shared", [1], 400, "Invalid JSON body"),
        ("GET", "/memory/shared/not-an-id", None, 404, "No memory named shared:not-an-id"),
        ("POST", "/memory/shared/proposals/x/maybe", None, 405, "Method not allowed"),
        ("POST", "/memory/shared/proposals/x/accept", None, 404, "No memory named proposal"),
        ("GET", "/memory/shared/a/b/c/d", None, 404, "Not found"),
        ("GET", "/memory/shared/a/b/c/d/e", None, 404, "Not found"),
    ]
    for method, path, body, status, error in cases:
        answer = await api.request(method, path, headers=ALICE, json=body)
        assert (answer.status_code, answer.json()["error"]) == (status, error), (
            method,
            path,
            answer.text,
        )


@needs_database
async def test_the_overview(place):
    api, ids = place
    overview = await api.get(f"/memory?node={ids['lab']}", headers=BOB)
    assert overview.status_code == 200, overview.text
    body = overview.json()
    assert list(body) == [
        "mode",
        "incognito",
        "notes",
        "inbox",
        "shared",
        "sharedProposals",
        "targets",
        "installs",
        "types",
        "limits",
    ]
    assert (body["mode"], body["incognito"], body["notes"], body["inbox"]) == ("on", False, [], [])
    assert sorted(t["scope"] for t in body["targets"]) == ["group", "node", "workspace"]
    assert body["limits"] == {"notes": 200, "body": 16000, "description": 300, "index": 6000}
    assert body["types"] == list(MEMORY_TYPES)
    elsewhere = (await api.get(f"/memory?node={ids['other']}", headers=BOB)).json()["targets"]
    # Bob views Litho through the workspace grant: he can propose there, not edit.
    assert sorted((t["scope"], t["canEdit"]) for t in elsewhere) == [
        ("group", True),
        ("node", False),
        ("workspace", False),
    ]
    assert (await api.get("/memory/", headers=CAROL)).json()["targets"] == []
    assert (await api.get("/memory")).json() == {"error": "Sign in first"}
    assert (await api.post("/memory", headers=ALICE)).status_code == 405


@needs_database
async def test_memory_packs(place):
    api, ids = place
    ws = {"scope": "workspace"}
    lab = {"scope": "node", "nodeId": ids["lab"]}
    empty = await api.post(
        "/memory/packs", headers=ALICE, json={**ws, "name": "glossary", "description": "Terms"}
    )
    assert (empty.status_code, empty.json()) == (
        400,
        {"error": "That place has no notes of its own to publish"},
    )
    await api.post(
        "/memory/shared", headers=ALICE, json={**ws, "name": "film-terms", **note("A stack.")}
    )
    await api.post(
        "/memory/shared", headers=ALICE, json={**ws, "name": "sample-ids", **note("TF-<n>.")}
    )
    viewer = await api.post(
        "/memory/packs", headers=BOB, json={**ws, "name": "glossary", "description": "Terms"}
    )
    assert viewer.json() == {"error": "Only the place's editors publish its notes"}
    published = await api.post(
        "/memory/packs", headers=ALICE, json={**ws, "name": "glossary", "description": "Terms"}
    )
    assert published.json() == {"name": "glossary", "version": 1, "unchanged": False}
    again = await api.post(
        "/memory/packs", headers=ALICE, json={**ws, "name": "glossary", "description": "Terms"}
    )
    assert again.json() == {"name": "glossary", "version": 1, "unchanged": True}
    await api.post("/memory/shared", headers=BOB, json={**lab, "name": "chamber", **note("Hot.")})
    theirs = await api.post(
        "/memory/packs", headers=BOB, json={**lab, "name": "glossary", "description": "Mine"}
    )
    assert (theirs.status_code, theirs.json()) == (
        409,
        {"error": "The pack glossary on the hub was published by someone else"},
    )

    listed = (await api.get("/memory/packs?q=terms", headers=BOB)).json()
    assert [(p["name"], p["latest"]["version"], p["mine"]) for p in listed["packs"]] == [
        ("glossary", 1, False)
    ]
    assert (
        listed["isAdmin"] is False
        and (await api.get("/memory/packs", headers=ALICE)).json()["isAdmin"] is True
    )
    detail = (await api.get("/memory/packs/glossary", headers=BOB)).json()["pack"]
    assert [n["name"] for n in detail["notes"]] == ["film-terms", "sample-ids"]
    missing = await api.get("/memory/packs/glossary?version=9", headers=BOB)
    assert (missing.status_code, missing.json()) == (
        404,
        {"error": "No memory named pack glossary version 9"},
    )
    assert (await api.get("/memory/packs/glossary?version=1.5", headers=BOB)).status_code == 400

    # Installing: notes are the pack's, read-only and Manual.
    no = await api.post("/memory/packs/glossary/install", headers=CAROL, json=lab)
    assert no.json() == {"error": "Installing a memory pack needs edit access to the place"}
    install = (await api.post("/memory/packs/glossary/install", headers=BOB, json=lab)).json()[
        "install"
    ]
    assert (install["version"], install["notes"], install["canEdit"]) == (1, 2, True)
    at_lab = [
        n
        for n in (await api.get("/memory", headers=BOB)).json()["shared"]
        if n["place"]["nodeId"] == ids["lab"]
    ]
    terms = next(n for n in at_lab if n["name"] == "film-terms")
    assert terms["pack"] == {"installId": install["id"], "name": "glossary", "version": 1}
    assert terms["everyoneMode"] == "manual"
    locked = await api.put(f"/memory/shared/{terms['id']}", headers=BOB, json=note("Changed"))
    assert "memory pack glossary" in locked.json()["error"]
    installs = (await api.get("/memory", headers=BOB)).json()["installs"]
    assert [(i["id"], i["name"]) for i in installs] == [(install["id"], "glossary")]

    # Yank and verify (hub admins); a yanked version can't be newly installed.
    assert (
        await api.post("/memory/packs/glossary/yank", headers=BOB, json={"version": 1})
    ).json() == {"error": "Only its publisher or a hub admin yanks a version"}
    assert (await api.post("/memory/packs/glossary/yank", headers=ALICE, json={})).json() == {
        "error": "Say which version"
    }
    yanked = await api.post(
        "/memory/packs/glossary/yank", headers=ALICE, json={"version": 1, "reason": "Wrong"}
    )
    assert (
        yanked.json()["pack"]["version"]["yanked"],
        yanked.json()["pack"]["version"]["yankReason"],
    ) == (
        True,
        "Wrong",
    )
    refused = await api.post(
        "/memory/packs/glossary/install", headers=ALICE, json={**ws, "version": 1}
    )
    assert refused.json() == {"error": "Version 1 of glossary was yanked: Wrong"}
    # With no version, the latest one not yanked: none.
    none_left = await api.post("/memory/packs/glossary/install", headers=ALICE, json=ws)
    assert (none_left.status_code, none_left.json()) == (
        404,
        {"error": "No memory named pack glossary"},
    )
    await api.post(
        "/memory/packs/glossary/yank", headers=ALICE, json={"version": 1, "yanked": False}
    )
    assert (
        await api.post("/memory/packs/glossary/verify", headers=BOB, json={"version": 1})
    ).json() == {"error": "Only hub admins verify packs"}
    verified = await api.post("/memory/packs/glossary/verify", headers=ALICE, json={"version": "1"})
    assert verified.json()["pack"]["version"]["verified"] is True
    assert (
        await api.post("/memory/packs/glossary/other", headers=ALICE, json={"version": 1})
    ).status_code == 404
    assert (await api.put("/memory/packs/glossary", headers=ALICE, json={})).status_code == 405

    # Forking makes the notes the place's own; uninstalling a fork's install removes nothing more.
    assert (await api.delete(f"/memory/installs/{install['id']}", headers=CAROL)).json() == {
        "error": "Only the place's editors change its packs"
    }
    assert (await api.delete("/memory/installs/not-an-id", headers=BOB)).json() == {
        "error": "No memory named pack install"
    }
    forked = await api.post(f"/memory/installs/{install['id']}/fork", headers=BOB)
    assert forked.json() == {"id": install["id"], "notes": 2}
    owned = await api.put(f"/memory/shared/{terms['id']}", headers=BOB, json=note("Ours now"))
    assert owned.status_code == 200, owned.text
    assert (await api.get("/memory", headers=BOB)).json()["installs"] == []
    reinstalled = (await api.post("/memory/packs/glossary/install", headers=ALICE, json=ws)).json()
    assert "already has notes named" in reinstalled["error"]
    # A fresh install elsewhere, then uninstalled with its notes.
    team = {"scope": "group", "groupId": ids["etch"]}
    second = (await api.post("/memory/packs/glossary/install", headers=BOB, json=team)).json()[
        "install"
    ]
    gone = await api.delete(f"/memory/installs/{second['id']}", headers=BOB)
    assert gone.json() == {"id": second["id"], "deleted": True}
    assert not [
        n
        for n in (await api.get("/memory", headers=BOB)).json()["shared"]
        if n["place"]["scope"] == "group"
    ]


@needs_database
async def test_the_agent_api_stays_with_typescript(place):
    api, _ids = place
    for method, path in [
        ("GET", "/memory/agent"),
        ("GET", "/memory/%zz"),
    ]:
        assert (await api.request(method, path, headers=ALICE)).json() == {"from": "typescript"}, (
            path
        )
    assert support.forwarded == ["GET /memory/agent", "GET /memory/%zz"]
    support.forwarded.clear()
