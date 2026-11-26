"""Pipelines (docs/pipeline-identities.md): keys that act for their owner, narrowed.

Needs TEST_DATABASE_URL and S3_ENDPOINT, as test_files.py.
"""

from __future__ import annotations

import asyncio
import dataclasses
import hashlib
import uuid

import psycopg
import pytest
from support import ALICE, BOB, Client, storage_token, user
from test_experiment_restore import user_id
from test_files import S3_ENDPOINT, SECRET, URL, s3
from test_proposals import meta, upload
from test_restricted_nodes import grant, make_node

pytestmark = [pytest.mark.anyio]
CAROL = user("kc|carol", "Carol")
needs_services = pytest.mark.skipif(
    not URL or not S3_ENDPOINT, reason="TEST_DATABASE_URL and S3_ENDPOINT are not set"
)


@pytest.fixture
async def api_and_app(database):
    async with Client(database, SECRET, s3=s3(), pipelines=True) as (client, app):
        for who in (ALICE, BOB, CAROL):
            await client.get("/access", headers=who)
        yield client, app


@pytest.fixture
def api(api_and_app):
    return api_and_app[0]


def key(secret: str) -> dict[str, str]:
    """A pipeline's key as the web app forwards it."""
    return {"X-Knowledge-Pipeline": secret}


async def make(api, headers=ALICE, **body) -> dict:
    made = await api.post(
        "/pipelines",
        headers=headers,
        json={"name": "Nightly import", "places": None, "operations": ["read"], **body},
    )
    assert made.status_code == 201, made.text
    return made.json()


async def files_in(api, node: str | None, headers) -> int:
    where = f"?node={node}" if node else ""
    return (await api.get(f"/files{where}", headers=headers)).status_code


@needs_services
async def test_a_key_is_shown_once_and_only_its_hash_is_kept(api, database):
    made = await make(api)
    secret = made["key"]["secret"]
    assert secret.startswith("kcp_") and len(secret) == 47
    assert made["key"]["hint"] == secret[-4:]
    pipeline = made["pipeline"]
    assert (pipeline["status"], pipeline["operations"], pipeline["places"]) == (
        "active",
        ["read"],
        None,
    )
    listed = (await api.get("/pipelines", headers=ALICE)).json()["pipelines"]
    assert [p["id"] for p in listed] == [pipeline["id"]]
    assert "secret" not in listed[0]["keys"][0]
    async with await psycopg.AsyncConnection.connect(database) as raw:
        cur = await raw.execute("SELECT sha256, hint FROM pipeline_keys")
        stored, hint = await cur.fetchone()
    assert bytes(stored) == hashlib.sha256(secret.encode()).digest() and hint == secret[-4:]
    # Its key reads as its owner, and its reads are credited to the pipeline.
    assert await files_in(api, None, key(secret)) == 200


@needs_services
async def test_who_sees_and_changes_pipelines(api):
    mine = await make(api, headers=BOB, name="Bob's")
    await make(api, name="Alice's")
    # A Member sees their own; Owners and Admins see them all, never a key.
    assert [p["name"] for p in (await api.get("/pipelines", headers=BOB)).json()["pipelines"]] == [
        "Bob's"
    ]
    assert (await api.get("/pipelines?all", headers=BOB)).status_code == 403
    every = (await api.get("/pipelines?all", headers=ALICE)).json()["pipelines"]
    assert sorted(p["name"] for p in every) == ["Alice's", "Bob's"]
    assert all("secret" not in k for p in every for k in p["keys"])
    bobs = mine["pipeline"]["id"]
    # Only its owner changes it; an Owner can revoke it or hand it over.
    assert (
        await api.patch(f"/pipelines/{bobs}", headers=ALICE, json={"name": "Mine now"})
    ).status_code == 403
    assert (
        await api.patch(f"/pipelines/{bobs}", headers=CAROL, json={"name": "x"})
    ).status_code == 404
    renamed = await api.patch(f"/pipelines/{bobs}", headers=BOB, json={"name": "Nightly"})
    assert renamed.status_code == 200 and renamed.json()["name"] == "Nightly"
    # Claude can't make, see or revoke pipelines; a key can't either.
    assert (await api.get("/pipelines", headers=storage_token("kc|alice"))).status_code == 403
    assert (await api.get("/pipelines", headers=key(mine["key"]["secret"]))).status_code == 403
    # Bad bodies.
    for body in (
        {"name": "", "places": None, "operations": ["read"]},
        {"name": "x", "places": None, "operations": []},
        {"name": "x", "places": None, "operations": ["delete"]},
        {"name": "x", "places": [], "operations": ["read"]},
        {"name": "x", "places": [{"node": "nope"}], "operations": ["read"]},
        {"name": "x", "operations": ["read"]},
        {"name": "x", "places": None, "operations": ["read"], "expiresInDays": 400},
    ):
        assert (await api.post("/pipelines", headers=ALICE, json=body)).status_code == 400, body


@needs_services
async def test_pipelines_are_off_unless_turned_on(api_and_app):
    api, app = api_and_app
    secret = (await make(api))["key"]["secret"]
    app.state.settings = dataclasses.replace(app.state.settings, pipelines=False)
    assert (await api.get("/pipelines", headers=ALICE)).status_code == 404
    refused = await api.get("/files", headers=key(secret))
    assert refused.status_code == 401 and "PIPELINES" in refused.json()["error"]


@needs_services
async def test_a_pipeline_reaches_only_its_places_and_operations(api):
    etch = await make_node(api, "Etch")
    module = await make_node(api, "Module 3", etch)
    litho = await make_node(api, "Litho")
    secret = (await make(api, places=[{"node": etch}], operations=["read", "runs"]))["key"][
        "secret"
    ]
    pipeline = key(secret)
    assert await files_in(api, module, pipeline) == 200
    assert await files_in(api, litho, pipeline) == 404
    refused = await api.get("/files", headers=pipeline)
    assert refused.status_code == 403 and "places" in refused.json()["error"]
    # The tree shows its places (and the path to them), nothing else.
    shown = {
        n["name"]: n["role"] for n in (await api.get("/nodes", headers=pipeline)).json()["nodes"]
    }
    assert shown == {"Etch": "owner", "Module 3": "owner"}
    # A run in its places, credited to it; not outside them.
    made = await api.post("/experiments", headers=pipeline, json={"nodeId": module, "title": "Run"})
    assert made.status_code == 201, made.text
    exp = made.json()["id"]
    outside = await api.post(
        "/experiments", headers=pipeline, json={"nodeId": litho, "title": "Run"}
    )
    assert outside.status_code == 404
    started = await api.post(f"/experiments/{exp}/runs", headers=pipeline, json={})
    assert started.status_code == 201, started.text
    execution = started.json()["provenance"]["execution"]
    assert (
        execution["ranAs"]["kind"] == "pipeline" and execution["ranAs"]["name"] == "Nightly import"
    )
    assert execution["authorizedBy"] == {
        "kind": "pipeline-key",
        "key": execution["ranAs"]["key"],
        "places": [{"node": etch}],
        "operations": ["read", "runs"],
    }
    # Writing files needs the write operation, and the experiment list keeps to its places.
    wrote = await api.put(f"/files/out.csv?experiment={exp}", headers=pipeline, content=b"a\n")
    assert wrote.status_code == 403 and "write operation" in wrote.json()["error"]
    elsewhere = await api.post(
        "/experiments", headers=ALICE, json={"nodeId": litho, "title": "Mine"}
    )
    listed = (await api.get("/experiments", headers=pipeline)).json()["experiments"]
    assert [e["id"] for e in listed] == [exp]
    seen = await api.get(f"/experiments/{elsewhere.json()['id']}", headers=pipeline)
    assert seen.status_code == 404
    # Claude's limits hold: no deleting, no managing access.
    assert (await api.delete(f"/experiments/{exp}", headers=pipeline)).status_code == 403
    grants = await api.get("/access/grants", headers=pipeline)
    assert (
        grants.status_code == 403 and "A pipeline doesn't manage access" in grants.json()["error"]
    )


@needs_services
async def test_writes_in_knowledge_are_proposals(api):
    etch = await make_node(api, "Etch")
    secret = (await make(api, operations=["read", "write"]))["key"]["secret"]
    direct = await api.put(f"/files/notes.md?node={etch}", headers=key(secret), content=b"x")
    assert direct.status_code == 403 and "proposals" in direct.json()["error"]
    proposed = await api.put(
        f"/files/notes.md?node={etch}&propose", headers=key(secret), content=b"x"
    )
    assert proposed.status_code in (200, 201), proposed.text
    open_ = (await api.get(f"/proposals?node={etch}", headers=ALICE)).json()["proposals"]
    assert [p["author"] for p in open_] == ["pipeline"]


@needs_services
async def test_it_never_reaches_past_its_owner(api):
    etch = await make_node(api, "Etch")
    bob = await user_id(api, "Bob")
    grant_id = await grant(api, etch, bob, "viewer")
    secret = (await make(api, headers=BOB, places=[{"node": etch}]))["key"]["secret"]
    assert await files_in(api, etch, key(secret)) == 200
    revoked = await api.delete(f"/access/grants/{grant_id}", headers=ALICE)
    assert revoked.status_code == 200, revoked.text
    assert await files_in(api, etch, key(secret)) == 404
    # Nor can a place be one its owner can't see.
    litho = await make_node(api, "Litho")
    beyond = await api.post(
        "/pipelines",
        headers=BOB,
        json={"name": "x", "places": [{"node": litho}], "operations": ["read"]},
    )
    assert beyond.status_code == 404


@needs_services
async def test_what_stops_a_pipeline(api, database):
    await grant(api, None, await user_id(api, "Bob"), "viewer")
    made = await make(api, headers=BOB)
    pipeline, secret = made["pipeline"]["id"], made["key"]["secret"]
    second = await api.post(f"/pipelines/{pipeline}/keys", headers=BOB, json={})
    assert second.status_code == 201, second.text
    other = second.json()["key"]
    assert (await api.post(f"/pipelines/{pipeline}/keys", headers=BOB, json={})).status_code == 409
    # A revoked key.
    revoked = await api.delete(f"/pipelines/{pipeline}/keys/{made['key']['id']}", headers=BOB)
    assert revoked.status_code == 200
    answer = await api.get("/files", headers=key(secret))
    assert answer.status_code == 401 and answer.json()["error"] == "This pipeline key was revoked"
    assert await files_in(api, None, key(other["secret"])) == 200
    # An expired key.
    async with await psycopg.AsyncConnection.connect(database) as raw:
        await raw.execute(
            "UPDATE pipeline_keys SET expires_at = now() - interval '1 minute' WHERE id = %s",
            (other["id"],),
        )
        await raw.commit()
    answer = await api.get("/files", headers=key(other["secret"]))
    assert answer.status_code == 401 and "expired" in answer.json()["error"]
    third = (await api.post(f"/pipelines/{pipeline}/keys", headers=BOB, json={})).json()["key"]
    assert await files_in(api, None, key(third["secret"])) == 200
    # Its owner leaving suspends it, until an Owner hands it over.
    workspace = (await api.get("/workspaces", headers=ALICE)).json()["workspaces"][0]["id"]
    bob = await user_id(api, "Bob")
    left = await api.delete(f"/workspaces/{workspace}/members/{bob}", headers=BOB)
    assert left.status_code == 200, left.text
    answer = await api.get("/files", headers=key(third["secret"]))
    assert answer.status_code == 401 and "suspended" in answer.json()["error"]
    listed = (await api.get("/pipelines?all", headers=ALICE)).json()["pipelines"]
    assert listed[0]["status"] == "suspended"
    carol = await user_id(api, "Carol")
    await grant(api, None, carol, "viewer")
    handed = await api.post(f"/pipelines/{pipeline}/owner", headers=ALICE, json={"userId": carol})
    assert handed.status_code == 200 and handed.json()["owner"]["id"] == carol
    assert await files_in(api, None, key(third["secret"])) == 200
    # A revoked pipeline: all its keys stop, and it stays listed.
    assert (await api.delete(f"/pipelines/{pipeline}", headers=ALICE)).status_code == 200
    answer = await api.get("/files", headers=key(third["secret"]))
    assert answer.status_code == 401 and answer.json()["error"] == "This pipeline key was revoked"
    listed = (await api.get("/pipelines?all", headers=ALICE)).json()["pipelines"]
    assert listed[0]["status"] == "revoked"
    # Unknown keys, and a key sent with a session.
    assert (await api.get("/files", headers=key("kcp_" + "A" * 43))).status_code == 401
    assert (await api.get("/files", headers={**key(third["secret"]), **ALICE})).status_code == 400


@needs_services
async def test_one_accepted_call_and_one_queued_call(api_and_app, database):
    api, app = api_and_app
    made = await make(api, operations=["read", "runs", "upload"])
    pipeline, secret = made["pipeline"]["id"], made["key"]
    blobs = app.state.storage.blobs
    put = blobs.put
    entered, release = asyncio.Event(), asyncio.Event()

    async def held(sha256: str, data: bytes, mime: str) -> None:
        if data == b"held":
            entered.set()
            await release.wait()
        await put(sha256, data, mime)

    blobs.put = held
    eid = str(uuid.uuid4())
    # Accepted: its key and access were checked, and it is writing.
    accepted = asyncio.create_task(
        upload(
            api,
            [
                meta(id=eid, path="Etch///", title="Nightly", state="done"),
                ("out.csv", b"held", {"file": "1"}),
            ],
            headers=key(secret["secret"]),
        )
    )
    await asyncio.wait_for(
        asyncio.wait(
            [accepted, asyncio.ensure_future(entered.wait())], return_when=asyncio.FIRST_COMPLETED
        ),
        10,
    )
    assert not accepted.done(), accepted.result().text
    revoked = await api.delete(f"/pipelines/{pipeline}", headers=ALICE)
    assert revoked.status_code == 200
    # Queued behind it: refused, and nothing of it is written.
    queued = await upload(
        api,
        [
            meta(id=str(uuid.uuid4()), path="Etch///", title="Queued"),
            ("out.csv", b"next", {"file": "1"}),
        ],
        headers=key(secret["secret"]),
    )
    assert queued.status_code == 401
    release.set()
    done = await asyncio.wait_for(accepted, 10)
    assert done.status_code == 201, done.text
    # The accepted one is kept, and its Run and audit entry name the key it ran with.
    runs = (await api.get(f"/experiments/{eid}/runs", headers=ALICE)).json()["runs"]
    execution = runs[0]["provenance"]["execution"]
    assert execution["ranAs"]["key"] == secret["id"]
    assert execution["finishedBy"]["ranAs"]["key"] == secret["id"]
    async with await psycopg.AsyncConnection.connect(database) as raw:
        cur = await raw.execute(
            "SELECT actor_type, target->>'key', target->>'title' FROM audit_log "
            "WHERE action = 'experiment.create' ORDER BY id"
        )
        assert await cur.fetchall() == [("pipeline", secret["id"], "Nightly")]


@needs_services
async def test_every_run_says_what_it_ran_as(api):
    made = await api.post("/experiments", headers=ALICE, json={"nodeId": None, "title": "Etch"})
    exp = made.json()["id"]
    # A client's own execution is dropped.
    started = await api.post(
        f"/experiments/{exp}/runs",
        headers=ALICE,
        json={"provenance": {"execution": {"ranAs": {"kind": "pipeline"}}}},
    )
    assert started.status_code == 201, started.text
    execution = started.json()["provenance"]["execution"]
    alice = await user_id(api, "Alice")
    assert execution == {
        "initiatedBy": {"id": alice, "name": "Alice"},
        "ranAs": {"kind": "user"},
        "authorizedBy": {"kind": "session"},
    }
    claude = storage_token("kc|alice", via="remote")
    finished = await api.post(
        f"/runs/{started.json()['id']}/finish", headers=claude, json={"results": {"rate": 1}}
    )
    assert finished.status_code == 200, finished.text
    assert finished.json()["provenance"]["execution"]["finishedBy"] == {
        "user": {"id": alice, "name": "Alice"},
        "ranAs": {"kind": "agent", "via": "remote"},
        "authorizedBy": {"kind": "storage-token", "via": "remote"},
    }
