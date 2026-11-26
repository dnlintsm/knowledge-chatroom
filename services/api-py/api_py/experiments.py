"""Experiments: a user's sandbox on one knowledge node, or at the workspace root.

Forking copies the node's file list into the experiment (005_experiments.sql,
015_runs.sql); the bytes are shared, since blobs are stored once by content.
After that the experiment's files change on their own, and the node's stay as
they were. Each execution of an experiment is a Run (runs.py); the
experiment's state, results and provenance are its latest Run's. Each function
runs on the connection it is given, inside the transaction Session opens for
its principal.
"""

from __future__ import annotations

import re
import uuid
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from typing import Any

from psycopg import AsyncConnection, errors
from psycopg.types.json import Jsonb

from . import runs
from .access import is_uuid, iso
from .nodes import NodeNotFoundError
from .paths import JS_SPACE, js_trim, kind_for_path, utf16_len
from .run_report import RULES_PATH, js_json
from .storage import Storage

STATUSES = ("draft", "shared", "archived")
# How far a run got; apart from status, which says who sees it.
STATES = ("ready", "running", "done", "failed")
MAX_JSON_CHARS = 64 * 1024
_SPACES = re.compile(f"[{JS_SPACE}]+")

InTx = Callable[[AsyncConnection], Awaitable[Any]]


class ExperimentError(Exception):
    """The request can't be done as asked: no title, params not an object, ... (400)."""


class ExperimentPlaceGoneError(Exception):
    """A deleted experiment whose node was deleted too: it can't be restored on its own (409)."""


class ExperimentExistsError(Exception):
    """A new experiment was given an id that is already taken, even by a deleted one (409)."""

    def __init__(self, experiment_id: str) -> None:
        super().__init__(f"An experiment with id {experiment_id} already exists")
        self.id = experiment_id


def clean_input(given: dict[str, Any]) -> dict[str, Any]:
    """Checks and tidies the fields a create or update sets (only the keys given)."""
    out: dict[str, Any] = {}
    if "title" in given:
        title = _SPACES.sub(" ", js_trim(str(given["title"])))
        if not title:
            raise ExperimentError("An experiment needs a title")
        if utf16_len(title) > 200:
            raise ExperimentError("Titles are at most 200 characters")
        out["title"] = title
    if "hypothesis" in given:
        hypothesis = str(given["hypothesis"])
        if utf16_len(hypothesis) > 20_000:
            raise ExperimentError("The hypothesis is at most 20000 characters")
        out["hypothesis"] = hypothesis
    for key in ("params", "results"):
        if key not in given:
            continue
        value = given[key]
        if not isinstance(value, dict):
            raise ExperimentError(f'{key} must be an object, e.g. {{"temperature": 60}}')
        if utf16_len(js_json(value)) > MAX_JSON_CHARS:
            raise ExperimentError(
                f"{key} is too large (at most {MAX_JSON_CHARS} characters of JSON)"
            )
        out[key] = value
    if "status" in given:
        if given["status"] not in STATUSES:
            raise ExperimentError("Status must be draft, shared or archived")
        out["status"] = given["status"]
    if "state" in given:
        if given["state"] not in STATES:
            raise ExperimentError("State must be ready, running, done or failed")
        out["state"] = given["state"]
    return out


def same_json(a: Any, b: Any) -> bool:
    """Whether two JSON values are equal as isDeepStrictEqual sees them: true isn't 1, and key order doesn't matter."""
    if isinstance(a, bool) or isinstance(b, bool):
        return a is b
    if isinstance(a, int | float) and isinstance(b, int | float):
        return a == b
    if isinstance(a, dict) and isinstance(b, dict):
        return a.keys() == b.keys() and all(same_json(a[k], b[k]) for k in a)
    if isinstance(a, list) and isinstance(b, list):
        return len(a) == len(b) and all(same_json(x, y) for x, y in zip(a, b, strict=True))
    return type(a) is type(b) and a == b


_COLUMNS = """
    e.id, e.node_id, e.author_id, u.name AS author_name, e.title, e.hypothesis,
    e.params, e.results, e.status, e.state, e.forked_at, e.updated_at, e.provenance,
    (SELECT count(*) FROM files f WHERE f.experiment_id = e.id AND f.deleted_at IS NULL) AS file_count,
    experiment_access(%(user)s, e.id) AS access, e.maintainer_id = %(user)s AS mine,
    e.maintainer_id, mu.name AS maintainer_name,
    workspace_member(e.workspace_id, e.maintainer_id) AS maintainer_is_member,
    (SELECT coalesce(jsonb_agg(jsonb_build_object('id', c.user_id, 'name', cu.name)
                               ORDER BY lower(coalesce(cu.name, cu.email, '')), c.created_at), '[]')
     FROM experiment_collaborators c JOIN users cu ON cu.id = c.user_id
     WHERE c.experiment_id = e.id) AS collaborators"""
# The joins _COLUMNS needs: the author's and the maintainer's names.
_PEOPLE = "LEFT JOIN users u ON u.id = e.author_id LEFT JOIN users mu ON mu.id = e.maintainer_id"


def _to_experiment(row: tuple[Any, ...]) -> dict[str, Any]:
    (id_, node, author, author_name, title, hypothesis, params, results, status, state, forked, updated, provenance,
     files, access, mine, maintainer, maintainer_name, maintainer_is_member, collaborators) = row  # fmt: skip
    return {
        "id": str(id_),
        "nodeId": str(node) if node else None,
        "authorId": str(author),
        "authorName": author_name,
        "title": title,
        "hypothesis": hypothesis,
        "params": params,
        "results": results,
        "status": status,
        "state": state,
        "forkedAt": iso(forked),
        "updatedAt": iso(updated),
        "fileCount": int(files),
        "provenance": provenance,
        "access": access,
        "mine": mine,
        "maintainerId": str(maintainer),
        "maintainerName": maintainer_name,
        "maintainerIsMember": maintainer_is_member,
        "collaborators": [{"id": str(c["id"]), "name": c["name"]} for c in collaborators],
    }


async def lock_live_experiment(
    conn: AsyncConnection, workspace_id: str, experiment_id: str, *, update: bool = False
) -> None:
    """
    Inside a file write: fails unless the experiment is live, and holds it so a
    concurrent delete waits. With `update`, holds it against writes and
    finishes too, as starting a Run does.
    """
    lock = "FOR UPDATE" if update else "FOR SHARE"
    cur = await conn.execute(
        f"SELECT 1 FROM experiments WHERE id = %s AND workspace_id = %s AND deleted_at IS NULL {lock}",  # pyrefly: ignore[bad-argument-type]
        (experiment_id, workspace_id),
    )
    if not await cur.fetchone():
        raise NodeNotFoundError("Experiment not found")


# For list_experiments: on any node or at the root.
ANYWHERE = object()


async def list_experiments(
    conn: AsyncConnection, workspace_id: str, user_id: str, node_id: str | None | object = ANYWHERE
) -> list[dict[str, Any]]:
    """Experiments `user_id` can see on one node (None: at the workspace root) or anywhere; newest first."""
    if isinstance(node_id, str) and node_id and not is_uuid(node_id):
        return []
    on_node = "" if node_id is ANYWHERE else "AND e.node_id IS NOT DISTINCT FROM %(node)s::uuid"
    cur = await conn.execute(
        f"""
        SELECT * FROM (
          SELECT {_COLUMNS}
          FROM experiments e LEFT JOIN nodes n ON n.id = e.node_id
          {_PEOPLE}
          WHERE e.workspace_id = %(ws)s AND e.deleted_at IS NULL
            AND (e.node_id IS NULL OR n.deleted_at IS NULL)
            {on_node}
        ) x
        WHERE access IS NOT NULL
        ORDER BY forked_at DESC, id""",  # pyrefly: ignore[bad-argument-type]
        {"user": user_id, "ws": workspace_id, "node": None if node_id is ANYWHERE else node_id},
    )
    return [_to_experiment(row) for row in await cur.fetchall()]


async def get(
    conn: AsyncConnection, workspace_id: str, user_id: str, experiment_id: str
) -> dict[str, Any] | None:
    if not is_uuid(experiment_id):
        return None
    cur = await conn.execute(
        f"""
        SELECT {_COLUMNS}
        FROM experiments e {_PEOPLE}
        WHERE e.id = %(id)s AND e.workspace_id = %(ws)s AND e.deleted_at IS NULL""",
        {"user": user_id, "ws": workspace_id, "id": experiment_id},
    )
    row = await cur.fetchone()
    return _to_experiment(row) if row and row[14] else None


async def create(
    conn: AsyncConnection,
    storage: Storage,
    user_id: str,
    node_id: str | None,
    given: dict[str, Any],
    in_tx: Callable[[AsyncConnection, str], Awaitable[Any]] | None = None,
    *,
    inputs: list[dict[str, str]] | None = None,
    provenance: dict[str, Any] | None = None,
    chosen_id: str | None = None,
    fork: bool = True,
    record_run: bool = True,
) -> dict[str, Any]:
    """
    A new draft for `user_id` on `node_id`, or at the workspace root (None).
    On a node it is a fork: the node's live files are copied in at their
    current versions, unless `fork` is false. At the root it starts empty.
    `inputs` ({path, versionId}) are linked in as copies of those versions.
    One made running gets Run 1, running; one made done or failed gets Run 1
    finished, with its record taken now, unless `record_run` is false (the
    caller adds files first and records it then).
    """
    fields = clean_input(given)
    if not fields.get("title"):
        raise ExperimentError("An experiment needs a title")
    if node_id is not None and not is_uuid(node_id):
        raise NodeNotFoundError("Node not found")
    if chosen_id is not None and not is_uuid(chosen_id):
        raise ExperimentError(
            "An experiment id must be a UUID, e.g. 0b8f6c2e-3d1a-4f5b-9c7e-2a4d6e8f0a1b"
        )
    ws = storage.workspace_id
    # Chosen here, not by the database: with row-level security the new row
    # can't be read back in the statement that adds it.
    new_id = chosen_id.lower() if chosen_id is not None else str(uuid.uuid4())
    try:
        async with conn.transaction():
            # The insert also checks and holds the node (experiments_place in
            # 005_experiments.sql), so a delete of it can't slip in between.
            await conn.execute(
                """
                INSERT INTO experiments (id, workspace_id, node_id, author_id, title, hypothesis, params, results,
                                         state, provenance)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)""",
                (
                    new_id,
                    ws,
                    node_id,
                    user_id,
                    fields["title"],
                    fields.get("hypothesis", ""),
                    Jsonb(fields.get("params", {})),
                    Jsonb(fields.get("results", {})),
                    fields.get("state", "ready"),
                    Jsonb(provenance or {}),
                ),
            )
            if node_id is not None and fork:
                await _copy_node_files(conn, ws, node_id, new_id)
            if inputs:
                await _link_inputs(conn, ws, new_id, inputs)
            state = fields.get("state", "ready")
            if state == "running":
                await runs.start(
                    conn,
                    ws,
                    new_id,
                    user_id,
                    params=fields.get("params", {}),
                    provenance=provenance or {},
                    mirror=False,
                )
            elif state in runs.FINISHED and record_run:
                await runs.add_finished(
                    conn,
                    ws,
                    new_id,
                    user_id,
                    fields.get("params", {}),
                    fields.get("results", {}),
                    state,
                    provenance or {},
                )
            if in_tx:
                await in_tx(conn, new_id)
            await storage.notify(
                conn, {"op": "experiment", "change": "create", "id": new_id, "node": node_id}
            )
    except errors.RaiseException as err:
        if err.diag.message_primary == "Node not found":
            raise NodeNotFoundError("Node not found") from err
        raise
    except errors.UniqueViolation as err:
        if err.diag.constraint_name == "experiments_pkey":
            raise ExperimentExistsError(new_id) from err
        raise
    created = await get(conn, ws, user_id, new_id)
    if not created:
        raise NodeNotFoundError("Node not found")  # deleted right after this commit
    return created


async def id_taken(conn: AsyncConnection, experiment_id: str) -> bool:
    """Whether any experiment, in any workspace and even a deleted one, has this id (run as the server)."""
    if not is_uuid(experiment_id):
        return False
    cur = await conn.execute("SELECT 1 FROM experiments WHERE id = %s", (experiment_id,))
    return await cur.fetchone() is not None


async def _copy_node_files(
    conn: AsyncConnection, workspace_id: str, node_id: str, experiment_id: str
) -> None:
    """The node's live files into the experiment, each at its current version; bytes are shared."""
    await conn.execute(
        """
        INSERT INTO files (workspace_id, experiment_id, path, kind, mime, forked_from, updated_at)
        SELECT f.workspace_id, %s, f.path, f.kind, f.mime, f.current_version_id, f.updated_at
        FROM files f
        WHERE f.workspace_id = %s AND f.node_id = %s
          AND f.deleted_at IS NULL AND f.current_version_id IS NOT NULL""",
        (experiment_id, workspace_id, node_id),
    )
    await conn.execute(
        """
        INSERT INTO file_versions (file_id, blob_sha256, size, mime, author_type, author_id, created_at)
        SELECT f.id, v.blob_sha256, v.size, v.mime, v.author_type, v.author_id, v.created_at
        FROM files f JOIN file_versions v ON v.id = f.forked_from
        WHERE f.experiment_id = %s""",
        (experiment_id,),
    )
    await conn.execute(
        """
        UPDATE files f SET current_version_id = v.id
        FROM file_versions v
        WHERE v.file_id = f.id AND f.experiment_id = %s""",
        (experiment_id,),
    )


async def _link_inputs(
    conn: AsyncConnection, workspace_id: str, experiment_id: str, inputs: list[dict[str, str]]
) -> list[dict[str, str]]:
    """
    Copies of other files' versions in the experiment, as a run's inputs. Their
    bytes are shared, and since each starts from the version it copies,
    promoting the run never proposes them back to its node.
    """
    linked = []
    for item in inputs:
        path = item["path"]
        cur = await conn.execute(
            """
            INSERT INTO files (workspace_id, experiment_id, path, kind, mime, forked_from)
            SELECT %s, %s, %s, %s, v.mime, v.id
            FROM file_versions v WHERE v.id = %s
            ON CONFLICT (workspace_id, node_id, experiment_id, path) WHERE deleted_at IS NULL DO NOTHING
            RETURNING id""",
            (workspace_id, experiment_id, path, kind_for_path(path), item["versionId"]),
        )
        file = await cur.fetchone()
        if not file:
            raise ExperimentError(
                f"The run already has a file at {path}; pick another name for this input"
            )
        cur = await conn.execute(
            """
            INSERT INTO file_versions (file_id, blob_sha256, size, mime, author_type, author_id, created_at)
            SELECT %s, v.blob_sha256, v.size, v.mime, v.author_type, v.author_id, v.created_at
            FROM file_versions v WHERE v.id = %s
            RETURNING blob_sha256""",
            (file[0], item["versionId"]),
        )
        (sha256,) = await cur.fetchone()  # pyrefly: ignore[not-iterable]
        await conn.execute(
            "UPDATE files f SET current_version_id = v.id FROM file_versions v WHERE v.file_id = f.id AND f.id = %s",
            (file[0],),
        )
        linked.append({"path": path, "sha256": sha256})
    return linked


link_inputs = _link_inputs


async def add_inputs(
    conn: AsyncConnection,
    storage: Storage,
    experiment_id: str,
    inputs: list[dict[str, str]],
    recorded: list[dict[str, Any]],
    in_tx: InTx | None = None,
) -> bool:
    """Links more inputs into the experiment and appends `recorded` to its provenance's inputs; False if it is gone."""
    if not is_uuid(experiment_id):
        return False
    async with conn.transaction():
        cur = await conn.execute(
            """
            SELECT node_id, state, status FROM experiments
            WHERE id = %s AND workspace_id = %s AND deleted_at IS NULL
            FOR UPDATE""",
            (experiment_id, storage.workspace_id),
        )
        before = await cur.fetchone()
        if not before:
            return False
        node, state, status = before
        # Checked again under the lock: the run may have finished or been archived meanwhile.
        if state in ("done", "failed"):
            raise ExperimentError(
                f"This run already finished ({state}); start a new run to add inputs"
            )
        if status == "archived":
            raise ExperimentError("This experiment is archived; restore it to change it")
        linked = await _link_inputs(conn, storage.workspace_id, experiment_id, inputs)
        await runs.add_inputs(conn, experiment_id, recorded)
        await conn.execute(
            """
            UPDATE experiments
            SET provenance = jsonb_set(provenance, '{inputs}', COALESCE(provenance->'inputs', '[]'::jsonb) || %s),
                updated_at = now()
            WHERE id = %s""",
            (Jsonb(recorded), experiment_id),
        )
        if in_tx:
            await in_tx(conn)
        # Open copies of the run pick up the new files, and its record.
        for file in linked:
            await storage.notify(
                conn,
                {
                    "op": "write",
                    "node": None,
                    "experiment": experiment_id,
                    **file,
                    "author": "user",
                },
            )
        node_id = str(node) if node else None
        await storage.notify(
            conn, {"op": "experiment", "change": "update", "id": experiment_id, "node": node_id}
        )
        return True


async def finish_target(
    conn: AsyncConnection,
    experiment_id: str,
    results: dict[str, Any],
    state: str,
    *,
    run: str | None,
    by: str,
) -> tuple[str, str | None]:
    """
    Which Run a finish ends, read with the Experiment's row locked. A named
    `run` is that Run. Without one (clients from before Runs), a finish that
    repeats how the latest finished Run of `by` ended is a retry of it, even
    when a newer Run is running; otherwise it ends the running Run only when
    `by` started it, so a late retry never ends someone else's.

    ("finish", id) ends that running Run; ("same", id) it already ended so,
    and nothing changes; ("add", None) none runs and none was named.
    """
    cur = await conn.execute(
        """
        SELECT id, number, state, results, started_by FROM runs
        WHERE experiment_id = %s AND deleted_at IS NULL ORDER BY number DESC""",
        (experiment_id,),
    )
    rows = [(str(r[0]), int(r[1]), r[2], r[3], str(r[4])) for r in await cur.fetchall()]
    if run is not None:
        named = next((r for r in rows if r[0] == run), None)
        if named is None:
            raise ExperimentError("That run isn't one of this experiment's")
        if named[2] == "running":
            return "finish", run
        if named[2] == state and same_json(named[3], results):
            return "same", run
        raise ExperimentError(
            f"Run {named[1]} already finished ({named[2]}); start a new run to try again"
        )
    running = next((r for r in rows if r[2] == "running"), None)
    if running is None:
        return "add", None
    # The caller's own latest finished Run: a collaborator's Run finished
    # since must not hide the retry.
    ended = next((r for r in rows if r[2] in runs.FINISHED and r[4] == by), None)
    if ended and ended[2] == state and same_json(ended[3], results):
        return "same", ended[0]
    if running[4] != by:
        raise runs.RunNotYoursError(running[1])
    return "finish", running[0]


def finisher(execution: dict[str, Any]) -> dict[str, Any]:
    """An execution's `finishedBy`: who finished the Run, what as, and what authorized it."""
    return {
        "user": execution["initiatedBy"],
        "ranAs": execution["ranAs"],
        "authorizedBy": execution["authorizedBy"],
    }


async def update(
    conn: AsyncConnection,
    storage: Storage,
    experiment_id: str,
    given: dict[str, Any],
    in_tx: InTx | None = None,
    provenance: dict[str, Any] | None = None,
    *,
    by: str | None = None,
    run: str | None = None,
    execution: dict[str, Any] | None = None,
) -> bool:
    """
    Sets the given fields, as user `by`; False if the experiment is gone.
    `execution` is who asks, what as, and what authorized it
    (Session.execution): a Run started here records it, and one that ends here
    records it as its `finishedBy`.
    `provenance` keys are merged into the recorded ones. A run that ends here
    (its state becomes done or failed), through a finish or a PATCH, also gets
    what it ended with (`evidence_at_finish`), read under the row's lock, and
    so does the Run it ends (`finish_target`: `run` when named), with its file
    record; with none running, a finished Run is added. Becoming running
    starts a Run.
    """
    fields = clean_input(given)
    if not is_uuid(experiment_id):
        return False
    async with conn.transaction():
        cur = await conn.execute(
            """
            SELECT status, node_id, state, results, params FROM experiments
            WHERE id = %s AND workspace_id = %s AND deleted_at IS NULL
            FOR UPDATE""",
            (experiment_id, storage.workspace_id),
        )
        before = await cur.fetchone()
        if not before:
            return False
        status, node, state, results, params = before
        target: str | None = None
        if fields.get("state") in runs.FINISHED and by is not None:
            outcome, target = await finish_target(
                conn,
                experiment_id,
                fields.get("results", results),
                fields["state"],
                run=run,
                by=by,
            )
            if outcome == "same":
                return True
        # A finished run stays as it ended, whoever asks and through whichever
        # route: checked here, under the row's lock, so neither a PATCH nor a
        # second finish racing the first can rewrite it.
        if state in ("done", "failed") and (
            fields.get("state", state) != state
            or ("results" in fields and not same_json(fields["results"], results))
        ):
            raise ExperimentError(
                f"This run already finished ({state}); its state and results stay as they ended"
            )
        # A running Run ends by finishing: marking the Experiment ready would
        # leave it running unseen, with its reads no longer recorded.
        if fields.get("state") == "ready" and state == "running":
            found = await runs.running(conn, experiment_id)
            if found:
                raise runs.RunRunningError(found[1], "marking the experiment ready")
        ends = fields.get("state") in runs.FINISHED and state not in runs.FINISHED
        if ends:
            provenance = {
                **(provenance or {}),
                "finishedAt": iso(datetime.now(UTC)),
                **(await evidence_at_finish(conn, storage.workspace_id, experiment_id)),
            }
        values = {k: Jsonb(v) if k in ("params", "results") else v for k, v in fields.items()}
        if values:
            assignments = ", ".join(f"{column} = %s" for column in values)
            await conn.execute(
                f"UPDATE experiments SET {assignments}, updated_at = now() WHERE id = %s",  # pyrefly: ignore[bad-argument-type]
                (*values.values(), experiment_id),
            )
        if provenance:
            await conn.execute(
                "UPDATE experiments SET provenance = provenance || %s, updated_at = now() WHERE id = %s",
                (Jsonb(provenance), experiment_id),
            )
        ended: str | None = None
        started: str | None = None
        if ends:
            final = fields.get("results", results)
            ended = await runs.finish_running(
                conn,
                experiment_id,
                final,
                fields["state"],
                provenance or {},
                target,
                finished_by=None if execution is None else finisher(execution),
            )
            if ended is None:
                everything = await conn.execute(
                    "SELECT provenance, author_id FROM experiments WHERE id = %s", (experiment_id,)
                )
                recorded, author = await everything.fetchone()  # pyrefly: ignore[not-iterable]
                ended = await runs.add_finished(
                    conn,
                    storage.workspace_id,
                    experiment_id,
                    by or str(author),
                    fields.get("params", params),
                    final,
                    fields["state"],
                    recorded
                    if execution is None
                    else {
                        **recorded,
                        "execution": {**execution, "finishedBy": finisher(execution)},
                    },
                )
        elif fields.get("state") == "running" and state != "running":
            everything = await conn.execute(
                "SELECT provenance, author_id FROM experiments WHERE id = %s", (experiment_id,)
            )
            recorded, author = await everything.fetchone()  # pyrefly: ignore[not-iterable]
            started = await runs.start(
                conn,
                storage.workspace_id,
                experiment_id,
                by or str(author),
                params=fields.get("params", params),
                provenance=recorded if execution is None else {**recorded, "execution": execution},
                mirror=False,
            )
        if in_tx:
            await in_tx(conn)
        if ended or started:
            await storage.notify(
                conn,
                {
                    "op": "run",
                    "change": "finish" if ended else "create",
                    "id": ended or started,
                    "experiment": experiment_id,
                    "node": str(node) if node else None,
                },
            )
        change = "status" if "status" in fields and fields["status"] != status else "update"
        node_id = str(node) if node else None
        await storage.notify(
            conn, {"op": "experiment", "change": change, "id": experiment_id, "node": node_id}
        )
        return True


async def remove(
    conn: AsyncConnection,
    storage: Storage,
    experiment_id: str,
    in_tx: InTx | None = None,
    user_id: str | None = None,
) -> bool:
    """Soft-deletes the experiment and its files, by `user_id`; history stays, and `restore` undoes it."""
    if not is_uuid(experiment_id):
        return False
    async with conn.transaction():
        cur = await conn.execute(
            """
            UPDATE experiments SET deleted_at = now(), deleted_by = %s
            WHERE id = %s AND workspace_id = %s AND deleted_at IS NULL
            RETURNING node_id""",
            (user_id, experiment_id, storage.workspace_id),
        )
        gone = await cur.fetchone()
        if not gone:
            return False
        # Its files go with it (a trigger, see 005_experiments.sql).
        if in_tx:
            await in_tx(conn)
        node_id = str(gone[0]) if gone[0] else None
        await storage.notify(
            conn, {"op": "experiment", "change": "delete", "id": experiment_id, "node": node_id}
        )
        return True


async def list_deleted(
    conn: AsyncConnection, workspace_id: str, user_id: str
) -> list[dict[str, Any]]:
    """
    The deleted experiments `user_id` may restore (027_experiment_restore.sql),
    newest deletion first, each as an experiment's answer with `deletedAt` and
    `deletedBy`. `fileCount` is what a restore brings back, and `access` what
    they would have once it is restored.
    """
    cur = await conn.execute(
        """
        SELECT d.id, d.node_id, d.author_id, u.name, d.title, d.hypothesis, d.params, d.results,
               d.status, d.state, d.forked_at, d.updated_at, d.provenance, d.file_count,
               CASE WHEN (d.maintainer_id = %(user)s OR d.collaborators @> jsonb_build_array(
                            jsonb_build_object('id', %(user)s::uuid)))
                         AND d.status <> 'archived' THEN 'writer' ELSE 'reader' END,
               d.maintainer_id = %(user)s, d.maintainer_id, mu.name, d.maintainer_is_member,
               d.collaborators, d.deleted_at, d.deleted_by, du.name, du.email, d.node_live
        FROM deleted_experiments(%(ws)s, %(user)s) d
        LEFT JOIN users u ON u.id = d.author_id
        LEFT JOIN users mu ON mu.id = d.maintainer_id
        LEFT JOIN users du ON du.id = d.deleted_by
        ORDER BY d.deleted_at DESC, d.id""",
        {"ws": workspace_id, "user": user_id},
    )
    found = []
    for row in await cur.fetchall():
        deleted_at, deleted_by, name, email, node_live = row[20:]
        found.append(
            {
                **_to_experiment(row[:20]),
                "deletedAt": iso(deleted_at),
                "deletedBy": None
                if deleted_by is None
                else {"id": str(deleted_by), "name": name if name is not None else email},
                "restorable": bool(node_live),
            }
        )
    return found


async def restore(
    conn: AsyncConnection,
    storage: Storage,
    user_id: str,
    experiment_id: str,
    in_tx: Callable[[AsyncConnection, str | None], Awaitable[Any]] | None = None,
) -> bool:
    """
    Brings a deleted experiment back with the files deleted with it, for
    someone who may (027_experiment_restore.sql); False when it isn't there
    for them. A departed maintainer's goes to the Owner or Admin restoring it,
    and `in_tx` gets that departed maintainer when it did (else None).
    """
    if not is_uuid(experiment_id):
        return False
    async with conn.transaction():
        cur = await conn.execute(
            "SELECT outcome, handed_from, node_id FROM restore_experiment(%s, %s, %s)",
            (storage.workspace_id, user_id, experiment_id),
        )
        row = await cur.fetchone()
        if not row:
            return False
        outcome, handed_from, node = row
        if outcome == "node_deleted":
            raise ExperimentPlaceGoneError("Its place was deleted, so it can't be restored")
        if in_tx:
            await in_tx(conn, str(handed_from) if handed_from else None)
        await storage.notify(
            conn,
            {
                "op": "experiment",
                "change": "restore",
                "id": experiment_id,
                "node": str(node) if node else None,
            },
        )
        return True


# The files of a run whose reads by an agent are recorded while it runs
# (026_run_reads.sql): its generated Rules.
RECORDED_READS = (RULES_PATH,)


async def evidence_at_finish(
    conn: AsyncConnection, workspace_id: str, experiment_id: str
) -> dict[str, Any]:
    """
    What a finished run's provenance keeps of its recorded files: the newest
    version of each as it ends (null when there is none), and the reads
    recorded while it ran, so the record and the report keep saying what was
    read. Called with the experiment's row locked (update): file writes and
    record_read hold that row too, so none lands between this and the end.
    """
    cur = await conn.execute(
        """
        SELECT f.path, v.id, v.blob_sha256
        FROM files f
        JOIN LATERAL (
          SELECT id, blob_sha256 FROM file_versions WHERE file_id = f.id
          ORDER BY created_at DESC, id DESC
          LIMIT 1
        ) v ON true
        WHERE f.experiment_id = %s AND f.workspace_id = %s
          AND f.path = ANY(%s) AND f.deleted_at IS NULL""",
        (experiment_id, workspace_id, list(RECORDED_READS)),
    )
    newest = {row[0]: {"version": str(row[1]), "sha256": row[2]} for row in await cur.fetchall()}
    # The reads of the Run that is ending; none when it starts and ends at once.
    now = await runs.running(conn, experiment_id)
    read = await runs.reads(conn, workspace_id, now[0]) if now else []
    return {
        "files": {path: newest.get(path) for path in RECORDED_READS},
        "reads": [
            {key: entry[key] for key in ("path", "version", "sha256", "via", "readAt")}
            for entry in read
        ],
    }


async def record_read(
    conn: AsyncConnection,
    workspace_id: str,
    experiment_id: str,
    path: str,
    sha256: str,
    user_id: str,
    via: str,
    version_id: str | None = None,
) -> str | None:
    """
    Records that an agent read this version of one of a running run's files:
    `version_id` when the read named one, else the file's newest version with
    the bytes it read. A run that isn't running, or a read already recorded,
    adds nothing. It holds the experiment's row, so a finish in progress
    (update) either sees this read or turns it away once the run has ended.
    The run's node when a read was added (None at the root), so the caller can
    tell whoever watches the run; else nothing.
    """
    if version_id is not None and not is_uuid(version_id):
        return None
    cur = await conn.execute(
        """
        INSERT INTO run_reads (workspace_id, experiment_id, run_id, path, version_id, sha256, user_id, via)
        SELECT e.workspace_id, e.id, r.id, f.path, v.id, v.blob_sha256, %(user)s, %(via)s
        FROM experiments e
        JOIN runs r ON r.experiment_id = e.id AND r.state = 'running' AND r.deleted_at IS NULL
        JOIN files f ON f.experiment_id = e.id AND f.path = %(path)s AND f.deleted_at IS NULL
        JOIN LATERAL (
          SELECT id, blob_sha256 FROM file_versions
          WHERE file_id = f.id AND blob_sha256 = %(sha256)s
            AND (%(version)s::uuid IS NULL OR id = %(version)s::uuid)
          ORDER BY created_at DESC, id DESC
          LIMIT 1
        ) v ON true
        WHERE e.id = %(experiment)s AND e.workspace_id = %(ws)s
          AND e.state = 'running' AND e.deleted_at IS NULL
        FOR SHARE OF e
        ON CONFLICT DO NOTHING
        RETURNING (SELECT coalesce(node_id::text, '') FROM experiments WHERE id = experiment_id)""",
        {
            "user": user_id,
            "via": via,
            "path": path,
            "sha256": sha256,
            "version": version_id,
            "experiment": experiment_id,
            "ws": workspace_id,
        },
    )
    added = await cur.fetchone()
    return None if added is None else added[0]


async def reads(
    conn: AsyncConnection, workspace_id: str, experiment_id: str
) -> list[dict[str, Any]]:
    """What agents read of the recorded files of the experiment's latest Run while it ran, first read first."""
    newest = await runs.latest(conn, workspace_id, experiment_id)
    return [] if newest is None else await runs.reads(conn, workspace_id, newest["id"])
