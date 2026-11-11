"""/proposals, ?propose and /experiments/upload served by api-py, against a migrated Postgres and an S3-compatible store.

Needs TEST_DATABASE_URL and S3_ENDPOINT, as test_files.py. The conformance
suite and the storage e2e run the same routes against the spec and the app.
"""

from __future__ import annotations

import json
import uuid

import pytest
from support import ALICE, BOB, Client, forwarded, storage_token
from test_files import S3_ENDPOINT, SECRET, URL, s3

pytestmark = [
    pytest.mark.anyio,
    pytest.mark.skipif(not URL or not S3_ENDPOINT, reason="TEST_DATABASE_URL and S3_ENDPOINT are not set"),
]
MAX_UPLOAD = 4096


@pytest.fixture
async def api(database):
    async with Client(database, SECRET, s3=s3(), max_upload_bytes=MAX_UPLOAD) as (client, _app):
        await client.get("/access", headers=ALICE)  # the first to sign in owns the workspace
        await client.get("/access", headers=BOB)
        yield client


async def node_bob_views(api) -> str:
    """A node Alice edits and Bob can only view."""
    node = (await api.post("/nodes", headers=ALICE, json={"parentId": None, "name": "Etch"})).json()["id"]
    bob = (await api.get("/access/users", headers=ALICE)).json()["users"][1]["id"]
    grant = {"node": node, "principalType": "user", "principalId": bob, "role": "viewer"}
    assert (await api.post("/access/grants", headers=ALICE, json=grant)).status_code == 200
    return node


async def audit(api) -> list[tuple[str, dict]]:
    entries = (await api.get("/access/audit?kind=proposal", headers=ALICE)).json()["entries"]
    return [(e["action"], e["target"]) for e in entries]


async def test_a_viewer_proposes_and_an_editor_decides(api):
    node = await node_bob_views(api)
    await api.put(f"/files/notes/a.md?node={node}", headers=ALICE, content=b"# A\n")

    made = await api.put(f"/files/notes/a.md?node={node}&propose&note=%20typo%20", headers=BOB, content=b"# A\nfixed")
    assert made.status_code == 201, made.text
    p1 = made.json()
    assert {k: p1[k] for k in ("node", "path", "size", "mime", "author", "authorName", "experiment", "note")} == {
        "node": node, "path": "notes/a.md", "size": 9, "mime": "text/markdown", "author": "user",
        "authorName": "Bob", "experiment": None, "note": "typo",
    }  # fmt: skip
    assert (p1["status"], p1["isNew"], p1["fileChanged"], p1["mine"], p1["canDecide"]) == (
        "open", False, False, True, False,
    )  # fmt: skip
    # The node's file is unchanged until someone accepts.
    assert (await api.get(f"/files/notes/a.md?node={node}", headers=ALICE)).content == b"# A\n"

    # Revising your open proposal for a file replaces it.
    again = (await api.put(f"/files/notes/a.md?node={node}&propose", headers=BOB, content=b"# A\nFixed")).json()
    assert (again["id"], again["size"], again["note"]) == (p1["id"], 9, "")
    same = await api.put(f"/files/notes/a.md?node={node}&propose", headers=BOB, content=b"# A\n")
    assert (same.status_code, same.json()) == (400, {"error": "notes/a.md already has this content; there is nothing to propose"})
    p2 = (await api.put(f"/files/notes/new.md?node={node}&propose", headers=BOB, content=b"new")).json()
    p3 = (await api.put(f"/files/notes/other.md?node={node}&propose", headers=BOB, content=b"other")).json()
    assert p2["isNew"] is True

    listed = (await api.get("/proposals", headers=ALICE)).json()["proposals"]
    assert [p["id"] for p in listed] == [p3["id"], p2["id"], p1["id"]]
    assert all(p["canDecide"] and not p["mine"] for p in listed)
    assert (await api.get("/proposals?node=root", headers=ALICE)).json() == {"proposals": []}
    bad = await api.get("/proposals?status=nope", headers=ALICE)
    assert (bad.status_code, bad.json()) == (400, {"error": "status must be one of open, accepted, rejected, withdrawn, all"})
    content = await api.get(f"/proposals/{p1['id']}/content", headers=ALICE)
    assert (content.content, content.headers["content-type"]) == (b"# A\nFixed", "text/markdown")
    assert content.headers["content-security-policy"] == "sandbox"

    refused = await api.post(f"/proposals/{p1['id']}/accept", headers=BOB)
    assert (refused.status_code, refused.json()) == (403, {"error": "You can only view here; this needs editor access"})
    accepted = await api.post(f"/proposals/{p1['id']}/accept", headers=ALICE)
    assert accepted.status_code == 200, accepted.text
    assert (accepted.json()["status"], accepted.json()["decidedByName"]) == ("accepted", "Alice")
    assert accepted.json()["decidedAt"].endswith("Z")
    # The new version is credited to its proposer.
    file = await api.get(f"/files/notes/a.md?node={node}", headers=ALICE)
    assert (file.content, file.headers["x-file-author"]) == (b"# A\nFixed", "user")
    versions = (await api.get(f"/files/notes/a.md?node={node}&versions", headers=ALICE)).json()["versions"]
    assert [v["authorId"] == p1["authorId"] for v in versions] == [True, False]

    again = await api.post(f"/proposals/{p1['id']}/reject", headers=ALICE)
    assert (again.status_code, again.json()) == (400, {"error": "This proposal was already accepted"})
    assert (await api.post(f"/proposals/{p2['id']}/reject", headers=ALICE)).json()["status"] == "rejected"
    not_theirs = await api.post(f"/proposals/{p3['id']}/withdraw", headers=ALICE)
    assert (not_theirs.status_code, not_theirs.json()) == (403, {"error": "Only its proposer can withdraw a proposal"})
    assert (await api.post(f"/proposals/{p3['id']}/withdraw", headers=BOB)).json()["status"] == "withdrawn"
    assert (await api.get(f"/files/notes/new.md?node={node}", headers=ALICE)).status_code == 404

    everything = (await api.get(f"/proposals?node={node}&status=all", headers=BOB)).json()["proposals"]
    assert sorted(p["status"] for p in everything) == ["accepted", "rejected", "withdrawn"]
    assert (await api.get("/proposals?status=open", headers=BOB)).json() == {"proposals": []}
    assert await audit(api) == [
        ("proposal.withdraw", {"proposal": p3["id"], "node": node, "path": "notes/other.md"}),
        ("proposal.reject", {"proposal": p2["id"], "node": node, "path": "notes/new.md"}),
        ("proposal.accept", {"proposal": p1["id"], "node": node, "path": "notes/a.md"}),
        ("proposal.create", {"proposal": p3["id"], "node": node, "path": "notes/other.md"}),
        ("proposal.create", {"proposal": p2["id"], "node": node, "path": "notes/new.md"}),
        ("proposal.create", {"proposal": p1["id"], "node": node, "path": "notes/a.md"}),
        ("proposal.create", {"proposal": p1["id"], "node": node, "path": "notes/a.md"}),
    ]


async def test_accepting_what_the_file_already_has(api):
    proposal = (await api.put("/files/a.md?propose", headers=ALICE, content=b"same")).json()
    await api.put("/files/a.md", headers=ALICE, content=b"same")
    accepted = await api.post(f"/proposals/{proposal['id']}/accept", headers=ALICE)
    assert (accepted.status_code, accepted.json()["status"]) == (200, "accepted")
    assert len((await api.get("/files/a.md?versions", headers=ALICE)).json()["versions"]) == 1


async def test_proposals_routes_answer_bad_requests(api):
    missing = str(uuid.uuid4())
    for path in (f"/proposals/{missing}", "/proposals/nope", f"/proposals/{missing}/content"):
        found = await api.get(path, headers=ALICE)
        assert (found.status_code, found.json()) == (404, {"error": "Proposal not found"})
    assert (await api.post(f"/proposals/{missing}/accept", headers=ALICE)).status_code == 404
    assert (await api.get(f"/proposals/{missing}/accept", headers=ALICE)).status_code == 405
    assert (await api.post(f"/proposals/{missing}", headers=ALICE)).status_code == 405
    assert (await api.post(f"/proposals/{missing}/content", headers=ALICE)).status_code == 405
    assert (await api.get(f"/proposals/{missing}/merge", headers=ALICE)).json() == {"error": "Not found"}
    assert (await api.delete("/proposals", headers=ALICE)).status_code == 405
    assert (await api.get("/proposals/promotable", headers=ALICE)).json() == {"error": "Expected ?experiment=<id>"}
    assert (await api.post("/proposals/promotable", headers=ALICE)).status_code == 405
    for body in ({}, {"experimentId": 1}, {"experimentId": "x", "paths": None}, {"experimentId": "x", "note": None},
                 {"experimentId": "x", "paths": ["a", 2]}):  # fmt: skip
        refused = await api.post("/proposals", headers=ALICE, json=body)
        assert refused.json() == {"error": "Expected {experimentId: string, paths?: string[], note?: string}"}
    long = await api.put("/files/a.md?propose&note=" + "n" * 2001, headers=ALICE, content=b"x")
    assert (long.status_code, long.json()) == (400, {"error": "Notes are at most 2000 characters"})
    exp = (await api.post("/experiments", headers=ALICE, json={"nodeId": None, "title": "E"})).json()
    direct = await api.put(f"/files/a.md?experiment={exp['id']}&propose", headers=ALICE, content=b"x")
    assert direct.json() == {"error": "An experiment's files change directly; promote it to propose them"}
    assert not forwarded


async def test_promoting_an_experiment(api):
    node = (await api.post("/nodes", headers=ALICE, json={"parentId": None, "name": "Etch"})).json()["id"]
    for path, body in (("keep.md", b"keep"), ("change.md", b"v1")):
        await api.put(f"/files/{path}?node={node}", headers=ALICE, content=body)
    exp = (await api.post("/experiments", headers=ALICE, json={"nodeId": node, "title": "Faster etch"})).json()
    eid = exp["id"]
    nothing = await api.post("/proposals", headers=ALICE, json={"experimentId": eid})
    assert nothing.json() == {"error": "This experiment has no changes its node doesn't have"}
    await api.put(f"/files/change.md?experiment={eid}", headers=ALICE, content=b"v2")
    await api.put(f"/files/data/new.csv?experiment={eid}", headers=ALICE, content=b"a,b\n")

    promotable = (await api.get(f"/proposals/promotable?experiment={eid}", headers=ALICE)).json()["files"]
    assert promotable == [
        {"path": "change.md", "size": 2, "mime": "text/markdown", "change": "changed", "proposal": None},
        {"path": "data/new.csv", "size": 4, "mime": "text/csv", "change": "new", "proposal": None},
    ]
    missing = await api.post("/proposals", headers=ALICE, json={"experimentId": eid, "paths": ["keep.md", "x.md"]})
    assert missing.json() == {
        "error": "Nothing to propose for keep.md, x.md: the experiment didn't change it, or its node already has it"
    }
    bob = await api.post("/proposals", headers=BOB, json={"experimentId": eid})
    assert (bob.status_code, bob.json()) == (404, {"error": "Experiment not found"})

    made = await api.post("/proposals", headers=ALICE, json={"experimentId": eid, "note": "promote"})
    assert made.status_code == 201, made.text
    proposals = made.json()["proposals"]
    assert [(p["path"], p["experiment"], p["experimentTitle"], p["note"]) for p in proposals] == [
        ("change.md", eid, "Faster etch", "promote"),
        ("data/new.csv", eid, "Faster etch", "promote"),
    ]
    listed = (await api.get(f"/proposals?experiment={eid}", headers=ALICE)).json()["proposals"]
    assert sorted(p["id"] for p in listed) == sorted(p["id"] for p in proposals)
    again = (await api.get(f"/proposals/promotable?experiment={eid}", headers=ALICE)).json()["files"]
    assert [f["proposal"] for f in again] == [p["id"] for p in proposals]
    entry = (await audit(api))[0]
    assert entry == ("proposal.create", {"proposal": proposals[1]["id"], "node": node, "path": "data/new.csv", "experiment": eid})

    # Accepting puts the experiment's version on the node.
    await api.post(f"/proposals/{proposals[0]['id']}/accept", headers=ALICE)
    assert (await api.get(f"/files/change.md?node={node}", headers=ALICE)).content == b"v2"
    one = await api.post("/proposals", headers=ALICE, json={"experimentId": eid, "paths": ["data/new.csv"]})
    assert [p["id"] for p in one.json()["proposals"]] == [proposals[1]["id"]]

    await api.patch(f"/experiments/{eid}", headers=ALICE, json={"status": "archived"})
    archived = await api.post("/proposals", headers=ALICE, json={"experimentId": eid})
    assert (archived.status_code, archived.json()) == (
        403, {"error": "This experiment is archived; restore it to propose its files"},
    )  # fmt: skip


async def test_storage_tokens_propose_but_do_not_decide(api):
    node = (await api.post("/nodes", headers=ALICE, json={"parentId": None, "name": "Etch"})).json()["id"]
    claude = storage_token("kc|alice")
    made = await api.put(f"/files/notes/a.md?node={node}&propose", headers=claude, content=b"from Claude")
    assert (made.status_code, made.json()["author"]) == (201, "agent")
    refused = await api.post(f"/proposals/{made.json()['id']}/accept", headers=claude)
    assert (refused.status_code, refused.json()) == (403, {"error": "Claude doesn't accept, reject or withdraw proposals"})
    assert (await api.get(f"/proposals/{made.json()['id']}", headers=claude)).json()["mine"] is True
    exp = (await api.post("/experiments", headers=claude, json={"nodeId": node, "title": "By Claude"})).json()
    await api.put(f"/files/r.md?experiment={exp['id']}", headers=claude, content=b"result")
    promoted = await api.post("/proposals", headers=claude, json={"experimentId": exp["id"]})
    assert (promoted.status_code, promoted.json()["proposals"][0]["author"]) == (201, "agent")
    # Alice accepts; the node's file is credited to Claude.
    await api.post(f"/proposals/{made.json()['id']}/accept", headers=ALICE)
    file = await api.get(f"/files/notes/a.md?node={node}", headers=ALICE)
    assert file.headers["x-file-author"] == "agent"


# Uploads


def form(parts: list[tuple[str, bytes, dict[str, str]]], boundary: str = "kc-boundary") -> tuple[bytes, dict[str, str]]:
    """A multipart body from (name, content, extra headers), as a client sends it."""
    body = b"".join(
        f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"'.encode()
        + (b'; filename="f"' if "file" in extra else b"")
        + b"\r\n"
        + b"".join(f"{k}: {v}\r\n".encode() for k, v in extra.items() if k != "file")
        + b"\r\n"
        + content
        + b"\r\n"
        for name, content, extra in parts
    )
    return body + f"--{boundary}--\r\n".encode(), {"Content-Type": f"multipart/form-data; boundary={boundary}"}


def meta(**fields) -> tuple[str, bytes, dict[str, str]]:
    return ("meta", json.dumps(fields).encode(), {})


async def upload(api, parts, headers=ALICE, boundary="kc-boundary"):
    body, content_type = form(parts, boundary)
    return await api.post("/experiments/upload", headers={**headers, **content_type}, content=body)


async def test_uploading_an_experiment(api):
    tech = (await api.post("/nodes", headers=ALICE, json={"parentId": None, "name": "Etch"})).json()
    eid = str(uuid.uuid4())
    made = await upload(
        api,
        [
            meta(id=eid.upper(), path="etch/Module 3//", title=" Run 7 ", params={"temp": 60}, state="done"),
            ("data/métrics.csv", b"a,b\n1,2\n", {"file": "1", "Content-Type": "text/csv; charset=utf-8"}),
            ("notes/raw.bin", b"\x00\x01", {"Content-Type": "application/octet-stream"}),
            ("report.md", b"# Run 7\n", {"file": "1"}),
        ],
    )
    assert made.status_code == 201, made.text
    answer = made.json()
    experiment = answer["experiment"]
    assert (experiment["id"], experiment["title"], experiment["state"], experiment["params"]) == (
        eid, "Run 7", "done", {"temp": 60},
    )  # fmt: skip
    assert [n["name"] for n in answer["lineage"]] == ["Etch", "Module 3", "None", "None"]
    assert answer["lineage"][0]["id"] == tech["id"]
    assert [n["name"] for n in answer["created"]] == ["Module 3", "None", "None"]
    assert experiment["nodeId"] == answer["lineage"][-1]["id"]
    # Only the uploaded files, typed as sent (a file part without a type is text/plain, as busboy reads it).
    assert [(f["path"], f["mime"]) for f in answer["files"]] == [
        ("data/métrics.csv", "text/csv"), ("notes/raw.bin", "application/octet-stream"), ("report.md", "text/plain"),
    ]  # fmt: skip
    got = await api.get(f"/files/data/m%C3%A9trics.csv?experiment={eid}", headers=ALICE)
    assert got.content == b"a,b\n1,2\n"
    entries = (await api.get("/access/audit?kind=experiment", headers=ALICE)).json()["entries"]
    assert entries[0]["target"] == {
        "experiment": eid, "node": experiment["nodeId"], "title": "Run 7",
        "files": ["data/métrics.csv", "notes/raw.bin", "report.md"], "upload": True,
    }  # fmt: skip

    again = await upload(api, [meta(id=eid, path=["Etch", "Module 3", None, ""], title="Again")])
    assert (again.status_code, again.json()) == (409, {"error": f"An experiment with id {eid} already exists", "exists": True})
    # The same path again finds the nodes made the first time.
    second = (await upload(api, [meta(id=str(uuid.uuid4()), path=["Etch", "module 3", None, ""], title="Two")])).json()
    assert (second["created"], second["experiment"]["nodeId"]) == ([], experiment["nodeId"])


async def test_upload_refusals(api):
    def new_id() -> str:
        return str(uuid.uuid4())

    async def refused(parts, headers=ALICE, boundary="kc-boundary"):
        answer = await upload(api, parts, headers, boundary)
        return answer.status_code, answer.json()["error"]

    short = await refused([meta(id=new_id(), path="Etch", title="Short")])
    assert short == (400, 'The path needs a name for each of the 4 levels (tech/module/loop/process), got 1; leave a name empty for "None"')
    assert await refused([meta(id="nope", path="a/b/c/d", title="T")]) == (
        400, "An experiment id must be a UUID, e.g. 0b8f6c2e-3d1a-4f5b-9c7e-2a4d6e8f0a1b",
    )  # fmt: skip
    expected = (
        400,
        (
            'Expected a "meta" part with {id: uuid, path: "Tech/Module/Loop/Process" | string[], title: string, '
            "hypothesis?: string, params?, results?: object, state?: ready|running|done|failed}"
        ),
    )
    assert await refused([]) == expected
    assert await refused([meta(id=new_id(), path=[1], title="T")]) == expected
    assert await refused([meta(id=new_id(), path="a/b/c/d")]) == expected
    assert await refused([("meta", b"{nope", {})]) == (400, f'The "meta" part isn\'t JSON. {expected[1]}')
    assert await refused([meta(id=new_id(), path="a/b/c/d", title="T"), ("note", b"x", {})]) == (
        400, '"note" isn\'t a file: put everything but files in the "meta" part',
    )  # fmt: skip
    assert await refused([meta(id=new_id(), path="a/b/c/d", title="T")] * 2) == (400, 'Send one "meta" part')
    big = await refused([meta(id=new_id(), path="a/b/c/d", title="T"), ("big.bin", b"x" * (MAX_UPLOAD + 1), {"file": "1"})])
    assert big == (413, f"big.bin exceeds {MAX_UPLOAD} bytes")
    assert await refused([("meta", b" " * (256 * 1024 + 1), {})]) == (413, 'The "meta" part exceeds 262144 bytes')
    twice = await refused([meta(id=new_id(), path="a/b/c/d", title="T"), ("x.md", b"1", {"file": "1"}), ("x.md", b"2", {"file": "1"})])
    assert twice == (400, "Two files would both be x.md")

    body, _ = form([meta(id=new_id(), path="a/b/c/d", title="T")])
    as_json = await api.post("/experiments/upload", headers=ALICE, json={})
    assert (as_json.status_code, as_json.json()) == (
        415, {"error": 'Send the experiment as multipart/form-data: a "meta" part and one part per file'},
    )  # fmt: skip
    cut = await api.post("/experiments/upload", headers={**ALICE, "Content-Type": "multipart/form-data; boundary=kc-boundary"}, content=body[:-20])
    assert (cut.status_code, cut.json()) == (400, {"error": "The multipart body could not be read"})
    no_boundary = await api.post("/experiments/upload", headers={**ALICE, "Content-Type": "multipart/form-data; x=1"}, content=body)
    assert no_boundary.json() == {"error": "The multipart body could not be read"}
    assert (await api.get("/experiments/upload", headers=ALICE)).status_code == 405

    # New nodes need editor access where they go; storage tokens can't upload.
    bob = await refused([meta(id=new_id(), path="Etch/X/None/Bob's", title="Bob")], headers=BOB)
    assert bob[0] == 403
    claude = await refused([meta(id=new_id(), path="a/b/c/d", title="T")], headers=storage_token("kc|alice"))
    assert claude == (403, "Uploading an experiment adds nodes and is its user's own: storage tokens can't use /experiments/upload")
    # Nothing was made by any of these.
    assert (await api.get("/experiments", headers=ALICE)).json() == {"experiments": []}
    assert (await api.get("/nodes", headers=ALICE)).json()["nodes"] == []


async def test_upload_reads_bodies_as_busboy_does(api):
    eid = str(uuid.uuid4())
    body, _ = form(
        [
            meta(id=eid, path="a/b/c/d", title="T"),
            ("skipped.md", b"no disposition type", {}),
            ("data.json", b"{}", {"Content-Type": "application/octet-stream"}),
        ],
        boundary="--odd boundary",
    )
    body = b"a preamble to skip\r\n" + body
    body = body.replace(b'Content-Disposition: form-data; name="skipped.md"', b"X-Nothing: 1", 1)
    made = await api.post(
        "/experiments/upload", headers={**ALICE, "Content-Type": 'multipart/form-data; boundary="--odd boundary"'}, content=body
    )
    assert made.status_code == 201, made.text
    assert [f["path"] for f in made.json()["files"]] == ["data.json"]
    assert made.json()["files"][0]["mime"] == "application/json"  # octet-stream: picked from the path
