"""/experiments and experiments' files served by api-py, against a migrated Postgres and an S3-compatible store.

Needs TEST_DATABASE_URL and S3_ENDPOINT, as test_files.py. The conformance
suite and the storage e2e (runs.spec.ts) run the same routes against the spec
and the app.
"""

from __future__ import annotations

import re

import pytest
from support import ALICE, BOB, Client, forwarded, storage_token
from test_files import S3_ENDPOINT, SECRET, URL, s3

from api_py.experiments import ExperimentError, clean_input, same_json
from api_py.run_report import js_json, js_number, report_front_matter, with_front_matter

pytestmark = [pytest.mark.anyio]
needs_services = pytest.mark.skipif(not URL or not S3_ENDPOINT, reason="TEST_DATABASE_URL and S3_ENDPOINT are not set")


@pytest.fixture
async def api(database):
    async with Client(database, SECRET, s3=s3()) as (client, _app):
        yield client


async def node(api, name: str = "Etch") -> str:
    made = await api.post("/nodes", headers=ALICE, json={"parentId": None, "name": name})
    assert made.status_code == 201, made.text
    return made.json()["id"]


async def audit(api, kind: str = "experiment") -> list[dict]:
    return (await api.get(f"/access/audit?kind={kind}", headers=ALICE)).json()["entries"]


def test_numbers_are_written_as_javascript_writes_them():
    assert [js_number(n) for n in (1.0, -0.0, 1e21, 1e20, 1e-7, 1.5e-6, 2**53, 0.1)] == [
        "1", "0", "1e+21", "100000000000000000000", "1e-7", "0.0000015", "9007199254740992", "0.1",
    ]  # fmt: skip
    assert js_json({"a": [1.0, "x\n", None, True]}) == '{"a":[1,"x\\n",null,true]}'


def test_clean_input():
    assert clean_input({"title": " a\u00a0 b ", "params": {}}) == {"title": "a b", "params": {}}
    with pytest.raises(ExperimentError, match=r"^params is too large \(at most 65536 characters of JSON\)$"):
        clean_input({"params": {"k": "v" * 65530}})
    with pytest.raises(ExperimentError, match="^The hypothesis is at most 20000 characters$"):
        clean_input({"hypothesis": "😀" * 10001})
    assert same_json({"a": [1, 2.0]}, {"a": [1.0, 2]}) and not same_json({"a": True}, {"a": 1})


def test_report_front_matter():
    run = {
        "id": "r1",
        "title": "Etch rate",
        "state": "running",
        "params": {"temp": 60.0},
        "results": {},
        "provenance": {
            "startedBy": {"id": "u1", "name": None},
            "startedAt": "2026-11-11T00:00:00.000Z",
            "model": "m",
            "rerunOf": {"id": "r0"},
            "inputs": [{"path": "inputs/a.csv", "from": {"node": None, "path": "a.csv"}, "sha256": "ab", "size": 3}],
        },
    }
    assert report_front_matter(run) == (
        "---\n"
        'run: "r1"\n'
        'title: "Etch rate"\n'
        'state: "running"\n'
        'started_by: "u1"\n'
        'started_at: "2026-11-11T00:00:00.000Z"\n'
        'model: "m"\n'
        'rerun_of: "r0"\n'
        'inputs: [{"path":"inputs/a.csv","from":"a.csv","sha256":"ab"}]\n'
        'params: {"temp":60}\n'
        "---\n"
    )
    assert with_front_matter("# Old\n", "---\nx: 1\n---\n") == "---\nx: 1\n---\n\n# Old\n"
    assert with_front_matter("---\r\na: 2\r\n---\r\n\nBody", "---\nx: 1\n---\n") == "---\nx: 1\n---\n\nBody"
    assert with_front_matter("", "---\nx: 1\n---\n") == "---\nx: 1\n---\n"


@needs_services
async def test_experiments_fork_list_change_and_delete(api):
    await api.get("/access", headers=ALICE)
    await api.get("/access", headers=BOB)
    etch = await node(api)
    await api.put(f"/files/notes/a.md?node={etch}", headers=ALICE, content=b"node copy")

    made = await api.post(
        "/experiments", headers=ALICE, json={"nodeId": etch, "title": "  Try\n it ", "params": {"a": 1}}
    )
    assert made.status_code == 201, made.text
    exp = made.json()
    assert {k: exp[k] for k in ("nodeId", "title", "hypothesis", "params", "results", "status", "state")} == {
        "nodeId": etch, "title": "Try it", "hypothesis": "", "params": {"a": 1}, "results": {},
        "status": "draft", "state": "ready",
    }  # fmt: skip
    assert (exp["fileCount"], exp["access"], exp["mine"], exp["authorName"]) == (1, "writer", True, "Alice")
    assert exp["forkedAt"].endswith("Z") and exp["provenance"] == {}
    root = (await api.post("/experiments", headers=ALICE, json={"nodeId": None, "title": "Root"})).json()
    assert root["fileCount"] == 0

    # The fork has its own copy of the node's files.
    await api.put(f"/files/notes/a.md?experiment={exp['id']}", headers=ALICE, content=b"changed")
    assert (await api.get(f"/files/notes/a.md?node={etch}", headers=ALICE)).content == b"node copy"
    assert (await api.get(f"/files/notes/a.md?experiment={exp['id']}", headers=ALICE)).content == b"changed"

    def ids(answer):
        return [e["id"] for e in answer.json()["experiments"]]

    assert ids(await api.get("/experiments", headers=ALICE)) == [root["id"], exp["id"]]
    assert ids(await api.get(f"/experiments?node={etch}", headers=ALICE)) == [exp["id"]]
    assert ids(await api.get("/experiments?node=root", headers=ALICE)) == [root["id"]]
    assert ids(await api.get("/experiments?node=", headers=ALICE)) == [root["id"], exp["id"]]
    assert (await api.get("/experiments?node=nope", headers=ALICE)).status_code == 404

    # Drafts are their author's; shared ones are seen by whoever sees the node.
    await api.post("/access/grants", headers=ALICE, json={"node": etch, "principalType": "user",
                                                           "principalId": await bob_id(api), "role": "viewer"})  # fmt: skip
    assert ids(await api.get("/experiments", headers=BOB)) == []
    assert (await api.get(f"/experiments/{exp['id']}", headers=BOB)).json() == {"error": "Experiment not found"}
    shared = await api.patch(f"/experiments/{exp['id']}", headers=ALICE, json={"status": "shared"})
    assert shared.json()["status"] == "shared"
    seen = (await api.get(f"/experiments/{exp['id']}", headers=BOB)).json()
    assert (seen["access"], seen["mine"]) == ("reader", False)
    refused = await api.patch(f"/experiments/{exp['id']}", headers=BOB, json={"title": "Mine"})
    assert refused.json() == {"error": "Only the experiment's author can change it"}
    write = await api.put(f"/files/x.md?experiment={exp['id']}", headers=BOB, content=b"x")
    assert (write.status_code, write.json()["error"]) == (
        403, "Only the experiment's author can change its files, and not once it is archived",
    )  # fmt: skip
    assert (await api.get(f"/files/notes/a.md?experiment={exp['id']}", headers=BOB)).content == b"changed"

    # Archived: read only, apart from the status.
    await api.patch(f"/experiments/{exp['id']}", headers=ALICE, json={"status": "archived"})
    archived = await api.patch(f"/experiments/{exp['id']}", headers=ALICE, json={"title": "Again"})
    assert archived.json() == {"error": "This experiment is archived; restore it to change it"}
    assert (await api.put(f"/files/x.md?experiment={exp['id']}", headers=ALICE, content=b"x")).status_code == 403
    back = await api.patch(f"/experiments/{exp['id']}", headers=ALICE, json={"status": "draft", "title": "Back"})
    assert (back.json()["status"], back.json()["title"]) == ("draft", "Back")

    assert (await api.delete(f"/experiments/{exp['id']}", headers=BOB)).status_code == 404  # a draft again
    assert (await api.delete(f"/experiments/{exp['id']}", headers=ALICE)).json() == {"deleted": exp["id"]}
    assert (await api.get(f"/experiments/{exp['id']}", headers=ALICE)).status_code == 404
    assert (await api.get(f"/files?experiment={exp['id']}", headers=ALICE)).json() == {"error": "Experiment not found"}
    assert (await api.delete(f"/experiments/{exp['id']}", headers=ALICE)).status_code == 404

    actions = [(e["action"], sorted(e["target"])) for e in await audit(api)]
    assert ("experiment.create", ["experiment", "node", "title"]) in actions
    assert ("experiment.delete", ["experiment"]) in actions
    fields = [e["target"]["fields"] for e in await audit(api) if e["action"] == "experiment.update"]
    assert ["title", "status"] in fields  # in the order http.ts reads the body


async def bob_id(api) -> str:
    return next(u["id"] for u in (await api.get("/access/users", headers=ALICE)).json()["users"] if u["name"] == "Bob")


@needs_services
async def test_bodies_and_methods(api):
    await api.get("/access", headers=ALICE)
    expected = (
        "Expected {title?, hypothesis?: string, params?, results?: object, status?: draft|shared|archived, "
        "state?: ready|running|done|failed}"
    )
    bad_create = await api.post("/experiments", headers=ALICE, json={"title": "x"})
    assert bad_create.json() == {"error": f"Expected {{nodeId: string|null, title: string, …}}; {expected}"}
    assert (await api.post("/experiments", headers=ALICE, json={"nodeId": None, "title": 3})).status_code == 400

    async def create_error(**body):
        answer = await api.post("/experiments", headers=ALICE, json={"nodeId": None, **body})
        assert answer.status_code == 400, answer.text
        return answer.json()["error"]

    assert await create_error() == "An experiment needs a title"
    assert await create_error(title=" \u3000 ") == "An experiment needs a title"
    assert await create_error(title="😀" * 101) == "Titles are at most 200 characters"
    assert await create_error(title="x", params=[1]) == 'params must be an object, e.g. {"temperature": 60}'
    assert await create_error(title="x", results=None) == 'results must be an object, e.g. {"temperature": 60}'
    assert await create_error(title="x", status="gone") == "Status must be draft, shared or archived"
    assert await create_error(title="x", state="gone") == "State must be ready, running, done or failed"
    assert await create_error(title="x", params={"k": "v" * 65536}) == bad_create.json()["error"]  # body over 64 KiB
    # A new experiment is a draft whatever status says.
    made = await api.post("/experiments", headers=ALICE, json={"nodeId": None, "title": "x", "status": "shared"})
    exp = made.json()
    assert (made.status_code, exp["status"]) == (201, "draft")
    assert (await api.post("/experiments", headers=ALICE, json={"nodeId": "nope", "title": "x"})).status_code == 404

    assert (await api.put("/experiments", headers=ALICE)).status_code == 405
    assert (await api.put(f"/experiments/{exp['id']}", headers=ALICE)).status_code == 405
    assert (await api.get("/experiments/runs", headers=ALICE)).status_code == 405
    assert (await api.get(f"/experiments/{exp['id']}/finish", headers=ALICE)).status_code == 405
    assert (await api.get(f"/experiments/{exp['id']}/inputs", headers=ALICE)).status_code == 405
    assert (await api.patch(f"/experiments/{exp['id']}", headers=ALICE, content=b"[]")).json() == {"error": expected}
    assert (await api.get("/experiments/not-a-uuid", headers=ALICE)).status_code == 404
    assert (await api.get("/experiments/%E0%A4%A", headers=ALICE)).status_code == 500  # decodeURIComponent throws
    # %2F decodes before the route is picked, as in http.ts.
    assert (await api.post(f"/experiments/{exp['id']}%2Ffinish", headers=ALICE, json={})).status_code == 400

    runs = await api.post("/experiments/runs", headers=ALICE, json={})
    assert runs.json() == {"error": "A new run needs a title (or rerunOf)"}
    for body in (
        {"title": "x", "state": "done"},
        {"title": "x", "results": {}},
        {"title": "x", "params": None},
        {"title": "x", "provenance": None},
        {"title": "x", "provenance": {"chat": 1}},
        {"title": "x", "provenance": {"skill": {"name": "s", "version": "1"}}},
        {"title": "x", "provenance": {"skill": {"name": "s", "source": None}}},
        {"title": "x", "provenance": {"tools": {"read": 1}}},
        {"title": "x", "provenance": {"note": "x" * 16384}},
        {"title": "x", "rerunOf": None},
        {"title": "x", "nodeId": 3},
        {"title": "x", "inputs": [{"path": "a", "as": None}]},
        {"title": 3},
    ):
        assert (await api.post("/experiments/runs", headers=ALICE, json=body)).status_code == 400, body
    finish = await api.post(f"/experiments/{exp['id']}/finish", headers=ALICE, json={"results": [], "state": "done"})
    assert finish.json() == {"error": "Expected {results: object, state?: done|failed}"}
    inputs = await api.post(f"/experiments/{exp['id']}/inputs", headers=ALICE, json={"inputs": "x"})
    assert inputs.json() == {
        "error": "Expected {inputs: [{path: string, node?: string|null, experiment?: string|null, as?: string}]}"
    }
    none = await api.post(f"/experiments/{exp['id']}/inputs", headers=ALICE, json={"inputs": []})
    assert none.json() == {"error": "Name at least one file to add as an input"}


@needs_services
async def test_runs_record_inputs_finish_and_rerun(api):
    await api.get("/access", headers=ALICE)
    etch = await node(api)
    await api.put(f"/files/data/a.csv?node={etch}", headers=ALICE, content=b"x,y\n1,2\n")
    await api.put("/files/notes/b.md", headers=ALICE, content=b"# B\n")

    made = await api.post(
        "/experiments/runs",
        headers=ALICE,
        json={
            "nodeId": etch,
            "title": "Etch rate",
            "params": {"temp": 60.0},
            "inputs": [{"path": "data/a.csv", "node": etch}],
            "provenance": {"chat": "c1", "model": "m", "startedAt": "ignored", "extra": [1]},
        },
    )
    assert made.status_code == 201, made.text
    run = made.json()
    p = run["provenance"]
    assert run["state"] == "running" and run["fileCount"] == 3  # the fork, its input and report.md
    assert (p["chat"], p["model"], p["extra"], p["startedBy"]) == ("c1", "m", [1], {"id": run["authorId"], "name": "Alice"})
    assert re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z", p["startedAt"])
    [recorded] = p["inputs"]
    assert {k: recorded[k] for k in ("path", "from", "size")} == {
        "path": "inputs/a.csv", "from": {"node": etch, "experiment": None, "path": "data/a.csv"}, "size": 8,
    }  # fmt: skip
    files = {f["path"] for f in (await api.get(f"/files?experiment={run['id']}", headers=ALICE)).json()["files"]}
    assert files == {"data/a.csv", "inputs/a.csv", "report.md"}
    report = (await api.get(f"/files/report.md?experiment={run['id']}", headers=ALICE)).text
    assert report == report_front_matter(run) + "\n# Etch rate\n"
    # Integers past 2**53 are read as JSON.parse reads them, so the record and its report agree.
    big = await api.post(
        "/experiments/runs",
        headers=ALICE,
        content=b'{"nodeId": null, "title": "Big", "params": {"n": 9007199254740993, "m": 12345678901234567890}}',
    )
    assert big.json()["params"] == {"m": 12345678901234567000, "n": 9007199254740992}
    big_report = (await api.get(f"/files/report.md?experiment={big.json()['id']}", headers=ALICE)).text
    assert 'params: {"m":12345678901234567000,"n":9007199254740992}\n' in big_report
    assert 'params: {"temp":60}\n' in report and 'started_by: "Alice"\n' in report

    # More inputs, from the root this time.
    added = await api.post(
        f"/experiments/{run['id']}/inputs", headers=ALICE, json={"inputs": [{"path": "notes/b.md", "as": "b.md"}]}
    )
    assert [i["path"] for i in added.json()["provenance"]["inputs"]] == ["inputs/a.csv", "inputs/b.md"]
    again = await api.post(f"/experiments/{run['id']}/inputs", headers=ALICE, json={"inputs": [{"path": "notes/b.md"}]})
    assert again.json() == {"error": "The run already has an input at inputs/b.md; give this one another name"}
    missing = await api.post(f"/experiments/{run['id']}/inputs", headers=ALICE, json={"inputs": [{"path": "no.md"}]})
    assert missing.json() == {"error": "No file at no.md to use as an input"}
    report = (await api.get(f"/files/report.md?experiment={run['id']}", headers=ALICE)).text
    assert '"path":"inputs/b.md","from":"notes/b.md"' in report

    # Finishing records the results once; the same call again is fine.
    done = await api.post(f"/experiments/{run['id']}/finish", headers=ALICE, json={"results": {"rate": 1.5, "ok": True}})
    assert (done.status_code, done.json()["state"], done.json()["results"]) == (200, "done", {"ok": True, "rate": 1.5})
    assert "finishedAt" in done.json()["provenance"]
    same = await api.post(f"/experiments/{run['id']}/finish", headers=ALICE, json={"results": {"ok": True, "rate": 1.5}})
    assert same.json() == done.json()
    other = await api.post(f"/experiments/{run['id']}/finish", headers=ALICE, json={"results": {"ok": 1, "rate": 1.5}})
    assert other.json() == {"error": "This run already finished (done); start a new run to try again"}
    late = await api.post(f"/experiments/{run['id']}/inputs", headers=ALICE, json={"inputs": [{"path": "notes/b.md"}]})
    assert late.json() == {"error": "This run already finished (done); start a new run to add inputs"}
    report = (await api.get(f"/files/report.md?experiment={run['id']}", headers=ALICE)).text
    assert 'state: "done"\n' in report and 'results: {"ok":true,"rate":1.5}\n' in report
    assert report.endswith("---\n\n# Etch rate\n")

    # A rerun reads the inputs at the content the run recorded, even after they changed.
    await api.put(f"/files/inputs/a.csv?experiment={run['id']}", headers=ALICE, content=b"edited")
    rerun = await api.post("/experiments/runs", headers=ALICE, json={"rerunOf": run["id"], "params": {"temp": 70}})
    assert rerun.status_code == 201, rerun.text
    second = rerun.json()
    assert (second["title"], second["nodeId"], second["params"]) == ("Etch rate (rerun)", etch, {"temp": 70})
    assert second["provenance"]["rerunOf"] == {"id": run["id"]}
    pinned = (await api.get(f"/files/inputs/a.csv?experiment={second['id']}", headers=ALICE)).content
    assert pinned == b"x,y\n1,2\n"
    assert [i["from"]["experiment"] for i in second["provenance"]["inputs"]] == [run["id"], run["id"]]
    at_root = await api.post("/experiments/runs", headers=ALICE, json={"rerunOf": run["id"], "nodeId": None, "inputs": []})
    assert (at_root.json()["nodeId"], at_root.json()["provenance"]["inputs"]) == (None, [])

    entries = await audit(api)
    created = [e["target"] for e in entries if e["action"] == "experiment.create"]
    assert {"experiment": run["id"], "node": etch, "title": "Etch rate", "inputs": ["inputs/a.csv"]} in created
    assert any(e["action"] == "experiment.inputs" for e in entries)


@needs_services
async def test_storage_tokens(api):
    await api.get("/access", headers=ALICE)
    claude = storage_token("kc|alice")
    made = await api.post("/experiments/runs", headers=claude, json={"nodeId": None, "title": "By Claude"})
    assert made.status_code == 201, made.text
    run = made.json()
    report = await api.get(f"/files/report.md?experiment={run['id']}", headers=ALICE)
    assert report.headers["x-file-author"] == "agent"
    written = await api.put(f"/files/out.csv?experiment={run['id']}", headers=claude, content=b"1")
    assert written.status_code == 200
    assert (await api.patch(f"/experiments/{run['id']}", headers=claude, json={"title": "Renamed"})).status_code == 200
    status = await api.patch(f"/experiments/{run['id']}", headers=claude, json={"status": "draft"})
    refused = "Claude doesn't share or archive experiments with a storage token: leave out status"
    assert status.json() == {"error": refused}
    shared = await api.post("/experiments", headers=claude, json={"nodeId": None, "title": "x", "status": "shared"})
    assert shared.json() == {"error": refused}
    finish = await api.post(f"/experiments/{run['id']}/finish", headers=claude, json={"results": {"n": 1}})
    assert finish.status_code == 200
    gone = await api.delete(f"/experiments/{run['id']}", headers=claude)
    assert gone.json() == {"error": "Claude doesn't delete experiments or move folders into them"}
    assert (await api.post(f"/experiments/{run['id']}/move", headers=claude)).status_code == 403


@needs_services
async def test_upload_and_other_spellings_stay_with_typescript(api):
    assert (await api.post("/experiments/upload", headers=ALICE)).json() == {"from": "typescript"}
    assert (await api.get("/experiments/%75pload", headers=ALICE)).json() == {"from": "typescript"}
    assert (await api.get("/%65xperiments", headers=ALICE)).json() == {"from": "typescript"}
    assert forwarded == ["POST /experiments/upload", "GET /experiments/%75pload", "GET /%65xperiments"]
    forwarded.clear()
