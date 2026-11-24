"""Undoing an experiment's delete (027_experiment_restore.sql).

Needs TEST_DATABASE_URL and S3_ENDPOINT, as test_files.py. docs/run-evidence.md,
"Recovering a deleted Experiment", says what these routes promise.
"""

from __future__ import annotations

import pytest
from support import ALICE, BOB, Client, storage_token, user
from test_experiments import audit, bob_id, node
from test_files import S3_ENDPOINT, SECRET, URL, s3

pytestmark = [pytest.mark.anyio]
needs_services = pytest.mark.skipif(
    not URL or not S3_ENDPOINT, reason="TEST_DATABASE_URL and S3_ENDPOINT are not set"
)

CAROL = user("kc|carol", "Carol")


@pytest.fixture
async def api(database):
    async with Client(database, SECRET, s3=s3()) as (client, _app):
        yield client


async def deleted(api, headers=ALICE) -> list[dict]:
    answer = await api.get("/experiments?deleted=1", headers=headers)
    assert answer.status_code == 200, answer.text
    return answer.json()["experiments"]


async def make(api, place: str | None, title: str, headers=ALICE, status: str = "draft") -> str:
    made = await api.post("/experiments", headers=headers, json={"nodeId": place, "title": title})
    assert made.status_code == 201, made.text
    if status != "draft":
        changed = await api.patch(
            f"/experiments/{made.json()['id']}", headers=headers, json={"status": status}
        )
        assert changed.status_code == 200, changed.text
    return made.json()["id"]


async def view_everything(api, who: str) -> None:
    granted = await api.post(
        "/access/grants",
        headers=ALICE,
        json={"node": None, "principalType": "user", "principalId": who, "role": "viewer"},
    )
    assert granted.status_code in (200, 201), granted.text


async def user_id(api, name: str) -> str:
    users = (await api.get("/access/users", headers=ALICE)).json()["users"]
    return next(u["id"] for u in users if u["name"] == name)


@needs_services
async def test_a_maintainer_restores_their_draft_with_its_files(api):
    await api.get("/access", headers=ALICE)
    etch = await node(api)
    exp = await make(api, etch, "Etch rate")
    here = f"experiment={exp}"
    await api.put(f"/files/notes.md?{here}", headers=ALICE, content=b"keep")
    await api.put(f"/files/scratch.md?{here}", headers=ALICE, content=b"gone")
    # Deleted before the experiment: it stays deleted.
    assert (await api.delete(f"/files/scratch.md?{here}", headers=ALICE)).status_code == 200
    await api.patch(f"/experiments/{exp}", headers=ALICE, json={"state": "running"})
    assert await deleted(api) == []

    assert (await api.delete(f"/experiments/{exp}", headers=ALICE)).status_code == 200
    [listed] = await deleted(api)
    assert listed["id"] == exp and listed["title"] == "Etch rate"
    assert listed["deletedBy"]["name"] == "Alice" and listed["deletedAt"].endswith("Z")
    assert listed["restorable"] is True and listed["fileCount"] >= 1
    assert listed["access"] == "writer" and listed["mine"] is True
    assert (await api.get(f"/experiments/{exp}", headers=ALICE)).status_code == 404

    restored = await api.post(f"/experiments/{exp}/restore", headers=ALICE)
    assert restored.status_code == 200, restored.text
    body = restored.json()
    assert body["id"] == exp and body["status"] == "draft" and body["state"] == "running"
    assert "deletedAt" not in body
    assert (await api.get(f"/files/notes.md?{here}", headers=ALICE)).content == b"keep"
    assert (await api.get(f"/files/scratch.md?{here}", headers=ALICE)).status_code == 404
    assert await deleted(api) == []
    [entry] = [e for e in await audit(api) if e["action"] == "experiment.restore"]
    assert entry["target"] == {"experiment": exp}

    # A live one, or a made-up id, isn't there to restore.
    for wrong in (exp, "00000000-0000-4000-8000-000000000000", "nope"):
        assert (await api.post(f"/experiments/{wrong}/restore", headers=ALICE)).status_code == 404
    assert (await api.get(f"/experiments/{exp}/restore", headers=ALICE)).status_code == 405


@needs_services
async def test_an_admin_restores_shared_ones_but_never_sees_drafts(api):
    await api.get("/access", headers=ALICE)
    await api.get("/access", headers=BOB)
    await api.get("/access", headers=CAROL)
    bob, carol = await bob_id(api), await user_id(api, "Carol")
    for who in (bob, carol):
        await view_everything(api, who)
    workspace = (await api.get("/workspaces", headers=ALICE)).json()["workspaces"][0]["id"]
    made_admin = await api.patch(
        f"/workspaces/{workspace}/members/{bob}", headers=ALICE, json={"role": "admin"}
    )
    assert made_admin.status_code == 200, made_admin.text

    draft = await make(api, None, "Private")
    shared = await make(api, None, "Shared", status="shared")
    added = await api.put(f"/experiments/{shared}/collaborators/{carol}", headers=ALICE)
    assert added.status_code == 200, added.text
    for exp in (draft, shared):
        assert (await api.delete(f"/experiments/{exp}", headers=ALICE)).status_code == 200

    assert [e["id"] for e in await deleted(api)] == [shared, draft]
    [seen] = await deleted(api, BOB)
    assert seen["id"] == shared and seen["mine"] is False and seen["access"] == "reader"
    # A collaborator doesn't restore it.
    assert await deleted(api, CAROL) == []
    assert (await api.post(f"/experiments/{shared}/restore", headers=CAROL)).status_code == 404
    assert (await api.post(f"/experiments/{draft}/restore", headers=BOB)).status_code == 404

    restored = await api.post(f"/experiments/{shared}/restore", headers=BOB)
    assert restored.status_code == 200, restored.text
    # Its maintainer is still a member, so it stays theirs.
    assert restored.json()["maintainerId"] != bob and restored.json()["mine"] is False
    assert [c["name"] for c in restored.json()["collaborators"]] == ["Carol"]
    assert [e["id"] for e in await deleted(api)] == [draft]


@needs_services
async def test_one_deleted_with_its_node_cant_come_back_alone(api):
    await api.get("/access", headers=ALICE)
    etch = await node(api)
    exp = await make(api, etch, "Etch rate")
    assert (await api.delete(f"/nodes/{etch}", headers=ALICE)).status_code == 200
    [listed] = await deleted(api)
    assert listed["id"] == exp and listed["restorable"] is False and listed["deletedBy"] is None
    refused = await api.post(f"/experiments/{exp}/restore", headers=ALICE)
    assert refused.status_code == 409
    assert refused.json() == {"error": "Its place was deleted, so it can't be restored"}


@needs_services
async def test_a_departed_maintainers_experiment_goes_to_whoever_restores_it(api):
    await api.get("/access", headers=ALICE)
    await api.get("/access", headers=BOB)
    bob = await bob_id(api)
    await view_everything(api, bob)
    shared = await make(api, None, "Bob's", headers=BOB, status="shared")
    draft = await make(api, None, "Bob's draft", headers=BOB)
    for exp in (shared, draft):
        assert (await api.delete(f"/experiments/{exp}", headers=BOB)).status_code == 200
    workspace = (await api.get("/workspaces", headers=BOB)).json()["workspaces"][0]["id"]
    left = await api.delete(f"/workspaces/{workspace}/members/{bob}", headers=BOB)
    assert left.status_code == 200, left.text

    # The Owner sees the shared one; the draft was Bob's alone and stays deleted.
    [listed] = await deleted(api)
    assert listed["id"] == shared and listed["maintainerIsMember"] is False
    restored = await api.post(f"/experiments/{shared}/restore", headers=ALICE)
    assert restored.status_code == 200, restored.text
    body = restored.json()
    assert body["mine"] is True and body["maintainerName"] == "Alice"
    assert body["authorId"] == bob
    [entry] = [e for e in await audit(api) if e["action"] == "experiment.restore"]
    alice = await user_id(api, "Alice")
    assert entry["target"] == {"experiment": shared, "from": bob, "user": alice}
    assert (await api.post(f"/experiments/{draft}/restore", headers=ALICE)).status_code == 404


@needs_services
async def test_claude_doesnt_list_or_restore_deleted_experiments(api):
    await api.get("/access", headers=ALICE)
    exp = await make(api, None, "Etch")
    await api.delete(f"/experiments/{exp}", headers=ALICE)
    claude = storage_token("kc|alice", via="remote")
    refusal = {"error": "Claude doesn't list or restore deleted experiments"}
    for answer in (
        await api.get("/experiments?deleted=1", headers=claude),
        await api.post(f"/experiments/{exp}/restore", headers=claude),
    ):
        assert answer.status_code == 403
        assert answer.json() == refusal
    # Its ordinary list is still Claude's to read.
    assert (await api.get("/experiments", headers=claude)).status_code == 200


@needs_services
async def test_the_deleted_list_is_asked_for_on_its_own(api):
    await api.get("/access", headers=ALICE)
    both = await api.get("/experiments?deleted=1&node=root", headers=ALICE)
    assert both.status_code == 400
    assert both.json() == {"error": "Ask for ?deleted or for one ?node, not both"}
    assert (await api.get("/experiments?deleted=yes", headers=ALICE)).status_code == 400
    assert (await api.get("/experiments?deleted", headers=ALICE)).status_code == 200
