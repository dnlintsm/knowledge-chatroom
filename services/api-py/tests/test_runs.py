"""Runs of an Experiment (029_runs.sql, docs/experiment-runs.md).

Needs TEST_DATABASE_URL and S3_ENDPOINT, as test_files.py; the migration test
needs only the database.
"""

from __future__ import annotations

import uuid
from collections.abc import AsyncIterator

import psycopg
import pytest
from psycopg import conninfo
from support import ALICE, BOB, Client, storage_token, user
from test_experiment_restore import user_id, view_everything
from test_files import S3_ENDPOINT, SECRET, URL, s3

from api_py import db
from api_py.config import DEFAULT_MIGRATIONS_DIR

pytestmark = [pytest.mark.anyio]
needs_services = pytest.mark.skipif(
    not URL or not S3_ENDPOINT, reason="TEST_DATABASE_URL and S3_ENDPOINT are not set"
)

CAROL = user("kc|carol", "Carol")
RUNS = "029_runs.sql"


@pytest.fixture(params=[True, False], ids=["row-security-on", "row-security-off"])
async def either(database, request):
    """The API with row security on, and with only the app's own checks."""
    async with Client(database, SECRET, s3=s3()) as (client, app):
        for who in (ALICE, BOB, CAROL):
            await client.get("/access", headers=who)
        assert await app.state.storage_ready()
        app.state.storage.row_security = request.param
        yield client


async def experiment(api, headers=ALICE, status: str | None = None, **body) -> dict:
    """A new Experiment at the root; a new one is a draft, so another status is set after."""
    made = await api.post(
        "/experiments",
        headers=headers,
        json={"nodeId": None, "title": "Etch", "params": {"power": 300}, **body},
    )
    assert made.status_code == 201, made.text
    if status is None:
        return made.json()
    changed = await api.patch(
        f"/experiments/{made.json()['id']}", headers=headers, json={"status": status}
    )
    assert changed.status_code == 200, changed.text
    return changed.json()


async def start(api, exp: str, headers=ALICE, **body) -> dict:
    made = await api.post(f"/experiments/{exp}/runs", headers=headers, json=body)
    assert made.status_code == 201, made.text
    return made.json()


async def finish(api, run: str, results: dict, headers=ALICE, state: str = "done") -> dict:
    done = await api.post(
        f"/runs/{run}/finish", headers=headers, json={"results": results, "state": state}
    )
    assert done.status_code == 200, done.text
    return done.json()


async def write(api, exp: str, path: str, data: bytes) -> None:
    wrote = await api.put(f"/files/{path}?experiment={exp}", headers=ALICE, content=data)
    assert wrote.status_code == 200, wrote.text


async def runs_of(api, exp: str, headers=ALICE, query: str = "") -> list[dict]:
    answer = await api.get(f"/experiments/{exp}/runs{query}", headers=headers)
    assert answer.status_code == 200, answer.text
    return answer.json()["runs"]


@needs_services
async def test_runs_keep_what_they_read_and_wrote(either):
    api = either
    exp = (await experiment(api))["id"]
    await write(api, exp, "data/out.csv", b"first")

    one = await start(api, exp)
    assert (one["number"], one["state"], one["params"]) == (1, "running", {"power": 300})
    assert one["startedBy"]["name"] == "Alice" and one["record"] is None
    # Another can't start while it runs.
    second = await api.post(f"/experiments/{exp}/runs", headers=ALICE, json={})
    assert second.status_code == 409 and second.json()["running"] == 1

    one = await finish(api, one["id"], {"yield": 0.8})
    assert one["state"] == "done" and one["recordTaken"] == "finish"
    recorded = {f["path"]: f for f in one["record"]}
    assert set(recorded) == {"data/out.csv"}

    # The working copy changes; Run 1's record still reads what it had.
    await write(api, exp, "data/out.csv", b"second")
    two = await start(api, exp, label="  hotter   run ", params={"power": 400})
    assert (two["number"], two["label"], two["params"]) == (2, "hotter run", {"power": 400})
    await finish(api, two["id"], {"yield": 0.9})
    read = await api.get(f"/runs/{one['id']}/files/data/out.csv", headers=ALICE)
    assert read.status_code == 200 and read.content == b"first"
    assert read.headers["content-security-policy"] == "sandbox"
    assert (await api.get(f"/runs/{two['id']}/files/data/out.csv", headers=ALICE)).content == (
        b"second"
    )
    assert (await api.get(f"/runs/{one['id']}/files/nope.csv", headers=ALICE)).status_code == 404
    files = (await api.get(f"/runs/{one['id']}/files", headers=ALICE)).json()
    assert files["taken"] == "finish" and [f["path"] for f in files["files"]] == ["data/out.csv"]

    # Newest first; the Experiment answers as its latest Run, as before.
    assert [r["number"] for r in await runs_of(api, exp)] == [2, 1]
    now = (await api.get(f"/experiments/{exp}", headers=ALICE)).json()
    assert (now["state"], now["results"]) == ("done", {"yield": 0.9})
    assert now["params"] == {"power": 300}

    # A finished Run stays as it ended: the same finish again is fine, another is refused.
    again = await api.post(
        f"/runs/{one['id']}/finish", headers=ALICE, json={"results": {"yield": 0.8}}
    )
    assert again.status_code == 200
    other = await api.post(
        f"/runs/{one['id']}/finish", headers=ALICE, json={"results": {"yield": 1}}
    )
    assert other.status_code == 400 and "already finished" in other.json()["error"]


@needs_services
async def test_a_finished_run_cant_change_even_past_the_app(either, database):
    api = either
    exp = (await experiment(api))["id"]
    run = await start(api, exp)
    await finish(api, run["id"], {"yield": 0.8})
    async with await psycopg.AsyncConnection.connect(database, autocommit=True) as raw:
        for change in (
            "results = '{\"yield\": 1}'",
            "state = 'failed'",
            "params = '{}'",
            'record = \'[{"path": "x"}]\'',
            "provenance = '{}'",
        ):
            with pytest.raises(psycopg.errors.CheckViolation, match="already finished"):
                await raw.execute(f"UPDATE runs SET {change} WHERE id = %s", (run["id"],))  # pyrefly: ignore[bad-argument-type]
        # Its label, archiving and deletion still can.
        await raw.execute("UPDATE runs SET label = 'kept' WHERE id = %s", (run["id"],))


@needs_services
async def test_two_experiments_run_side_by_side(either):
    api = either
    a = (await experiment(api, title="A"))["id"]
    b = (await experiment(api, title="B"))["id"]
    ra, rb = await start(api, a), await start(api, b)
    assert ra["state"] == rb["state"] == "running"
    compared = (await api.get(f"/runs?experiment={a}", headers=ALICE)).json()["runs"]
    assert [r["id"] for r in compared] == [ra["id"]]
    assert compared[0]["experiment"] == {"id": a, "title": "A", "nodeId": None}
    everywhere = (await api.get("/runs", headers=ALICE)).json()["runs"]
    assert {r["id"] for r in everywhere} == {ra["id"], rb["id"]}
    at_root = (await api.get("/runs?node=root", headers=ALICE)).json()["runs"]
    assert {r["id"] for r in at_root} == {ra["id"], rb["id"]}


@needs_services
async def test_who_reruns_where(either):
    api = either
    bob = await user_id(api, "Bob")
    await view_everything(api, bob)
    exp = (await experiment(api, status="shared"))["id"]
    run = await start(api, exp, params={"power": 350})
    await finish(api, run["id"], {"yield": 0.7})

    # Bob can see it, so he can rerun it as his own, but not inside Alice's Experiment.
    inside = await api.post(f"/runs/{run['id']}/rerun", headers=BOB, json={"experiment": exp})
    assert inside.status_code == 403
    own = await api.post(f"/runs/{run['id']}/rerun", headers=BOB, json={"experiment": None})
    assert own.status_code == 201, own.text
    mine = own.json()
    assert mine["number"] == 1 and mine["params"] == {"power": 350}
    assert mine["provenance"]["rerunOf"] == {"id": exp, "run": run["id"]}
    assert mine["experimentId"] != exp
    assert (await api.get(f"/experiments/{mine['experimentId']}", headers=BOB)).json()["mine"]

    # Alice reruns it inside: Run 2, which names Run 1.
    again = await api.post(f"/runs/{run['id']}/rerun", headers=ALICE, json={"experiment": exp})
    assert again.status_code == 201, again.text
    assert again.json()["number"] == 2
    assert again.json()["provenance"]["rerunOf"] == {"id": exp, "run": run["id"]}
    elsewhere = await api.post(
        f"/runs/{run['id']}/rerun", headers=ALICE, json={"experiment": mine["experimentId"]}
    )
    assert elsewhere.status_code == 400


@needs_services
async def test_archive_delete_and_restore_one_run(either):
    api = either
    carol = await user_id(api, "Carol")
    await view_everything(api, carol)
    exp = (await experiment(api, status="shared"))["id"]
    added = await api.put(f"/experiments/{exp}/collaborators/{carol}", headers=ALICE)
    assert added.status_code == 200, added.text
    one = await start(api, exp)
    # A running Run can't be deleted.
    running = await api.delete(f"/runs/{one['id']}", headers=ALICE)
    assert running.status_code == 409
    await finish(api, one["id"], {"yield": 0.5})
    two = await start(api, exp, headers=CAROL)
    await finish(api, two["id"], {"yield": 0.6}, headers=CAROL)

    archived = await api.patch(f"/runs/{one['id']}", headers=CAROL, json={"archived": True})
    assert archived.status_code == 200 and archived.json()["archived"]
    assert [r["number"] for r in await runs_of(api, exp)] == [2]
    assert [r["number"] for r in await runs_of(api, exp, query="?archived=1")] == [2, 1]
    assert [
        r["number"]
        for r in (await api.get(f"/runs?experiment={exp}", headers=ALICE)).json()["runs"]
    ] == [2]

    # Deleting Run 2 moves the Experiment's answer back to Run 1.
    gone = await api.delete(f"/runs/{two['id']}", headers=ALICE)
    assert gone.status_code == 200
    assert (await api.get(f"/runs/{two['id']}", headers=ALICE)).status_code == 404
    deleted = await runs_of(api, exp, headers=CAROL, query="?deleted=1")
    assert [(r["number"], r["deletedBy"]["name"]) for r in deleted] == [(2, "Alice")]
    assert (await api.get(f"/experiments/{exp}", headers=ALICE)).json()["results"] == {"yield": 0.5}

    back = await api.post(f"/runs/{two['id']}/restore", headers=CAROL)
    assert back.status_code == 200 and "deletedAt" not in back.json()
    assert (await api.get(f"/experiments/{exp}", headers=ALICE)).json()["results"] == {"yield": 0.6}
    assert (await api.post(f"/runs/{two['id']}/restore", headers=CAROL)).status_code == 404

    entries = (await api.get("/access/audit?kind=run", headers=ALICE)).json()["entries"]
    actions = [e["action"] for e in entries]
    for action in ("run.start", "run.archive", "run.delete", "run.restore"):
        assert action in actions, actions

    # Bob, who can't see the Experiment, finds none of it.
    for answer in (
        await api.get(f"/runs/{one['id']}", headers=BOB),
        await api.get(f"/experiments/{exp}/runs", headers=BOB),
        await api.get(f"/runs/{one['id']}/files", headers=BOB),
        await api.patch(f"/runs/{one['id']}", headers=BOB, json={"label": "x"}),
        await api.delete(f"/runs/{one['id']}", headers=BOB),
    ):
        assert answer.status_code == 404, answer.text
    assert (await api.get(f"/runs?experiment={exp}", headers=BOB)).json()["runs"] == []

    # A reader can't change Runs; an archived Experiment's are read only.
    bob = await user_id(api, "Bob")
    await view_everything(api, bob)
    assert (
        await api.patch(f"/runs/{one['id']}", headers=BOB, json={"label": "x"})
    ).status_code == 403
    assert (await api.post(f"/experiments/{exp}/runs", headers=BOB, json={})).status_code == 403
    await api.patch(f"/experiments/{exp}", headers=ALICE, json={"status": "archived"})
    assert (await api.post(f"/experiments/{exp}/runs", headers=ALICE, json={})).status_code == 403
    assert (await api.delete(f"/runs/{one['id']}", headers=ALICE)).status_code == 403


@needs_services
async def test_the_routes_before_runs_act_on_the_latest(either):
    api = either
    made = await api.post("/experiments/runs", headers=ALICE, json={"nodeId": None, "title": "Old"})
    assert made.status_code == 201, made.text
    exp = made.json()["id"]
    (only,) = await runs_of(api, exp)
    assert only["state"] == "running" and only["provenance"]["startedBy"]["name"] == "Alice"
    done = await api.post(f"/experiments/{exp}/finish", headers=ALICE, json={"results": {"a": 1}})
    assert done.status_code == 200
    (only,) = await runs_of(api, exp)
    assert (only["state"], only["results"], only["fileCount"]) == ("done", {"a": 1}, 1)

    # A rerun the old way names the Run it reran.
    again = await api.post("/experiments/runs", headers=ALICE, json={"rerunOf": exp})
    assert again.status_code == 201, again.text
    (rerun,) = await runs_of(api, again.json()["id"])
    assert rerun["provenance"]["rerunOf"] == {"id": exp, "run": only["id"]}

    # An experiment marked done through PATCH gets a finished Run.
    plain = await experiment(api, title="Plain")
    assert await runs_of(api, plain["id"]) == []
    marked = await api.patch(f"/experiments/{plain['id']}", headers=ALICE, json={"state": "done"})
    assert marked.status_code == 200, marked.text
    (ended,) = await runs_of(api, plain["id"])
    assert ended["state"] == "done" and ended["recordTaken"] == "finish"


@needs_services
async def test_claude_starts_and_finishes_but_doesnt_delete(either):
    api = either
    claude = storage_token("kc|alice", via="remote")
    exp = (await experiment(api))["id"]
    run = await start(api, exp, headers=claude, provenance={"model": "a-model"})
    assert run["provenance"]["model"] == "a-model"
    await finish(api, run["id"], {"ok": True}, headers=claude)
    labelled = await api.patch(f"/runs/{run['id']}", headers=claude, json={"label": "first"})
    assert labelled.status_code == 200, labelled.text
    assert (await api.get(f"/runs/{run['id']}", headers=claude)).status_code == 200
    for refused in (
        await api.patch(f"/runs/{run['id']}", headers=claude, json={"archived": True}),
        await api.delete(f"/runs/{run['id']}", headers=claude),
        await api.post(f"/runs/{run['id']}/restore", headers=claude),
        await api.get(f"/experiments/{exp}/runs?deleted=1", headers=claude),
    ):
        assert refused.status_code == 403, refused.text


@needs_services
async def test_the_rules_reads_belong_to_their_run(either):
    api = either
    claude = storage_token("kc|alice", via="remote")
    exp = (await experiment(api))["id"]
    rules = f"/files/models/general_rules.md?experiment={exp}"
    await api.put(rules, headers=ALICE, content=b"R1")
    one = await start(api, exp)
    assert (await api.get(rules, headers=claude)).content == b"R1"
    await finish(api, one["id"], {})
    await api.put(rules, headers=ALICE, content=b"R2")
    two = await start(api, exp)
    assert (await api.get(rules, headers=claude)).content == b"R2"
    await api.get(rules, headers=claude)

    def read(answer) -> list[bytes]:
        return [r["sha256"] for r in answer.json()["reads"]]

    first = await api.get(f"/runs/{one['id']}/reads", headers=ALICE)
    second = await api.get(f"/runs/{two['id']}/reads", headers=ALICE)
    assert len(read(first)) == 1 and len(read(second)) == 1 and read(first) != read(second)
    # The route before Runs answers for the latest.
    assert read(await api.get(f"/experiments/{exp}/reads", headers=ALICE)) == read(second)


# Moving today's records over: the database just before 029_runs.sql.


async def _one(conn: psycopg.AsyncConnection, query: str, *params) -> object:
    cur = await conn.execute(query, params)  # pyrefly: ignore[bad-argument-type]
    row = await cur.fetchone()
    return row[0] if row else None


@pytest.fixture
async def before() -> AsyncIterator[psycopg.AsyncConnection]:
    """A database with every migration before Runs, and a connection to it."""
    name = f"api_py_runs_{uuid.uuid4().hex[:12]}"
    async with await psycopg.AsyncConnection.connect(URL, autocommit=True) as admin:  # pyrefly: ignore[bad-argument-type]
        await admin.execute(f'CREATE DATABASE "{name}"')  # pyrefly: ignore[bad-argument-type]
        try:
            url = conninfo.make_conninfo(URL, dbname=name)  # pyrefly: ignore[bad-argument-type]
            async with await psycopg.AsyncConnection.connect(url, autocommit=True) as conn:
                await conn.execute(
                    "CREATE TABLE schema_migrations (name text PRIMARY KEY, applied_at timestamptz DEFAULT now())"
                )
                for migration in db.known_migrations(DEFAULT_MIGRATIONS_DIR):
                    if migration == RUNS:
                        break
                    await conn.execute((DEFAULT_MIGRATIONS_DIR / migration).read_text())  # type: ignore[arg-type]
                yield conn
        finally:
            await admin.execute(f'DROP DATABASE "{name}" WITH (FORCE)')  # pyrefly: ignore[bad-argument-type]


@pytest.mark.skipif(not URL, reason="needs TEST_DATABASE_URL")
async def test_moving_todays_records_over(before):
    conn = before
    ws = str(await _one(conn, "SELECT id FROM workspaces WHERE slug = 'default'"))
    alice = str(
        await _one(conn, "INSERT INTO users (subject, name) VALUES ('alice', 'Alice') RETURNING id")
    )
    blob = "a" * 64
    await conn.execute("INSERT INTO blobs (sha256, size) VALUES (%s, 3)", (blob,))

    async def make(title: str, state: str, provenance: str = "{}") -> str:
        return str(
            await _one(
                conn,
                """
                INSERT INTO experiments (id, workspace_id, author_id, title, params, results, state, provenance)
                VALUES (gen_random_uuid(), %s, %s, %s, '{"p": 1}', '{"r": 2}', %s, %s::jsonb) RETURNING id""",
                ws,
                alice,
                title,
                state,
                provenance,
            )
        )

    never = await make("Never ran", "ready")
    finished = await make(
        "Finished",
        "done",
        f'{{"startedBy": {{"id": "{alice}", "name": "Alice"}}, "startedAt": "2026-01-02T03:04:05Z", "finishedAt": "2026-01-02T04:00:00Z"}}',
    )
    rerun = await make("Rerun", "failed", f'{{"rerunOf": {{"id": "{finished}"}}}}')
    running = await make("Running", "running")
    file_id = await _one(
        conn,
        "INSERT INTO files (workspace_id, experiment_id, path, kind, mime) VALUES (%s, %s, 'report.md', 'note', 'text/markdown') RETURNING id",
        ws,
        finished,
    )
    version = await _one(
        conn,
        "INSERT INTO file_versions (file_id, blob_sha256, size, mime, author_type, author_id) VALUES (%s, %s, 3, 'text/markdown', 'user', %s) RETURNING id",
        file_id,
        blob,
        alice,
    )
    await conn.execute("UPDATE files SET current_version_id = %s WHERE id = %s", (version, file_id))
    await conn.execute(
        "INSERT INTO run_reads (workspace_id, experiment_id, path, version_id, sha256, via) VALUES (%s, %s, 'report.md', %s, %s, 'remote')",
        (ws, finished, version, blob),
    )

    await conn.execute((DEFAULT_MIGRATIONS_DIR / RUNS).read_text())  # type: ignore[arg-type]

    async def runs_of(exp: str) -> list[tuple]:
        cur = await conn.execute(
            "SELECT number, state, params, results, provenance, started_by::text, started_at, finished_at, record, record_taken FROM runs WHERE experiment_id = %s",
            (exp,),
        )
        return await cur.fetchall()

    assert await runs_of(never) == []
    (
        (
            number,
            state,
            params,
            results,
            provenance,
            started_by,
            started_at,
            finished_at,
            record,
            taken,
        ),
    ) = await runs_of(finished)
    assert (number, state, params, results, started_by) == (1, "done", {"p": 1}, {"r": 2}, alice)
    assert started_at.isoformat().startswith("2026-01-02T03:04:05")
    assert finished_at.isoformat().startswith("2026-01-02T04:00:00")
    assert taken == "migration" and [f["path"] for f in record] == ["report.md"]
    assert record[0]["version"] == str(version) and record[0]["sha256"] == blob
    finished_run = str(await _one(conn, "SELECT id FROM runs WHERE experiment_id = %s", finished))
    assert await _one(conn, "SELECT run_id::text FROM run_reads") == finished_run

    ((_, state, *_rest),) = await runs_of(rerun)
    assert state == "failed"
    assert await _one(
        conn, "SELECT provenance->'rerunOf' FROM runs WHERE experiment_id = %s", rerun
    ) == {
        "id": finished,
        "run": finished_run,
    }
    ((_, state, *_rest, record, taken),) = await runs_of(running)
    assert (state, record, taken) == ("running", None, None)
    # The chain stays two Experiments.
    assert await _one(conn, "SELECT count(*) FROM experiments") == 4
    # Running it again adds nothing.
    assert await _one(conn, "SELECT runs_backfill()") == 0


@needs_services
async def test_results_recorded_by_hand_become_run_1_when_a_run_starts(either):
    api = either
    exp = (await experiment(api, results={"yield": 0.5}))["id"]
    # Recorded by hand, before anything ran: the Experiment has them, and no Run.
    assert await runs_of(api, exp) == []
    assert (await api.get(f"/experiments/{exp}", headers=ALICE)).json()["results"] == {"yield": 0.5}

    run = await start(api, exp)
    # Starting a run doesn't drop them: they are kept as a finished Run 1.
    assert run["number"] == 2
    (one,) = [r for r in await runs_of(api, exp) if r["number"] == 1]
    assert (one["state"], one["results"], one["label"]) == (
        "done",
        {"yield": 0.5},
        "Recorded by hand",
    )
    assert one["params"] == {"power": 300}

    # Only the first time: once it has runs, results are theirs.
    await finish(api, run["id"], {"yield": 0.7})
    three = await start(api, exp)
    assert three["number"] == 3
    assert [r["number"] for r in await runs_of(api, exp)] == [3, 2, 1]

    # Without hand-recorded results, the first run is Run 1.
    bare = (await experiment(api))["id"]
    assert (await start(api, bare))["number"] == 1
