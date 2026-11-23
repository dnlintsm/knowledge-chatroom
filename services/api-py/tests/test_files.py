"""/files served by api-py, against a migrated Postgres and an S3-compatible store.

Needs TEST_DATABASE_URL (as test_storage_routes.py) and S3_ENDPOINT, with
S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY when the store wants them; the tests
share one new bucket. The conformance suite and the storage e2e run the same
routes against the spec and the app.
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
from support import ALICE, BOB, SECRET, URL, Client, storage_token

from api_py.blobs import S3Settings
from api_py.storage import EVENTS_CHANNEL

S3_ENDPOINT = os.environ.get("S3_ENDPOINT")
pytestmark = [
    pytest.mark.anyio,
    pytest.mark.skipif(
        not URL or not S3_ENDPOINT, reason="TEST_DATABASE_URL and S3_ENDPOINT are not set"
    ),
]
# One bucket for the whole run: blobs are keyed by their content, so tests can share it,
# and some S3-compatible stores (SeaweedFS in CI) set aside volumes for every new bucket.
BUCKET = f"api-py-test-{uuid.uuid4().hex[:12]}"
PNG = b"\x89PNG\r\n\x1a\n" + bytes(range(256))


def s3(public_url: str | None = None) -> S3Settings:
    return S3Settings(
        endpoint=S3_ENDPOINT,
        region=os.environ.get("S3_REGION") or "us-east-1",
        bucket=BUCKET,
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
    same = await files.get(
        "/files/notes/plan.md", headers={**ALICE, "If-None-Match": got.headers["etag"]}
    )
    assert (same.status_code, same.headers["etag"], same.content) == (304, got.headers["etag"], b"")

    # The same bytes add no version; new ones do, newest first.
    await files.put("/files/notes/plan.md", headers=ALICE, content=b"# Plan\n")
    await files.put(
        "/files/notes/plan.md",
        headers={**ALICE, "Content-Type": "text/plain; charset=utf-8"},
        content=b"v2",
    )
    versions = (await files.get("/files/notes/plan.md?versions", headers=ALICE)).json()["versions"]
    assert [(v["size"], v["mime"], v["author"]) for v in versions] == [
        (2, "text/plain", "user"),
        (7, "text/markdown", "user"),
    ]
    listed = (await files.get("/files", headers=ALICE)).json()["files"]
    assert [(f["path"], f["mime"]) for f in listed] == [("notes/plan.md", "text/plain")]

    # Only creating: an existing file is refused.
    taken = await files.put(
        "/files/notes/plan.md", headers={**ALICE, "If-None-Match": "*"}, content=b"x"
    )
    assert (taken.status_code, taken.json()) == (
        412,
        {"error": "notes/plan.md already exists", "exists": True},
    )

    moved = await files.patch("/files/notes/plan.md", headers=ALICE, json={"path": "notes/done.md"})
    assert (moved.json()["path"], moved.json()["mime"]) == ("notes/done.md", "text/plain")
    assert (await files.get("/files/notes/plan.md", headers=ALICE)).status_code == 404
    assert (
        len((await files.get("/files/notes/done.md?versions", headers=ALICE)).json()["versions"])
        == 2
    )
    await files.put("/files/notes/other.md", headers=ALICE, content=b"o")
    clash = await files.patch(
        "/files/notes/done.md", headers=ALICE, json={"path": "notes/other.md"}
    )
    assert (clash.status_code, clash.json()["exists"]) == (412, True)

    assert (await files.delete("/files/notes/done.md", headers=ALICE)).json() == {
        "deleted": "notes/done.md"
    }
    assert (await files.delete("/files/notes/done.md", headers=ALICE)).json() == {
        "error": "Not found"
    }
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
        "/files/uploads/raw",
        headers={**ALICE, "Content-Type": "application/octet-stream"},
        content=b"\x00\x01",
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
    node = (
        await files.post("/nodes", headers=ALICE, json={"parentId": None, "name": "Etch"})
    ).json()["id"]
    await files.put(f"/files/notes/recipe.md?node={node}", headers=ALICE, content=b"recipe")
    hidden = await files.get(f"/files?node={node}", headers=BOB)
    assert (hidden.status_code, hidden.json()) == (404, {"error": "Node not found"})
    bob = (await files.get("/access/users", headers=ALICE)).json()["users"][1]["id"]
    await files.post(
        "/access/grants",
        headers=ALICE,
        json={"node": node, "principalType": "user", "principalId": bob, "role": "viewer"},
    )
    assert [
        f["path"] for f in (await files.get(f"/files?node={node}", headers=BOB)).json()["files"]
    ] == ["notes/recipe.md"]
    assert (
        await files.get(f"/files/notes/recipe.md?node={node}", headers=BOB)
    ).content == b"recipe"
    refused = await files.put(f"/files/notes/recipe.md?node={node}", headers=BOB, content=b"mine")
    assert (refused.status_code, refused.json()) == (
        403,
        {"error": "You can only view here; this needs editor access"},
    )
    # The root's files are separate from the node's.
    assert (await files.get("/files/notes/recipe.md", headers=ALICE)).status_code == 404
    entry = (await files.get("/access/audit?kind=file", headers=ALICE)).json()["entries"][0]
    assert entry["target"] == {"node": node, "path": "notes/recipe.md", "size": 6}


async def test_writes_index_text_for_search(files, database):
    text = ("A paragraph about plasma etching. " * 20 + "\n\n") * 4
    info = (await files.put("/files/notes/etch.md", headers=ALICE, content=text.encode())).json()
    png = (await files.put("/files/uploads/shot.png", headers=ALICE, content=PNG)).json()
    async with await psycopg.AsyncConnection.connect(database) as conn:
        cur = await conn.execute(
            "SELECT chars FROM blob_texts WHERE sha256 = %s", (info["sha256"],)
        )
        assert (await cur.fetchone()) == (len(text),)
        cur = await conn.execute(
            "SELECT ord, length(body) FROM blob_chunks WHERE sha256 = %s ORDER BY ord",
            (info["sha256"],),
        )
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
    node = await files.put(
        "/files/notes/a.md?node=00000000-0000-0000-0000-000000000000", headers=claude, content=b"x"
    )
    assert node.json() == {
        "error": "Claude's writes in a knowledge node are proposals: add ?propose"
    }
    gone = await files.delete("/files/notes/by-claude.md", headers=claude)
    assert (gone.status_code, gone.json()) == (
        403,
        {"error": "Claude doesn't rename or delete files"},
    )
    entry = (await files.get("/access/audit?kind=file", headers=ALICE)).json()["entries"][0]
    assert (entry["actorType"], entry["target"]["via"]) == ("agent", "mcp:lab")


async def test_proposals_are_served_here(files):
    made = await files.put("/files/notes/a.md?propose", headers=ALICE, content=b"x")
    assert (made.status_code, made.json()["path"]) == (201, "notes/a.md")
    assert (
        await files.put("/files/a.md?propose&experiment=x", headers=ALICE, content=b"x")
    ).status_code == 404
    too_big = await files.put("/files/a.md?propose", headers=ALICE, content=b"x" * 4097)
    assert (too_big.status_code, too_big.json()) == (413, {"error": "File exceeds 4096 bytes"})


async def test_binary_files_get_signed_links(database):
    async with Client(database, SECRET, s3=s3(public_url="http://files.example.test")) as (
        api,
        _app,
    ):
        await api.put("/files/uploads/shot.png", headers=ALICE, content=PNG)
        await api.put("/files/notes/a.md", headers=ALICE, content=b"text")
        link = await api.get("/files/uploads/shot.png", headers=ALICE)
        assert (link.status_code, link.headers["cache-control"]) == (302, "no-store")
        location = httpx.URL(link.headers["location"])
        assert location.host == "files.example.test"
        assert (
            location.params["response-content-disposition"] == "inline; filename*=UTF-8''shot.png"
        )
        assert location.params["X-Amz-Expires"] == "300"
        # Text is served here, from the app's origin.
        assert (await api.get("/files/notes/a.md", headers=ALICE)).content == b"text"


async def test_only_media_opens_in_place_from_the_object_store(database):
    """
    Issue #286: a signed link is served by the store's own origin, without the
    sandbox the app puts on files it serves. So the type a writer claims is
    normalised, a page-like type is served by the app instead, and whatever
    still goes to the store as something a browser could run is a download.
    """
    async with Client(database, SECRET, s3=s3(public_url="http://files.example.test")) as (
        api,
        _app,
    ):
        page = b"<script>alert(1)</script>"

        async def put(path: str, kind: str) -> None:
            made = await api.put(
                f"/files/{path}", headers={**ALICE, "content-type": kind}, content=page
            )
            assert made.status_code == 200, made.text

        # However the type is spelled, text is text: served here, sandboxed.
        await put("uploads/a.bin", "Text/HTML; charset=utf-8")
        got = await api.get("/files/uploads/a.bin", headers=ALICE)
        assert (got.status_code, got.headers["content-type"].split(";")[0]) == (200, "text/html")
        assert got.headers["content-security-policy"] == "sandbox"
        # Something that isn't a content type at all is ignored: the path decides.
        await put("uploads/b.bin", "not a type")
        listed = (await api.get("/files", headers=ALICE)).json()["files"]
        assert {f["path"]: f["mime"] for f in listed} == {
            "uploads/a.bin": "text/html",
            "uploads/b.bin": "application/octet-stream",
        }
        # Binary types a browser would run as a document are downloaded from the store.
        for path, kind in (
            ("uploads/c.bin", "application/xhtml+xml"),
            ("uploads/d.bin", "application/XML"),
        ):
            await put(path, kind)
            link = await api.get(f"/files/{path}", headers=ALICE)
            assert link.status_code == 302, path
            disposition = httpx.URL(link.headers["location"]).params["response-content-disposition"]
            assert disposition.startswith("attachment; "), (path, disposition)
        # A picture or a PDF still opens in place.
        await api.put(
            "/files/uploads/doc.pdf",
            headers={**ALICE, "content-type": "application/pdf"},
            content=b"%PDF-1.7",
        )
        link = await api.get("/files/uploads/doc.pdf", headers=ALICE)
        assert (
            httpx.URL(link.headers["location"])
            .params["response-content-disposition"]
            .startswith("inline; ")
        )


async def test_a_json_route_reads_only_a_body_sent_as_json(files):
    """Issue #286: a form or plain-text post from another site needs no preflight; application/json does."""
    body = b'{"parentId": null, "name": "Etch"}'
    for kind in ("text/plain", "application/x-www-form-urlencoded", ""):
        headers = {**ALICE, "content-type": kind} if kind else dict(ALICE)
        refused = await files.post("/nodes", headers=headers, content=body)
        assert refused.status_code == 400, (kind, refused.text)
    assert (await files.get("/nodes", headers=ALICE)).json()["nodes"] == []
    kinds = ("application/json", "application/json; charset=utf-8", "Application/JSON")
    for number, kind in enumerate(kinds):
        named = b'{"parentId": null, "name": "Etch %d"}' % number
        made = await files.post("/nodes", headers={**ALICE, "content-type": kind}, content=named)
        assert made.status_code == 201, (kind, made.text)


@asynccontextmanager
async def served(app) -> AsyncIterator[str]:
    """`app` on a real socket: ASGITransport would wait for the whole of an endless event stream."""
    server = uvicorn.Server(
        uvicorn.Config(app, host="127.0.0.1", port=0, log_level="warning", lifespan="off")
    )
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
                readers = [
                    asyncio.create_task(events(a, alice)),
                    asyncio.create_task(events(b, bob)),
                ]
                info = (await api.put("/files/notes/w.md", headers=ALICE, content=b"w")).json()
                # A change another process makes (the TypeScript server, Claude's tools) arrives too.
                async with await psycopg.AsyncConnection.connect(database, autocommit=True) as conn:
                    cur = await conn.execute("SELECT id FROM workspaces WHERE slug = 'default'")
                    (ws,) = await cur.fetchone()  # type: ignore[misc]
                    other = {
                        "op": "delete",
                        "node": None,
                        "path": "notes/old.md",
                        "workspaceId": str(ws),
                    }
                    await conn.execute(
                        "SELECT pg_notify(%s, %s)", (EVENTS_CHANNEL, json.dumps(other))
                    )
                async with asyncio.timeout(10):
                    while len(alice) < 3:
                        await asyncio.sleep(0.02)
                for reader in readers:
                    reader.cancel()
        assert alice[0] == ": watching"
        written = {
            "op": "write",
            "node": None,
            "path": "notes/w.md",
            "sha256": info["sha256"],
            "author": "user",
        }
        assert alice[1:] == [
            "data: " + json.dumps(written, separators=(",", ":")),
            'data: {"op":"delete","node":null,"path":"notes/old.md"}',
        ]
        # Bob has no access to the workspace's root, so he hears of neither.
        assert bob == [": watching"]


async def watching(http: httpx.AsyncClient, lines: list[str]) -> asyncio.Task[None]:
    """Reads Alice's watch stream into `lines` until the server ends it."""

    async def read() -> None:
        async with http.stream("GET", "/files?watch", headers=ALICE) as response:
            await events(response, lines)

    task = asyncio.create_task(read())
    async with asyncio.timeout(10):
        while not lines:
            await asyncio.sleep(0.02)
    return task


async def test_a_watch_stream_ends_rather_than_skip_a_change(database, monkeypatch):
    """
    Issue #296: a change the stream can't check, can't hold, or may never have
    been told of ends the stream, so the browser reconnects and lists again.
    """
    from api_py import storage_routes
    from api_py.session import Session

    async with Client(database, SECRET, s3=s3()) as (api, app), served(app) as base:
        await api.get("/access", headers=ALICE)
        async with httpx.AsyncClient(base_url=base, timeout=10) as http:
            # 1. The check itself fails (as when no database connection comes in time).
            lines: list[str] = []
            stream = await watching(http, lines)
            await api.put("/files/notes/one.md", headers=ALICE, content=b"1")
            async with asyncio.timeout(10):
                while len(lines) < 2:
                    await asyncio.sleep(0.02)
            can_see = Session.can_see

            async def failing(self, event):
                raise RuntimeError("couldn't get a connection after 30.00 sec")

            monkeypatch.setattr(Session, "can_see", failing)
            await api.put("/files/notes/two.md", headers=ALICE, content=b"2")
            async with asyncio.timeout(10):
                await stream
            assert [line.startswith("data: ") for line in lines] == [False, True]

            # 2. More changes waiting than a stream holds: it ends once it gets to them.
            monkeypatch.setattr(storage_routes, "MAX_WATCH_BACKLOG", 2)
            checking = asyncio.Event()
            release = asyncio.Event()

            async def slow(self, event):
                checking.set()
                await release.wait()
                return await can_see(self, event)

            monkeypatch.setattr(Session, "can_see", slow)
            lines = []
            stream = await watching(http, lines)
            await api.put("/files/notes/b0.md", headers=ALICE, content=b"0")
            async with asyncio.timeout(10):
                await checking.wait()
            for i in range(1, 5):
                await api.put(f"/files/notes/b{i}.md", headers=ALICE, content=str(i).encode())
            await asyncio.sleep(0.2)  # the notifications reach the stream's queue
            release.set()
            async with asyncio.timeout(10):
                await stream
            assert [json.loads(line[6:])["path"] for line in lines[1:]] == ["notes/b0.md"]
            monkeypatch.setattr(Session, "can_see", can_see)

            # 3. The server's own events connection breaks: what it missed can't be known.
            lines = []
            stream = await watching(http, lines)
            async with await psycopg.AsyncConnection.connect(database, autocommit=True) as conn:
                cur = await conn.execute(
                    """
                    SELECT pg_terminate_backend(pid) FROM pg_stat_activity
                    WHERE datname = current_database() AND pid <> pg_backend_pid() AND query ILIKE 'LISTEN %'"""
                )
                assert len(await cur.fetchall()) == 1
            async with asyncio.timeout(10):
                await stream
            assert lines == [": watching"]


async def test_the_object_store_is_reached_without_a_database_connection(database, monkeypatch):
    """Issue #296: a slow object store must not keep one of the pool's connections waiting on it."""
    from api_py.blobs import BlobStore

    async with Client(database, SECRET, s3=s3()) as (api, app):
        await api.get("/access", headers=ALICE)
        pool = app.state.storage.pool
        held: list[tuple[str, int]] = []

        def spy(name: str):
            real = getattr(BlobStore, name)

            async def call(self, *args):
                stats = pool.get_stats()
                held.append((name, stats["pool_size"] - stats["pool_available"]))
                return await real(self, *args)

            return call

        for name in ("get", "put"):
            monkeypatch.setattr(BlobStore, name, spy(name))
        saved = await api.put("/files/notes/s3.md", headers=ALICE, content=b"stored")
        assert saved.status_code == 200, saved.text
        assert (await api.get("/files/notes/s3.md", headers=ALICE)).content == b"stored"
        proposal = await api.put("/files/notes/s3.md?propose", headers=ALICE, content=b"proposed")
        assert proposal.status_code == 201, proposal.text
        content = await api.get(f"/proposals/{proposal.json()['id']}/content", headers=ALICE)
        assert content.content == b"proposed"
        accepted = await api.post(f"/proposals/{proposal.json()['id']}/accept", headers=ALICE)
        assert accepted.status_code == 200, accepted.text
        assert (await api.get("/files/notes/s3.md", headers=ALICE)).content == b"proposed"
    assert [name for name, _ in held] == ["put", "get", "put", "get", "get", "get"]
    assert {connections for _, connections in held} == {0}


async def test_a_save_names_the_version_it_replaces(files):
    """If-Match (issue #293): the second of two people who read the same version doesn't overwrite the first."""
    first = (await files.put("/files/notes/shared.md", headers=ALICE, content=b"v1")).json()
    etag = (await files.get("/files/notes/shared.md", headers=ALICE)).headers["etag"]
    assert etag == f'"{first["sha256"]}"'

    # Bob saves over the version both read; Alice's save of the same version is refused.
    bob = await files.put(
        "/files/notes/shared.md", headers={**ALICE, "If-Match": etag}, content=b"bob's"
    )
    assert bob.status_code == 200, bob.text
    alice = await files.put(
        "/files/notes/shared.md", headers={**ALICE, "If-Match": etag}, content=b"alice's"
    )
    assert (alice.status_code, alice.json()) == (
        412,
        {
            "error": "notes/shared.md changed since you read it",
            "changed": True,
            "sha256": bob.json()["sha256"],
        },
    )
    assert (await files.get("/files/notes/shared.md", headers=ALICE)).content == b"bob's"
    versions = (await files.get("/files/notes/shared.md?versions", headers=ALICE)).json()
    assert len(versions["versions"]) == 2

    # The version now, bare or quoted, in a list, or any version at all.
    for name in (bob.json()["sha256"], f'"other", "{bob.json()["sha256"]}"', "*"):
        again = await files.put(
            "/files/notes/shared.md", headers={**ALICE, "If-Match": name}, content=b"bob's"
        )
        assert again.status_code == 200, (name, again.text)

    # A file that is gone (or never was) isn't brought back by a save of an old version.
    await files.delete("/files/notes/shared.md", headers=ALICE)
    for name in (etag, "*"):
        gone = await files.put(
            "/files/notes/shared.md", headers={**ALICE, "If-Match": name}, content=b"back"
        )
        assert (gone.status_code, gone.json()) == (
            412,
            {"error": "notes/shared.md isn't there any more", "changed": True, "sha256": None},
        )
    assert (await files.get("/files/notes/shared.md", headers=ALICE)).status_code == 404
    assert (await files.get("/files", headers=ALICE)).json()["files"] == []


async def test_two_saves_of_one_version_at_once_let_one_through(files):
    first = (await files.put("/files/race.md", headers=ALICE, content=b"v1")).json()
    headers = {**ALICE, "If-Match": f'"{first["sha256"]}"'}
    answers = await asyncio.gather(
        *(
            files.put("/files/race.md", headers=headers, content=f"v2-{i}".encode())
            for i in range(4)
        )
    )
    assert sorted(a.status_code for a in answers) == [200, 412, 412, 412]
    won = next(a for a in answers if a.status_code == 200).json()
    assert {a.json()["sha256"] for a in answers if a.status_code == 412} == {won["sha256"]}
