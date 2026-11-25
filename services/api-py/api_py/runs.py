"""Runs: one execution of an Experiment (docs/experiment-runs.md, 029_runs.sql).

A Run works in its Experiment's working files. When it finishes it keeps a
record of every file there (path, version, sha256, size), so what it read and
wrote stays readable while the working files change. A finished Run can't
change (a trigger refuses it); a correction is a new Run. One Run per
Experiment runs at a time.

For one release the Experiment's state, results and provenance mirror its
latest live Run's, so the routes that predate Runs keep answering as before
(`mirror`). Each function runs on the connection it is given, inside the
transaction Session opens for its principal.
"""

from __future__ import annotations

import uuid
from typing import Any

from psycopg import AsyncConnection, errors
from psycopg.types.json import Jsonb

from .access import is_uuid, iso
from .storage import Storage

FINISHED = ("done", "failed")


class RunError(Exception):
    """The request can't be done as asked (400)."""


class RunRunningError(Exception):
    """Another Run of the Experiment is running (409)."""

    def __init__(self, number: int) -> None:
        super().__init__(
            f"Run {number} of this experiment is still running; finish it before starting another"
        )
        self.number = number


class RunStillRunningError(Exception):
    """A running Run can't be deleted (409)."""


class RunNotYoursError(Exception):
    """
    A finish that names no Run, while someone else's Run is running (409):
    it may be a late retry of an earlier finish, so it doesn't end theirs.
    """

    def __init__(self, number: int) -> None:
        super().__init__(
            f"Run {number} of this experiment was started by someone else and is still running; "
            "finish it by its id (POST /runs/{id}/finish) to end it"
        )
        self.number = number


_COLUMNS = """
    r.id, r.experiment_id, r.number, r.label, r.params, r.results, r.state, r.provenance,
    r.started_by, su.name, su.email, r.started_at, r.finished_at, r.record, r.record_taken,
    r.archived_at, r.deleted_at, du.id, du.name, du.email"""
_PEOPLE = "LEFT JOIN users su ON su.id = r.started_by LEFT JOIN users du ON du.id = r.deleted_by"


def _person(id_: Any, name: Any, email: Any) -> dict[str, Any] | None:
    return None if id_ is None else {"id": str(id_), "name": name if name is not None else email}


def _to_run(row: tuple[Any, ...], with_record: bool = False) -> dict[str, Any]:
    (id_, experiment, number, label, params, results, state, provenance, started_by, name, email,
     started_at, finished_at, record, taken, archived_at, deleted_at, del_id, del_name, del_email) = row  # fmt: skip
    run: dict[str, Any] = {
        "id": str(id_),
        "experimentId": str(experiment),
        "number": number,
        "label": label,
        "params": params,
        "results": results,
        "state": state,
        "provenance": provenance,
        "startedBy": _person(started_by, name, email),
        "startedAt": iso(started_at),
        "finishedAt": iso(finished_at) if finished_at else None,
        "fileCount": None if record is None else len(record),
        "recordTaken": taken,
        "archived": archived_at is not None,
        "archivedAt": iso(archived_at) if archived_at else None,
    }
    if deleted_at is not None:
        run["deletedAt"] = iso(deleted_at)
        run["deletedBy"] = _person(del_id, del_name, del_email)
    if with_record:
        run["record"] = record
    return run


async def list_runs(
    conn: AsyncConnection,
    workspace_id: str,
    experiment_id: str,
    *,
    archived: bool = False,
    deleted: bool = False,
) -> list[dict[str, Any]]:
    """An Experiment's Runs, newest first: live ones (with `archived`, archived ones too), or the deleted ones."""
    if not is_uuid(experiment_id):
        return []
    cur = await conn.execute(
        f"""
        SELECT {_COLUMNS} FROM runs r {_PEOPLE}
        WHERE r.experiment_id = %(exp)s AND r.workspace_id = %(ws)s
          AND (r.deleted_at IS NOT NULL) = %(deleted)s
          AND (%(deleted)s OR %(archived)s OR r.archived_at IS NULL)
        ORDER BY {"r.deleted_at DESC," if deleted else ""} r.number DESC""",  # pyrefly: ignore[bad-argument-type]
        {"exp": experiment_id, "ws": workspace_id, "deleted": deleted, "archived": archived},
    )
    return [_to_run(row) for row in await cur.fetchall()]


async def get(
    conn: AsyncConnection, workspace_id: str, run_id: str, *, deleted: bool = False
) -> dict[str, Any] | None:
    """One Run with its file record (a deleted one only with `deleted`); None when there is none."""
    if not is_uuid(run_id):
        return None
    cur = await conn.execute(
        f"""
        SELECT {_COLUMNS} FROM runs r {_PEOPLE}
        WHERE r.id = %s AND r.workspace_id = %s AND (%s OR r.deleted_at IS NULL)""",  # pyrefly: ignore[bad-argument-type]
        (run_id, workspace_id, deleted),
    )
    row = await cur.fetchone()
    return _to_run(row, with_record=True) if row else None


async def latest(
    conn: AsyncConnection, workspace_id: str, experiment_id: str
) -> dict[str, Any] | None:
    """The Experiment's newest live Run, archived or not."""
    if not is_uuid(experiment_id):
        return None
    cur = await conn.execute(
        f"""
        SELECT {_COLUMNS} FROM runs r {_PEOPLE}
        WHERE r.experiment_id = %s AND r.workspace_id = %s AND r.deleted_at IS NULL
        ORDER BY r.number DESC LIMIT 1""",
        (experiment_id, workspace_id),
    )
    row = await cur.fetchone()
    return _to_run(row, with_record=True) if row else None


async def running(conn: AsyncConnection, experiment_id: str) -> tuple[str, int] | None:
    """The id and number of the Experiment's running Run."""
    cur = await conn.execute(
        "SELECT id, number FROM runs WHERE experiment_id = %s AND state = 'running' AND deleted_at IS NULL",
        (experiment_id,),
    )
    row = await cur.fetchone()
    return (str(row[0]), int(row[1])) if row else None


async def start(
    conn: AsyncConnection,
    workspace_id: str,
    experiment_id: str,
    user_id: str,
    *,
    params: dict[str, Any],
    provenance: dict[str, Any],
    label: str = "",
    mirror: bool = True,
) -> str:
    """
    Adds a running Run, numbered after every Run the Experiment ever had, and
    (with `mirror`) mirrors it on the Experiment. Call it with the
    Experiment's row locked. RunRunningError when one is running already.
    """
    found = await running(conn, experiment_id)
    if found:
        raise RunRunningError(found[1])
    cur = await conn.execute(
        "SELECT coalesce(max(number), 0) + 1 FROM runs WHERE experiment_id = %s", (experiment_id,)
    )
    (number,) = await cur.fetchone()  # pyrefly: ignore[not-iterable]
    run_id = str(uuid.uuid4())
    try:
        await conn.execute(
            """
            INSERT INTO runs (id, workspace_id, experiment_id, number, label, params, provenance, started_by)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s)""",
            (
                run_id,
                workspace_id,
                experiment_id,
                number,
                label,
                Jsonb(params),
                Jsonb(provenance),
                user_id,
            ),
        )
    except errors.UniqueViolation as err:
        found = await running(conn, experiment_id)
        raise RunRunningError(found[1] if found else number) from err
    if not mirror:
        return run_id
    await conn.execute(
        """
        UPDATE experiments SET state = 'running', results = '{}', provenance = %s, updated_at = now()
        WHERE id = %s""",
        (Jsonb(provenance), experiment_id),
    )
    return run_id


async def finish_running(
    conn: AsyncConnection,
    experiment_id: str,
    results: dict[str, Any],
    state: str,
    provenance: dict[str, Any],
    run_id: str | None = None,
) -> str | None:
    """
    Ends the Experiment's running Run (only if it is `run_id`, when given)
    with `results` and `state`, adding `provenance` (finishedAt and the
    evidence) to its own, and takes its file record. Called by
    experiments.update with the Experiment's row locked, so no write lands
    between the record and the end. The Run's id, or None when none was
    running.
    """
    cur = await conn.execute(
        """
        UPDATE runs SET results = %s, state = %s, provenance = provenance || %s,
                        finished_at = now(), record = experiment_file_record(experiment_id),
                        record_taken = 'finish'
        WHERE experiment_id = %s AND state = 'running' AND deleted_at IS NULL
          AND (%s::uuid IS NULL OR id = %s::uuid)
        RETURNING id""",
        (Jsonb(results), state, Jsonb(provenance), experiment_id, run_id, run_id),
    )
    row = await cur.fetchone()
    return str(row[0]) if row else None


async def add_finished(
    conn: AsyncConnection,
    workspace_id: str,
    experiment_id: str,
    user_id: str,
    params: dict[str, Any],
    results: dict[str, Any],
    state: str,
    provenance: dict[str, Any],
    label: str = "",
) -> str:
    """
    A Run that starts and ends at once: an Experiment marked done or failed
    through the routes that predate Runs, with none running, or results
    recorded by hand before its first Run. Its record is taken now.
    """
    cur = await conn.execute(
        "SELECT coalesce(max(number), 0) + 1 FROM runs WHERE experiment_id = %s", (experiment_id,)
    )
    (number,) = await cur.fetchone()  # pyrefly: ignore[not-iterable]
    run_id = str(uuid.uuid4())
    await conn.execute(
        """
        INSERT INTO runs (id, workspace_id, experiment_id, number, label, params, results, state,
                          provenance, started_by, finished_at, record, record_taken)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, now(), experiment_file_record(%s), 'finish')""",
        (
            run_id,
            workspace_id,
            experiment_id,
            number,
            label,
            Jsonb(params),
            Jsonb(results),
            state,
            Jsonb(provenance),
            user_id,
            experiment_id,
        ),
    )
    return run_id


BY_HAND = "Recorded by hand"


async def ever_ran(conn: AsyncConnection, experiment_id: str) -> bool:
    """Whether the Experiment has had a Run, deleted ones included."""
    cur = await conn.execute(
        "SELECT EXISTS (SELECT 1 FROM runs WHERE experiment_id = %s)", (experiment_id,)
    )
    row = await cur.fetchone()
    return bool(row and row[0])


async def add_inputs(
    conn: AsyncConnection, experiment_id: str, recorded: list[dict[str, Any]]
) -> None:
    """Appends inputs linked while the Run runs to the running Run's provenance."""
    await conn.execute(
        """
        UPDATE runs
        SET provenance = jsonb_set(provenance, '{inputs}', COALESCE(provenance->'inputs', '[]'::jsonb) || %s)
        WHERE experiment_id = %s AND state = 'running' AND deleted_at IS NULL""",
        (Jsonb(recorded), experiment_id),
    )


async def mirror(conn: AsyncConnection, experiment_id: str) -> None:
    """
    Sets the Experiment's state, results and provenance to its latest live
    Run's, or to an Experiment that hasn't run when it has none. For one
    release: the routes that predate Runs read them there.
    """
    await conn.execute(
        """
        UPDATE experiments e
        SET state = coalesce(l.state, 'ready'), results = coalesce(l.results, '{}'),
            provenance = coalesce(l.provenance, '{}'), updated_at = now()
        FROM (SELECT NULL) one
        LEFT JOIN LATERAL (
          SELECT state, results, provenance FROM runs
          WHERE experiment_id = %(exp)s AND deleted_at IS NULL
          ORDER BY number DESC LIMIT 1
        ) l ON true
        WHERE e.id = %(exp)s""",
        {"exp": experiment_id},
    )


async def set_fields(
    conn: AsyncConnection, workspace_id: str, run_id: str, fields: dict[str, Any]
) -> str | None:
    """Changes a live Run's label or archiving; its Experiment's id, or None when it isn't there."""
    assignments = []
    values: list[Any] = []
    if "label" in fields:
        assignments.append("label = %s")
        values.append(fields["label"])
    if "archived" in fields:
        assignments.append(
            "archived_at = CASE WHEN %s THEN coalesce(archived_at, now()) ELSE NULL END"
        )
        values.append(bool(fields["archived"]))
    if not assignments:
        cur = await conn.execute(
            "SELECT experiment_id FROM runs WHERE id = %s AND workspace_id = %s AND deleted_at IS NULL",
            (run_id, workspace_id),
        )
    else:
        cur = await conn.execute(
            f"""
            UPDATE runs SET {", ".join(assignments)}
            WHERE id = %s AND workspace_id = %s AND deleted_at IS NULL
            RETURNING experiment_id""",  # pyrefly: ignore[bad-argument-type]
            (*values, run_id, workspace_id),
        )
    row = await cur.fetchone()
    return str(row[0]) if row else None


async def remove(conn: AsyncConnection, workspace_id: str, run_id: str, user_id: str) -> str | None:
    """
    Soft-deletes a finished Run; its Experiment's id, or None when it isn't
    there. RunStillRunningError for a running one. The Experiment's mirror
    moves to the Run before it.
    """
    cur = await conn.execute(
        "SELECT experiment_id, state FROM runs WHERE id = %s AND workspace_id = %s AND deleted_at IS NULL FOR UPDATE",
        (run_id, workspace_id),
    )
    row = await cur.fetchone()
    if not row:
        return None
    if row[1] == "running":
        raise RunStillRunningError("This run is still running; finish it before deleting it")
    await conn.execute(
        "UPDATE runs SET deleted_at = now(), deleted_by = %s WHERE id = %s", (user_id, run_id)
    )
    await mirror(conn, str(row[0]))
    return str(row[0])


async def restore(conn: AsyncConnection, workspace_id: str, run_id: str) -> str | None:
    """Undoes a Run's delete; its Experiment's id, or None when there is no deleted Run by that id."""
    cur = await conn.execute(
        """
        UPDATE runs SET deleted_at = NULL, deleted_by = NULL
        WHERE id = %s AND workspace_id = %s AND deleted_at IS NOT NULL
        RETURNING experiment_id""",
        (run_id, workspace_id),
    )
    row = await cur.fetchone()
    if not row:
        return None
    await mirror(conn, str(row[0]))
    return str(row[0])


async def reads(conn: AsyncConnection, workspace_id: str, run_id: str) -> list[dict[str, Any]]:
    """What agents read of the Run's recorded files while it ran, first read first."""
    if not is_uuid(run_id):
        return []
    cur = await conn.execute(
        """
        SELECT r.path, r.version_id, r.sha256, r.via, r.first_read_at, r.user_id, u.name, u.email
        FROM run_reads r LEFT JOIN users u ON u.id = r.user_id
        WHERE r.run_id = %s AND r.workspace_id = %s
        ORDER BY r.first_read_at, r.path, r.version_id""",
        (run_id, workspace_id),
    )
    return [
        {
            "path": row[0],
            "version": str(row[1]),
            "sha256": row[2],
            "via": row[3],
            "readAt": iso(row[4]),
            "by": _person(row[5], row[6], row[7]),
        }
        for row in await cur.fetchall()
    ]


async def compare(
    conn: AsyncConnection,
    workspace_id: str,
    user_id: str,
    *,
    node_ids: list[str | None] | None,
    experiment_id: str | None,
    archived: bool,
) -> list[dict[str, Any]]:
    """
    Runs `user_id` can see, to compare: of one Experiment, or of the
    Experiments on some nodes (None for the root; `node_ids` None: anywhere).
    Each with its Experiment's id, title and node. Newest first.
    """
    if experiment_id is not None and not is_uuid(experiment_id):
        return []
    roots = node_ids is not None and None in node_ids
    nodes = [n for n in node_ids or [] if n is not None and is_uuid(n)]
    cur = await conn.execute(
        f"""
        SELECT {_COLUMNS}, e.title, e.node_id
        FROM runs r JOIN experiments e ON e.id = r.experiment_id {_PEOPLE}
        WHERE r.workspace_id = %(ws)s AND r.deleted_at IS NULL
          AND (%(archived)s OR r.archived_at IS NULL)
          AND (%(exp)s::uuid IS NULL OR r.experiment_id = %(exp)s::uuid)
          AND (%(anywhere)s OR e.node_id = ANY(%(nodes)s::uuid[]) OR (%(roots)s AND e.node_id IS NULL))
          AND experiment_access(%(user)s, e.id) IS NOT NULL
        ORDER BY r.started_at DESC, r.number DESC""",  # pyrefly: ignore[bad-argument-type]
        {
            "ws": workspace_id,
            "archived": archived,
            "exp": experiment_id,
            "anywhere": node_ids is None,
            "nodes": nodes,
            "roots": roots,
            "user": user_id,
        },
    )
    return [
        {
            **_to_run(row[:20]),
            "experiment": {
                "id": str(row[1]),
                "title": row[20],
                "nodeId": str(row[21]) if row[21] else None,
            },
        }
        for row in await cur.fetchall()
    ]


async def notify(
    conn: AsyncConnection, storage: Storage, change: str, run_id: str, experiment_id: str
) -> None:
    """Tells whoever can see the Experiment that one of its Runs changed, and that the Experiment did."""
    cur = await conn.execute("SELECT node_id FROM experiments WHERE id = %s", (experiment_id,))
    row = await cur.fetchone()
    node = str(row[0]) if row and row[0] else None
    await storage.notify(
        conn,
        {"op": "run", "change": change, "id": run_id, "experiment": experiment_id, "node": node},
    )
    await storage.notify(
        conn, {"op": "experiment", "change": "update", "id": experiment_id, "node": node}
    )
