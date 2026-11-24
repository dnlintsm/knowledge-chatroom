"""What a run keeps as evidence: past versions of a file, and the Rules its agents read.

Needs TEST_DATABASE_URL and S3_ENDPOINT, as test_files.py. docs/run-evidence.md
says what these routes promise.
"""

from __future__ import annotations

import asyncio

import psycopg
import pytest
from support import ALICE, BOB, Client, storage_token
from test_experiments import bob_id, node
from test_files import S3_ENDPOINT, SECRET, URL, s3

from api_py.run_report import RULES_PATH

pytestmark = [pytest.mark.anyio]
needs_services = pytest.mark.skipif(
    not URL or not S3_ENDPOINT, reason="TEST_DATABASE_URL and S3_ENDPOINT are not set"
)

RULES = f"/files/{RULES_PATH}"


@pytest.fixture
async def api(database):
    async with Client(database, SECRET, s3=s3()) as (client, _app):
        yield client


async def versions(api, path: str, place: str, headers=ALICE) -> list[dict]:
    answer = await api.get(f"/files/{path}?{place}&versions", headers=headers)
    assert answer.status_code == 200, answer.text
    return answer.json()["versions"]


async def run_reads(api, run: str, headers=ALICE) -> list[dict]:
    answer = await api.get(f"/experiments/{run}/reads", headers=headers)
    assert answer.status_code == 200, answer.text
    return answer.json()["reads"]


async def start(api, headers=ALICE, **body) -> dict:
    made = await api.post(
        "/experiments/runs", headers=headers, json={"nodeId": None, "title": "Etch", **body}
    )
    assert made.status_code == 201, made.text
    return made.json()


@needs_services
async def test_a_past_version_reads_as_it_was(api):
    await api.get("/access", headers=ALICE)
    await api.put("/files/notes/a.md", headers=ALICE, content=b"first")
    await api.put("/files/notes/a.md", headers=ALICE, content=b"second")
    await api.put("/files/notes/b.md", headers=ALICE, content=b"other")
    newest, oldest = await versions(api, "notes/a.md", "node=")

    old = await api.get(f"/files/notes/a.md?version={oldest['id']}", headers=ALICE)
    assert old.status_code == 200, old.text
    assert old.content == b"first"
    assert old.headers["etag"] == f'"{oldest["sha256"]}"'
    assert old.headers["content-security-policy"] == "sandbox"
    assert old.headers["x-content-type-options"] == "nosniff"
    assert (
        await api.get(f"/files/notes/a.md?version={newest['id']}", headers=ALICE)
    ).content == b"second"
    # The live file is still the newest.
    assert (await api.get("/files/notes/a.md", headers=ALICE)).content == b"second"
    # An unchanged version answers 304, as the live file does.
    same = await api.get(
        f"/files/notes/a.md?version={oldest['id']}",
        headers={**ALICE, "if-none-match": f'"{oldest["sha256"]}"'},
    )
    assert same.status_code == 304

    # Only that file's own versions: another file's, a made-up or malformed id is a missing file.
    [other] = await versions(api, "notes/b.md", "node=")
    for wrong in (other["id"], "00000000-0000-4000-8000-000000000000", "nope", ""):
        answer = await api.get(f"/files/notes/a.md?version={wrong}", headers=ALICE)
        assert answer.status_code == 404, wrong
        assert answer.json() == {"error": "Not found"}

    both = await api.get(f"/files/notes/a.md?versions&version={oldest['id']}", headers=ALICE)
    assert both.status_code == 400
    assert both.json() == {"error": "Ask for ?versions or for one ?version, not both"}


@needs_services
async def test_a_version_never_opens_another_place(api):
    await api.get("/access", headers=ALICE)
    await api.get("/access", headers=BOB)
    private = await node(api, "Private")
    etch = await node(api, "Etch")
    await api.put(f"/files/data/a.csv?node={private}", headers=ALICE, content=b"x\n1\n")
    run = await start(api, nodeId=etch, inputs=[{"path": "data/a.csv", "node": private}])
    [recorded] = run["provenance"]["inputs"]

    # The node's version id doesn't open the run's copy, nor the other way round.
    [copy] = await versions(api, "inputs/a.csv", f"experiment={run['id']}")
    assert copy["sha256"] == recorded["sha256"] and copy["id"] != recorded["version"]
    in_run = f"/files/inputs/a.csv?experiment={run['id']}"
    original = f"/files/data/a.csv?node={private}"
    assert (
        await api.get(f"{in_run}&version={recorded['version']}", headers=ALICE)
    ).status_code == 404
    assert (await api.get(f"{original}&version={copy['id']}", headers=ALICE)).status_code == 404

    # Someone who can see the run, but not the input's original node, reads the recorded copy,
    # and the original's version id is no way into that node.
    await api.patch(f"/experiments/{run['id']}", headers=ALICE, json={"status": "shared"})
    await api.post(
        "/access/grants",
        headers=ALICE,
        json={
            "node": etch,
            "principalType": "user",
            "principalId": await bob_id(api),
            "role": "viewer",
        },
    )
    assert (await api.get(f"{in_run}&version={copy['id']}", headers=BOB)).content == b"x\n1\n"
    refused = await api.get(f"{original}&version={recorded['version']}", headers=BOB)
    assert refused.status_code == 404


@needs_services
async def test_an_agent_reading_the_rules_is_recorded_once_per_version(api):
    await api.get("/access", headers=ALICE)
    claude = storage_token("kc|alice", via="remote")
    tool = storage_token("kc|alice", via="mcp:lab")
    run = await start(api, headers=claude)
    rules = f"{RULES}?experiment={run['id']}"
    assert (await api.put(rules, headers=ALICE, content=b"R1")).status_code == 200

    # A person looking at the Rules isn't the run reading them.
    assert (await api.get(rules, headers=ALICE)).content == b"R1"
    assert await run_reads(api, run["id"]) == []

    assert (await api.get(rules, headers=claude)).content == b"R1"
    assert (await api.get(rules, headers=claude)).status_code == 200
    assert (await api.get(rules, headers=tool)).status_code == 200
    [first] = await run_reads(api, run["id"])
    [v1] = await versions(api, RULES_PATH, f"experiment={run['id']}")
    assert {k: first[k] for k in ("path", "version", "sha256", "via")} == {
        "path": RULES_PATH, "version": v1["id"], "sha256": v1["sha256"], "via": "remote",
    }  # fmt: skip
    assert first["by"]["name"] == "Alice" and first["readAt"].endswith("Z")

    # Other files aren't recorded; a rewrite, read again, is the second version.
    await api.put(f"/files/notes.md?experiment={run['id']}", headers=ALICE, content=b"n")
    await api.get(f"/files/notes.md?experiment={run['id']}", headers=claude)
    await api.put(rules, headers=ALICE, content=b"R2")
    await api.get(rules, headers=tool)
    reads = await run_reads(api, run["id"])
    v2, _ = await versions(api, RULES_PATH, f"experiment={run['id']}")
    assert [(r["version"], r["via"]) for r in reads] == [
        (v1["id"], "remote"),
        (v2["id"], "mcp:lab"),
    ]
    # Reading a named past version records that version, once.
    await api.get(f"{rules}&version={v1['id']}", headers=tool)
    assert len(await run_reads(api, run["id"])) == 2

    finished = await api.post(
        f"/experiments/{run['id']}/finish", headers=claude, json={"results": {"ok": 1}}
    )
    assert finished.status_code == 200, finished.text
    p = finished.json()["provenance"]
    assert p["files"] == {RULES_PATH: {"version": v2["id"], "sha256": v2["sha256"]}}
    assert [(r["path"], r["version"], r["via"]) for r in p["reads"]] == [
        (RULES_PATH, v1["id"], "remote"),
        (RULES_PATH, v2["id"], "mcp:lab"),
    ]
    report = (await api.get(f"/files/report.md?experiment={run['id']}", headers=ALICE)).text
    assert f'rules_read: ["{v1["sha256"]}","{v2["sha256"]}"]\n' in report

    # After it finished, a read changes nothing.
    await api.put(rules, headers=ALICE, content=b"R3")
    await api.get(rules, headers=claude)
    assert len(await run_reads(api, run["id"])) == 2


@needs_services
async def test_reads_need_someone_who_works_on_the_run(api):
    await api.get("/access", headers=ALICE)
    await api.get("/access", headers=BOB)
    run = await start(api)
    rules = f"{RULES}?experiment={run['id']}"
    await api.put(rules, headers=ALICE, content=b"R1")
    await api.patch(f"/experiments/{run['id']}", headers=ALICE, json={"status": "shared"})
    await api.post(
        "/access/grants",
        headers=ALICE,
        json={
            "node": None,
            "principalType": "user",
            "principalId": await bob_id(api),
            "role": "viewer",
        },
    )
    # Bob's Claude can read the shared run's Rules, but that isn't the run reading them.
    assert (await api.get(rules, headers=storage_token("kc|bob", via="remote"))).content == b"R1"
    assert await run_reads(api, run["id"]) == []
    assert await run_reads(api, run["id"], headers=BOB) == []

    # Nobody who can't see the run sees what it read.
    draft = await start(api)
    assert (await api.get(f"/experiments/{draft['id']}/reads", headers=BOB)).status_code == 404
    assert (await api.post(f"/experiments/{draft['id']}/reads", headers=ALICE)).status_code == 405


@needs_services
async def test_a_finish_without_rules_says_so(api):
    await api.get("/access", headers=ALICE)
    claude = storage_token("kc|alice", via="remote")
    run = await start(api, headers=claude)
    rules = f"{RULES}?experiment={run['id']}"
    await api.put(rules, headers=ALICE, content=b"R1")
    await api.get(rules, headers=claude)
    assert (await api.delete(rules, headers=ALICE)).status_code == 200
    finished = await api.post(
        f"/experiments/{run['id']}/finish", headers=claude, json={"results": {}}
    )
    p = finished.json()["provenance"]
    assert p["files"] == {RULES_PATH: None}
    assert [r["path"] for r in p["reads"]] == [RULES_PATH]

    # A run with no Rules at all says nothing about them in its report.
    plain = await start(api, headers=claude)
    done = await api.post(
        f"/experiments/{plain['id']}/finish", headers=claude, json={"results": {}}
    )
    assert done.json()["provenance"]["files"] == {RULES_PATH: None}
    report = (await api.get(f"/files/report.md?experiment={plain['id']}", headers=ALICE)).text
    assert "rules_read" not in report


@needs_services
async def test_callers_cant_write_the_servers_record(api):
    await api.get("/access", headers=ALICE)
    run = await start(api, provenance={"files": {"x": 1}, "reads": [1], "model": "m"})
    assert "files" not in run["provenance"] and "reads" not in run["provenance"]
    assert run["provenance"]["model"] == "m"


@needs_services
async def test_a_run_marked_done_in_the_panel_keeps_its_evidence(api):
    await api.get("/access", headers=ALICE)
    claude = storage_token("kc|alice", via="remote")
    run = await start(api, headers=claude)
    rules = f"{RULES}?experiment={run['id']}"
    await api.put(rules, headers=ALICE, content=b"R1")
    await api.get(rules, headers=claude)
    [v1] = await versions(api, RULES_PATH, f"experiment={run['id']}")

    # The panel ends a run with a PATCH, not /finish: it records the same.
    done = await api.patch(f"/experiments/{run['id']}", headers=ALICE, json={"state": "done"})
    assert done.status_code == 200, done.text
    p = done.json()["provenance"]
    assert p["finishedAt"].endswith("Z")
    assert p["files"] == {RULES_PATH: {"version": v1["id"], "sha256": v1["sha256"]}}
    assert [r["version"] for r in p["reads"]] == [v1["id"]]
    report = (await api.get(f"/files/report.md?experiment={run['id']}", headers=ALICE)).text
    assert f'rules_read: ["{v1["sha256"]}"]\n' in report

    # Editing it afterwards leaves what it ended with alone.
    await api.put(rules, headers=ALICE, content=b"R2")
    again = await api.patch(f"/experiments/{run['id']}", headers=ALICE, json={"title": "Etch 2"})
    assert again.json()["provenance"]["files"] == p["files"]
    assert again.json()["provenance"]["finishedAt"] == p["finishedAt"]


@needs_services
async def test_a_read_during_a_finish_waits_for_it(api, database):
    await api.get("/access", headers=ALICE)
    claude = storage_token("kc|alice", via="remote")
    run = await start(api, headers=claude)
    rules = f"{RULES}?experiment={run['id']}"
    await api.put(rules, headers=ALICE, content=b"R1")

    # Another request is finishing the run: it holds the row while it reads the evidence.
    async with await psycopg.AsyncConnection.connect(database) as finishing:
        await finishing.execute("SELECT 1 FROM experiments WHERE id = %s FOR UPDATE", (run["id"],))
        reading = asyncio.create_task(api.get(rules, headers=claude))
        await asyncio.sleep(0.3)
        assert not reading.done()
        await finishing.execute("UPDATE experiments SET state = 'done' WHERE id = %s", (run["id"],))
        await finishing.commit()
    async with asyncio.timeout(10):
        answer = await reading
    # The agent still gets the file; the ended run doesn't gain a read its record lacks.
    assert answer.content == b"R1"
    assert await run_reads(api, run["id"]) == []
