"""Import folder as Experiment (docs/experiment-runs.md).

Needs TEST_DATABASE_URL and S3_ENDPOINT, as test_files.py.
"""

from __future__ import annotations

import dataclasses
import uuid

import psycopg
import pytest
from support import ALICE, BOB, Client, storage_token, user
from test_experiment_restore import user_id
from test_files import S3_ENDPOINT, SECRET, URL, s3
from test_restricted_nodes import grant, make_node, restrict

from api_py import imports

pytestmark = [pytest.mark.anyio]
CAROL = user("kc|carol", "Carol")
needs_services = pytest.mark.skipif(
    not URL or not S3_ENDPOINT, reason="TEST_DATABASE_URL and S3_ENDPOINT are not set"
)


@pytest.fixture
async def api_and_app(database):
    async with Client(database, SECRET, s3=s3()) as (client, app):
        for who in (ALICE, BOB, CAROL):
            await client.get("/access", headers=who)
        yield client, app


@pytest.fixture
def api(api_and_app):
    return api_and_app[0]


async def put(api, node: str | None, path: str, data: bytes) -> None:
    where = f"?node={node}" if node else ""
    wrote = await api.put(f"/files/{path}{where}", headers=ALICE, content=data)
    assert wrote.status_code in (200, 201), wrote.text


async def folder(api) -> str:
    """Etch, with a run folder: two files, its params, and a file beside it."""
    etch = await make_node(api, "Etch")
    await put(api, etch, "runs/oct/report.md", b"# October")
    await put(api, etch, "runs/oct/data/out.csv", b"rate\n410\n")
    await put(api, etch, "runs/oct/params.json", b'{"rf_W": 300}')
    await put(api, etch, "runs/octave.md", b"not in the folder")
    return etch


def importing(api, body: dict, headers=ALICE, preview: bool = False):
    return api.post(
        f"/experiments/import{'?preview' if preview else ''}", headers=headers, json=body
    )


@needs_services
async def test_preview_changes_nothing_and_copy_keeps_the_folder(api):
    etch = await folder(api)
    body = {"node": etch, "folder": "runs/oct"}
    seen = await importing(api, body, preview=True)
    assert seen.status_code == 200, seen.text
    answer = seen.json()
    assert answer["title"] == "oct" and answer["params"] == {"rf_W": 300}
    assert [f["path"] for f in answer["files"]] == ["data/out.csv", "params.json", "report.md"]
    assert answer["restricted"] is None and answer["canMove"] and answer["canPoint"]
    assert (await api.get("/experiments", headers=ALICE)).json()["experiments"] == []

    made = await importing(api, {**body, "title": "October etch", "hypothesis": "Hotter is faster"})
    assert made.status_code == 201, made.text
    exp = made.json()["experiment"]
    assert (exp["title"], exp["nodeId"], exp["status"]) == ("October etch", etch, "draft")
    assert exp["params"] == {"rf_W": 300} and exp["hypothesis"] == "Hotter is faster"
    read = await api.get(f"/files/data/out.csv?experiment={exp['id']}", headers=ALICE)
    assert read.content == b"rate\n410\n"
    # Its own history, starting now; the folder stays as it was.
    history = await api.get(f"/files/data/out.csv?experiment={exp['id']}&versions", headers=ALICE)
    assert len(history.json()["versions"]) == 1
    left = await api.get(f"/files/runs/oct/report.md?node={etch}", headers=ALICE)
    assert left.status_code == 200 and left.content == b"# October"


@needs_services
async def test_move_removes_the_folder_and_keeps_its_history(api, database):
    etch = await folder(api)
    made = await importing(api, {"node": etch, "folder": "runs/oct", "move": True, "pointer": True})
    assert made.status_code == 201, made.text
    exp = made.json()["experiment"]
    gone = await api.get(f"/files/runs/oct/report.md?node={etch}", headers=ALICE)
    assert gone.status_code == 404
    # Deleted, not purged: its history is still there.
    async with await psycopg.AsyncConnection.connect(database) as raw:
        cur = await raw.execute(
            """
            SELECT count(v.id) FROM files f JOIN file_versions v ON v.file_id = f.id
            WHERE f.node_id = %s AND f.path = 'runs/oct/report.md' AND f.deleted_at IS NOT NULL""",
            (etch,),
        )
        assert (await cur.fetchone())[0] == 1
    # The pointer names the experiment and links to it, nothing more.
    pointer = await api.get(f"/files/runs/oct/EXPERIMENT.md?node={etch}", headers=ALICE)
    assert pointer.status_code == 200
    assert f"?experiment_id={exp['id']}" in pointer.text and "oct" in pointer.text
    beside = await api.get(f"/files/runs/octave.md?node={etch}", headers=ALICE)
    assert beside.status_code == 200


@needs_services
async def test_move_leaves_the_files_it_cant_import(api_and_app):
    api, app = api_and_app
    etch = await folder(api)
    await put(api, etch, "runs/oct/raw/scan.bin", b"x" * 200)
    # Uploads above 100 bytes are refused from here on, so the scan can't be imported.
    app.state.settings = dataclasses.replace(app.state.settings, max_upload_bytes=100)
    body = {"node": etch, "folder": "runs/oct", "move": True}
    seen = (await importing(api, body, preview=True)).json()
    assert seen["skipped"] == ["raw/scan.bin"]
    made = await importing(api, body)
    assert made.status_code == 201, made.text
    exp = made.json()["experiment"]
    listed = await api.get(f"/files?experiment={exp['id']}", headers=ALICE)
    assert [f["path"] for f in listed.json()["files"]] == [
        "data/out.csv",
        "params.json",
        "report.md",
    ]
    # Moved files leave the folder; the one left out stays where it was.
    assert (
        await api.get(f"/files/runs/oct/report.md?node={etch}", headers=ALICE)
    ).status_code == 404
    kept = await api.get(f"/files/runs/oct/raw/scan.bin?node={etch}", headers=ALICE)
    assert kept.status_code == 200 and kept.content == b"x" * 200


@needs_services
async def test_move_stops_when_a_file_changed_since_the_listing(api, monkeypatch):
    etch = await folder(api)
    listing = imports.folder_files

    async def stale(*args, **kwargs):
        # As if report.md was saved again between the listing and the import.
        found = await listing(*args, **kwargs)
        return [
            {**f, "version": str(uuid.uuid4())} if f["relative"] == "report.md" else f
            for f in found
        ]

    monkeypatch.setattr(imports, "folder_files", stale)
    made = await importing(api, {"node": etch, "folder": "runs/oct", "move": True})
    assert made.status_code == 412, made.text
    assert "runs/oct/report.md changed" in made.json()["error"]
    # Nothing happened: no experiment, and the folder is whole.
    assert (await api.get("/experiments", headers=ALICE)).json()["experiments"] == []
    for path in ("report.md", "data/out.csv", "params.json"):
        left = await api.get(f"/files/runs/oct/{path}?node={etch}", headers=ALICE)
        assert left.status_code == 200, path


@needs_services
async def test_a_viewer_copies_but_doesnt_move_or_point(api):
    etch = await folder(api)
    bob = await user_id(api, "Bob")
    await grant(api, etch, bob, "viewer")
    body = {"node": etch, "folder": "runs/oct"}
    seen = (await importing(api, body, headers=BOB, preview=True)).json()
    assert not seen["canMove"] and not seen["canPoint"]
    assert (await importing(api, {**body, "move": True}, headers=BOB)).status_code == 403
    assert (await importing(api, {**body, "pointer": True}, headers=BOB)).status_code == 403
    copied = await importing(api, body, headers=BOB)
    assert copied.status_code == 201, copied.text
    assert copied.json()["experiment"]["mine"] is True


@needs_services
async def test_copying_out_of_a_restricted_node_needs_full_access(api):
    etch = await make_node(api, "Etch")
    secret = await make_node(api, "Secret", etch)
    await put(api, secret, "recipes/r1/notes.md", b"secret recipe")
    bob = await user_id(api, "Bob")
    await grant(api, None, bob, "viewer")
    assert (await restrict(api, secret, keep=[bob])).status_code == 200
    await grant(api, secret, bob, "editor")
    body = {"node": secret, "folder": "recipes/r1"}

    # Inside the restricted node: fine for anyone who can read it.
    assert (await importing(api, body, headers=BOB)).status_code == 201
    # Outside it: the preview names the node, and Bob without Full access is refused.
    out = {**body, "destination": etch}
    seen = (await importing(api, out, headers=BOB, preview=True)).json()
    assert seen["restricted"] == {"id": secret, "name": "Secret", "fullAccess": False}
    refused = await importing(api, out, headers=BOB)
    assert refused.status_code == 403 and "Full access" in refused.json()["error"]
    # Alice has Full access there.
    assert (await importing(api, out)).status_code == 201


@needs_services
async def test_bad_imports_are_refused(api):
    etch = await folder(api)
    assert (await importing(api, {"node": etch, "folder": "runs/none"})).status_code == 400
    assert (await importing(api, {"node": etch, "folder": ""})).status_code == 400
    assert (await importing(api, {"node": etch})).status_code == 400
    assert (
        await importing(api, {"node": etch, "folder": "runs/oct", "status": "archived"})
    ).status_code == 400
    unseen = "00000000-0000-4000-8000-000000000000"
    assert (await importing(api, {"node": unseen, "folder": "runs/oct"})).status_code == 404
    # Claude's storage tokens can't import: it's the user's own.
    token = storage_token("kc|alice")
    assert (
        await importing(api, {"node": etch, "folder": "runs/oct"}, headers=token)
    ).status_code == 403


@needs_services
async def test_a_pointer_doesnt_replace_the_folders_own_experiment_md(api):
    etch = await folder(api)
    await put(api, etch, "runs/oct/EXPERIMENT.md", b"# Notes kept by hand")
    body = {"node": etch, "folder": "runs/oct", "pointer": True}
    # Copy keeps the folder's EXPERIMENT.md, so a pointer would replace it: refused, and
    # nothing is imported.
    refused = await importing(api, body)
    assert refused.status_code == 412, refused.text
    assert refused.json()["exists"] is True
    kept = await api.get(f"/files/runs/oct/EXPERIMENT.md?node={etch}", headers=ALICE)
    assert kept.content == b"# Notes kept by hand"
    assert (await api.get("/experiments", headers=ALICE)).json()["experiments"] == []
    # Move takes it into the Experiment, and the pointer takes its place.
    made = await importing(api, {**body, "move": True})
    assert made.status_code == 201, made.text
    exp = made.json()["experiment"]
    moved = await api.get(f"/files/EXPERIMENT.md?experiment={exp['id']}", headers=ALICE)
    assert moved.content == b"# Notes kept by hand"
    pointer = await api.get(f"/files/runs/oct/EXPERIMENT.md?node={etch}", headers=ALICE)
    assert f"?experiment_id={exp['id']}" in pointer.text
