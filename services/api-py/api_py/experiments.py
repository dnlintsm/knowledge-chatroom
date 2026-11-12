"""Experiments: a user's sandbox on one knowledge node, or at the workspace root, as apps/agent/src/storage/experiments.ts.

Forking copies the node's file list into the experiment (005_experiments.sql,
015_runs.sql); the bytes are shared, since blobs are stored once by content.
After that the experiment's files change on their own, and the node's stay as
they were. An experiment with a report.md is a run. Each function runs on the
connection it is given, inside the transaction Session opens for its principal.
"""

from __future__ import annotations

import re
import uuid
from collections.abc import Awaitable, Callable
from typing import Any

from psycopg import AsyncConnection, errors
from psycopg.types.json import Jsonb

from .access import is_uuid, iso
from .nodes import NodeNotFoundError
from .paths import JS_SPACE, js_trim, kind_for_path, utf16_len
from .run_report import js_json
from .storage import Storage

STATUSES = ("draft", "shared", "archived")
# How far a run got; apart from status, which says who sees it.
STATES = ("ready", "running", "done", "failed")
MAX_JSON_CHARS = 64 * 1024
_SPACES = re.compile(f"[{JS_SPACE}]+")

InTx = Callable[[AsyncConnection], Awaitable[Any]]


class ExperimentError(Exception):
    """The request can't be done as asked: no title, params not an object, ... (400)."""


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
    experiment_access(%(user)s, e.id) AS access, e.author_id = %(user)s AS mine"""


def _to_experiment(row: tuple[Any, ...]) -> dict[str, Any]:
    (id_, node, author, author_name, title, hypothesis, params, results, status, state, forked, updated, provenance,
     files, access, mine) = row  # fmt: skip
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
    }


async def lock_live_experiment(
    conn: AsyncConnection, workspace_id: str, experiment_id: str
) -> None:
    """Inside a file write: fails unless the experiment is live, and holds it so a concurrent delete waits."""
    cur = await conn.execute(
        "SELECT 1 FROM experiments WHERE id = %s AND workspace_id = %s AND deleted_at IS NULL FOR SHARE",
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
          LEFT JOIN users u ON u.id = e.author_id
          WHERE e.workspace_id = %(ws)s AND e.deleted_at IS NULL
            AND (e.node_id IS NULL OR n.deleted_at IS NULL)
            {on_node}
        ) x
        WHERE access IS NOT NULL
        ORDER BY forked_at DESC, id""",  # type: ignore[arg-type]
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
        FROM experiments e LEFT JOIN users u ON u.id = e.author_id
        WHERE e.id = %(id)s AND e.workspace_id = %(ws)s AND e.deleted_at IS NULL""",  # type: ignore[arg-type]
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
) -> dict[str, Any]:
    """
    A new draft for `user_id` on `node_id`, or at the workspace root (None).
    On a node it is a fork: the node's live files are copied in at their
    current versions, unless `fork` is false. At the root it starts empty.
    `inputs` ({path, versionId}) are linked in as copies of those versions.
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
        (sha256,) = await cur.fetchone()  # type: ignore[misc]
        await conn.execute(
            "UPDATE files f SET current_version_id = v.id FROM file_versions v WHERE v.file_id = f.id AND f.id = %s",
            (file[0],),
        )
        linked.append({"path": path, "sha256": sha256})
    return linked


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


async def update(
    conn: AsyncConnection,
    storage: Storage,
    experiment_id: str,
    given: dict[str, Any],
    in_tx: InTx | None = None,
    provenance: dict[str, Any] | None = None,
) -> bool:
    """Sets the given fields; False if the experiment is gone. `provenance` keys are merged into the recorded ones."""
    fields = clean_input(given)
    if not is_uuid(experiment_id):
        return False
    async with conn.transaction():
        cur = await conn.execute(
            """
            SELECT status, node_id FROM experiments
            WHERE id = %s AND workspace_id = %s AND deleted_at IS NULL
            FOR UPDATE""",
            (experiment_id, storage.workspace_id),
        )
        before = await cur.fetchone()
        if not before:
            return False
        status, node = before
        values = {k: Jsonb(v) if k in ("params", "results") else v for k, v in fields.items()}
        if values:
            assignments = ", ".join(f"{column} = %s" for column in values)
            await conn.execute(
                f"UPDATE experiments SET {assignments}, updated_at = now() WHERE id = %s",  # type: ignore[arg-type]
                (*values.values(), experiment_id),
            )
        if provenance:
            await conn.execute(
                "UPDATE experiments SET provenance = provenance || %s, updated_at = now() WHERE id = %s",
                (Jsonb(provenance), experiment_id),
            )
        if in_tx:
            await in_tx(conn)
        change = "status" if "status" in fields and fields["status"] != status else "update"
        node_id = str(node) if node else None
        await storage.notify(
            conn, {"op": "experiment", "change": change, "id": experiment_id, "node": node_id}
        )
        return True


async def remove(
    conn: AsyncConnection, storage: Storage, experiment_id: str, in_tx: InTx | None = None
) -> bool:
    """Soft-deletes the experiment and its files; history stays."""
    if not is_uuid(experiment_id):
        return False
    async with conn.transaction():
        cur = await conn.execute(
            """
            UPDATE experiments SET deleted_at = now()
            WHERE id = %s AND workspace_id = %s AND deleted_at IS NULL
            RETURNING node_id""",
            (experiment_id, storage.workspace_id),
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
