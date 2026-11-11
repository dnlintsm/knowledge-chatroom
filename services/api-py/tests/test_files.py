"""/files served by api-py, against a migrated Postgres and an S3-compatible store.

Needs TEST_DATABASE_URL (as test_storage_routes.py) and S3_ENDPOINT, with
S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY when the store wants them; each test
gets a bucket of its own. The conformance suite and the storage e2e run the
same routes against the spec and the app.
"""

from __future__ import annotations

import asyncio
import json
import os
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import datetime
from email.utils import format_datetime

import httpx
import psycopg
import pytest
import uvicorn
from support import ALICE, BOB, SECRET, URL, Client, forwarded, storage_token

from api_py.blobs import S3Settings
from api_py.storage import EVENTS_CHANNEL

S3_ENDPOINT = os.environ.get("S3_ENDPOINT")
pytestmark = [
    pytest.mark.anyio,
    pytest.mark.skipif(not URL or not S3_ENDPOINT, reason="TEST_DATABASE_URL and S3_ENDPOINT are not set"),
]
PNG = b"\x89PNG\r\n\x1a\n" + bytes(range(256))


def s3(public_url: str | None = None) -> S3Settings:
    return S3Settings(
        endpoint=S3_ENDPOINT,
        region=os.environ.get("S3_REGION") or "us-east-1",
        bucket=f"api-py-test-{uuid.uuid4().hex[:12]}",
        access_key_id=os.environ.get("S3_ACCESS_KEY_ID") or "test",
        secret_access_key=os.environ.get("S3_SECRET_ACCESS_KEY") or "test",
        public_url=public_url,
    )


@pytest.fixture
async def files(database) -> AsyncIterator[httpx.AsyncClient]:
    async with Client(database, SECRET, s3=s3(), max_upload_bytes=4096) as (client, _app):
        yield client


async def test_write_read_and_change_a_file(files):
    put = await files.put("/files/notes/plan.md", headers=ALICE, content=b"# Plan\n")
    assert put.status_code == 200
    info = put.json()
    assert {k: info[k] for k in ("path", "kind", "mime", "size", "author")} == {
        "path": "notes/plan.md",
        "kind": "note",
        "mime": "text/markdown",
        "size": 7,
        "author": "user",
    }
    assert info["updatedAt"].endswith("Z") and len(info["updatedAt"]) == 24

    got = await files.get("/files/notes/plan.md", headers=ALICE)
    assert got.content == b"# Plan\n"
    assert got.headers["content-type"] == "text/markdown"  # no charset added
    assert got.headers["etag"] == f'"{info["sha256"]}"'
    assert got.headers["x-file-author"] == "user"
    assert got.headers["cache-control"] == "no-cache"
    assert got.headers["content-security-policy"] == "sandbox"
    assert got.headers["x-content-type-options"] == "nosniff"
    # Date.toUTCString(): to the second.
    modified = datetime.fromisoformat(info["updatedAt"]).replace(microsecond=0)
    assert got.headers["last-modified"] == format_datetime(modified, usegmt=True)
    same = await files.get("/files/notes/plan.md", headers={**ALICE, "If-None-Match": got.headers["etag"]})
    assert (same.status_code, same.headers["etag"], same.content) == (304, got.headers["etag"], b"")

    # The same bytes add no version; new ones do, newest first.
    await files.put("/files/notes/plan.md", headers=ALICE, content=b"# Plan\n")
    await files.put("/files/notes/plan.md", headers={**ALICE, "Content-Type": "text/plain; charset=utf-8"}, content=b"v2")
    versions = (await files.get("/files/notes/plan.md?versions", headers=ALICE)).json()["versions"]
    assert [(v["size"], v["mime"], v["author"]) for v in versions] == [(2, "text/plain", "user"), (7, "text/markdown", "user")]
    listed = (await files.get("/files", headers=ALICE)).json()["files"]
    assert [(f["path"], f["mime"]) for f in listed] == [("notes/plan.md", "text/plain")]

    # Only creating: an existing file is refused.
    taken = await files.put("/files/notes/plan.md", headers={**ALICE, "If-None-Match": "*"}, content=b"x")
    assert (taken.status_code, taken.json()) == (412, {"error": "notes/plan.md already exists", "exists": True})

    moved = await files.patch("/files/notes/plan.md", headers=ALICE, json={"path": "notes/done.md"})
    assert (moved.json()["path"], moved.json()["mime"]) == ("notes/done.md", "text/plain")
    assert (await files.get("/files/notes/plan.md", headers=ALICE)).status_code == 404
    assert len((await files.get("/files/notes/done.md?versions", headers=ALICE)).json()["versions"]) == 2
    await files.put("/files/notes/other.md", headers=ALICE, content=b"o")
    clash = await files.patch("/files/notes/done.md", headers=ALICE, json={"path": "notes/other.md"})
    assert (clash.status_code, clash.json()["exists"]) == (412, True)

    assert (await files.delete("/files/notes/done.md", headers=ALICE)).json() == {"deleted": "notes/done.md"}
    assert (await files.delete("/files/notes/done.md", headers=ALICE)).json() == {"error": "Not found"}
    audit = (await files.get("/access/audit?kind=file", headers=ALICE)).json()["entries"]
    assert [e["action"] for e in audit][:3] == ["file.delete", "file.write", "file.rename"]


async def test_paths_bodies_and_methods(files):
    bad = await files.put("/files/%2E%2E/secret.md", headers=ALICE, content=b"x")
    assert (bad.status_code, bad.json()) == (400, {"error": 'Invalid path: "../secret.md"'})
    malformed = await files.get("/files/notes/%E0%A4%A.md", headers=ALICE)
    assert (malformed.status_code, malformed.json()) == (400, {"error": "Malformed path encoding"})
    # A %2F in a file path is a folder, as the TypeScript server reads it.
    await files.put("/files/notes%2Fdeep%2Fa.md", headers=ALICE, content=b"a")
    assert (await files.get("/files/notes/deep/a.md", headers=ALICE)).content == b"a"
    too_big = await files.put("/files/uploads/big.bin", headers=ALICE, content=b"x" * 4097)
    assert (too_big.status_code, too_big.json()) == (413, {"error": "File exceeds 4096 bytes"})
    typed = await files.put(
        "/files/uploads/raw", headers={**ALICE, "Content-Type": "application/octet-stream"}, content=b"\x00\x01"
    )
    assert (typed.json()["mime"], typed.json()["kind"]) == ("application/octet-stream", "upload")
    assert (await files.post("/files", headers=ALICE)).json() == {"error": "Method not allowed"}
    assert (await files.post("/files/notes/a.md", headers=ALICE)).status_code == 405
    assert (await files.patch("/files/notes/deep/a.md", headers=ALICE, json={"to": 1})).json() == {
        "error": "Expected {path: string}"
    }


async def test_files_in_a_node_follow_its_access(files):
    await files.get("/access", headers=ALICE)
    await files.get("/access", headers=BOB)
    node = (await files.post("/nodes", headers=ALICE, json={"parentId": None, "name": "Etch"})).json()["id"]
    await files.put(f"/files/notes/recipe.md?node={node}", headers=ALICE, content=b"recipe")
    hidden = await files.get(f"/files?node={node}", headers=BOB)
    assert (hidden.status_code, hidden.json()) == (404, {"error": "Node not found"})
    bob = (await files.get("/access/users", headers=ALICE)).json()["users"][1]["id"]
    await files.post(
        "/access/grants", headers=ALICE, json={"node": node, "principalType": "user", "principalId": bob, "role": "viewer"}
    )
    assert [f["path"] for f in (await files.get(f"/files?node={node}", headers=BOB)).json()["files"]] == ["notes/recipe.md"]
    assert (await files.get(f"/files/notes/recipe.md?node={node}", headers=BOB)).content == b"recipe"
    refused = await files.put(f"/files/notes/recipe.md?node={node}", headers=BOB, content=b"mine")
    assert (refused.status_code, refused.json()) == (403, {"error": "You can only view here; this needs editor access"})
    # The root's files are separate from the node's.
    assert (await files.get("/files/notes/recipe.md", headers=ALICE)).status_code == 404
    entry = (await files.get("/access/audit?kind=file", headers=ALICE)).json()["entries"][0]
    assert entry["target"] == {"node": node, "path": "notes/recipe.md", "size": 6}


async def test_writes_index_text_for_search(files, database):
    text = ("A paragraph about plasma etching. " * 20 + "\n\n") * 4
    info = (await files.put("/files/notes/etch.md", headers=ALICE, content=text.encode())).json()
    png = (await files.put("/files/uploads/shot.png", headers=ALICE, content=PNG)).json()
    async with await psycopg.AsyncConnection.connect(database) as conn:
        cur = await conn.execute("SELECT chars FROM blob_texts WHERE sha256 = %s", (info["sha256"],))
        assert (await cur.fetchone()) == (len(text),)
        cur = await conn.execute("SELECT ord, length(body) FROM blob_chunks WHERE sha256 = %s ORDER BY ord", (info["sha256"],))
        chunks = await cur.fetchall()
        assert [c[0] for c in chunks] == list(range(len(chunks))) and len(chunks) == 4
        cur = await conn.execute("SELECT chars FROM blob_texts WHERE sha256 = %s", (png["sha256"],))
        assert (await cur.fetchone()) == (0,)


async def test_storage_tokens_write_as_claude(files):
    await files.get("/access", headers=ALICE)
    claude = storage_token("kc|alice")
    made = await files.put("/files/notes/by-claude.md", headers=claude, content=b"hi")
    assert made.json()["author"] == "agent"
    skill = await files.put("/files/skills/x/SKILL.md", headers=claude, content=b"x")
    assert skill.json() == {"error": "Claude's changes to skills are proposals: add ?propose"}
    node = await files.put("/files/notes/a.md?node=00000000-0000-0000-0000-000000000000", headers=claude, content=b"x")
    assert node.json() == {"error": "Claude's writes in a knowledge node are proposals: add ?propose"}
    gone = await files.delete("/files/notes/by-claude.md", headers=claude)
    assert (gone.status_code, gone.json()) == (403, {"error": "Claude doesn't rename or delete files"})
    entry = (await files.get("/access/audit?kind=file", headers=ALICE)).json()["entries"][0]
    assert (entry["actorType"], entry["target"]["via"]) == ("agent", "mcp:lab")


async def test_experiment_files_and_proposals_stay_with_typescript(files):
    assert (await files.get("/files?experiment=abc", headers=ALICE)).json() == {"from": "typescript"}
    assert (await files.put("/files/notes/a.md?propose", headers=ALICE, content=b"x")).json() == {"from": "typescript"}
    assert forwarded == ["GET /files", "PUT /files/notes/a.md"]
    forwarded.clear()


async def test_binary_files_get_signed_links(database):
    async with Client(database, SECRET, s3=s3(public_url="http://files.example.test")) as (api, _app):
        await api.put("/files/uploads/shot.png", headers=ALICE, content=PNG)
        await api.put("/files/notes/a.md", headers=ALICE, content=b"text")
        link = await api.get("/files/uploads/shot.png", headers=ALICE)
        assert (link.status_code, link.headers["cache-control"]) == (302, "no-store")
        location = httpx.URL(link.headers["location"])
        assert location.host == "files.example.test"
        assert location.params["response-content-disposition"] == "inline; filename*=UTF-8''shot.png"
        assert location.params["X-Amz-Expires"] == "300"
        # Text is served here, from the app's origin.
        assert (await api.get("/files/notes/a.md", headers=ALICE)).content == b"text"


@asynccontextmanager
async def served(app) -> AsyncIterator[str]:
    """`app` on a real socket: ASGITransport would wait for the whole of an endless event stream."""
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=0, log_level="warning", lifespan="off"))
    serving = asyncio.create_task(server.serve())
    while not server.started:
        await asyncio.sleep(0.01)
    try:
        yield f"http://127.0.0.1:{server.servers[0].sockets[0].getsockname()[1]}"
    finally:
        server.should_exit = True
        await serving


async def events(response: httpx.Response, found: list[str]) -> None:
    async for line in response.aiter_lines():
        if line:
            found.append(line)


async def test_watch_tells_each_user_what_they_may_see(database):
    async with Client(database, SECRET, s3=s3()) as (api, app), served(app) as base:
        await api.get("/access", headers=ALICE)
        await api.get("/access", headers=BOB)
        async with httpx.AsyncClient(base_url=base, timeout=10) as http:
            alice: list[str] = []
            bob: list[str] = []
            async with (
                http.stream("GET", "/files?watch", headers=ALICE) as a,
                http.stream("GET", "/files?watch", headers=BOB) as b,
            ):
                assert a.headers["content-type"] == "text/event-stream"
                assert a.headers["x-accel-buffering"] == "no"
                readers = [asyncio.create_task(events(a, alice)), asyncio.create_task(events(b, bob))]
                info = (await api.put("/files/notes/w.md", headers=ALICE, content=b"w")).json()
                # A change another process makes (the TypeScript server, Claude's tools) arrives too.
                async with await psycopg.AsyncConnection.connect(database, autocommit=True) as conn:
                    cur = await conn.execute("SELECT id FROM workspaces WHERE slug = 'default'")
                    (ws,) = await cur.fetchone()  # type: ignore[misc]
                    other = {"op": "delete", "node": None, "path": "notes/old.md", "workspaceId": str(ws)}
                    await conn.execute("SELECT pg_notify(%s, %s)", (EVENTS_CHANNEL, json.dumps(other)))
                async with asyncio.timeout(10):
                    while len(alice) < 3:
                        await asyncio.sleep(0.02)
                for reader in readers:
                    reader.cancel()
        assert alice[0] == ": watching"
        written = {"op": "write", "node": None, "path": "notes/w.md", "sha256": info["sha256"], "author": "user"}
        assert alice[1:] == [
            "data: " + json.dumps(written, separators=(",", ":")),
            'data: {"op":"delete","node":null,"path":"notes/old.md"}',
        ]
        # Bob has no access to the workspace's root, so he hears of neither.
        assert bob == [": watching"]
