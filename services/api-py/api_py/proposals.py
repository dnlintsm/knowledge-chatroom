"""Proposed versions of files, as ProposalService in apps/agent/src/storage/proposals.ts.

A proposal (008_proposals.sql) is a change to a file in a knowledge node, or at
the workspace root, that someone who can edit there accepts or rejects.
Claude's edits to a node arrive this way, and an experiment's author promotes
its work to the node the same way. The bytes are a blob, so proposing an
experiment's file copies nothing. Each function runs on the connection it is
given, inside the transaction Session opens for its principal.
"""

from __future__ import annotations

import uuid
from collections.abc import Awaitable, Callable
from typing import Any

from psycopg import AsyncConnection

from .access import is_uuid, iso
from .blobs import sha256_hex
from .nodes import NodeNotFoundError
from .paths import js_trim, mime_for_path, normalize_path, utf16_len
from .storage import Storage

DECIDED = {"accept": "accepted", "reject": "rejected", "withdraw": "withdrawn"}
STATUSES = ("open", "accepted", "rejected", "withdrawn")
MAX_NOTE_CHARS = 2000
# For list(): proposals on every place.
EVERYWHERE = object()

InTx = Callable[[AsyncConnection], Awaitable[Any]]


class ProposalError(Exception):
    """The request can't be done as asked: nothing changed, already decided, ... (400)."""


# The live file at a proposal's path, as a join condition on f for proposal p.
_TARGET_FILE = """
    f.workspace_id = p.workspace_id AND f.node_id IS NOT DISTINCT FROM p.node_id
    AND f.experiment_id IS NULL AND f.path = p.path AND f.deleted_at IS NULL"""

_SELECT = f"""
    SELECT p.id, p.node_id, p.path, p.blob_sha256, p.size, p.mime, p.author_type, p.author_id,
           u.name AS author_name, p.experiment_id,
           CASE WHEN experiment_access(%(user)s, p.experiment_id) IS NOT NULL THEN e.title END
             AS experiment_title,
           p.note, p.status, d.name AS decided_by_name, p.decided_at, p.created_at, p.updated_at,
           f.id IS NULL AS is_new,
           f.current_version_id IS DISTINCT FROM p.base_version_id AS file_changed,
           p.author_id = %(user)s AS mine,
           place_rank(p.workspace_id, %(user)s, p.node_id, NULL) >= 2 AS can_decide
    FROM proposals p
    LEFT JOIN nodes n ON n.id = p.node_id
    LEFT JOIN users u ON u.id = p.author_id
    LEFT JOIN users d ON d.id = p.decided_by
    LEFT JOIN experiments e ON e.id = p.experiment_id
    LEFT JOIN files f ON {_TARGET_FILE}
    WHERE p.workspace_id = %(ws)s
      AND (p.node_id IS NULL OR n.deleted_at IS NULL)
      AND (p.author_id = %(user)s OR place_rank(p.workspace_id, %(user)s, p.node_id, NULL) >= 1)"""


def _uuid_or_none(value: Any) -> str | None:
    return str(value) if value is not None else None


def _to_proposal(row: tuple[Any, ...]) -> dict[str, Any]:
    (
        id_,
        node,
        path,
        sha256,
        size,
        mime,
        author,
        author_id,
        author_name,
        experiment,
        experiment_title,
        note,
        status,
        decided_by_name,
        decided_at,
        created,
        updated,
        is_new,
        file_changed,
        mine,
        can_decide,
    ) = row
    return {
        "id": str(id_),
        "node": _uuid_or_none(node),
        "path": path,
        "sha256": sha256,
        "size": int(size),
        "mime": mime,
        "author": author,
        "authorId": str(author_id),
        "authorName": author_name,
        "experiment": _uuid_or_none(experiment),
        "experimentTitle": experiment_title,
        "note": note,
        "status": status,
        "decidedByName": decided_by_name,
        "decidedAt": iso(decided_at),
        "createdAt": iso(created),
        "updatedAt": iso(updated),
        "isNew": is_new,
        "fileChanged": file_changed,
        "mine": mine,
        "canDecide": can_decide,
    }


async def list_proposals(
    conn: AsyncConnection,
    workspace_id: str,
    user_id: str,
    *,
    node: str | None | object = EVERYWHERE,
    experiment: str | None = None,
    status: str = "open",
    limit: int = 200,
) -> list[dict[str, Any]]:
    """Proposals `user_id` may see (on places they can read, and their own), newest first."""
    if isinstance(node, str) and node and not is_uuid(node):
        return []
    if experiment is not None and not is_uuid(experiment):
        return []
    where = ""
    if status != "all":
        where += " AND p.status = %(status)s"
    if node is not EVERYWHERE:
        where += " AND p.node_id IS NOT DISTINCT FROM %(node)s::uuid"
    if experiment is not None:
        where += " AND p.experiment_id = %(experiment)s"
    cur = await conn.execute(
        f"{_SELECT} {where} ORDER BY p.updated_at DESC, p.id LIMIT %(limit)s",  # type: ignore[arg-type]
        {
            "user": user_id,
            "ws": workspace_id,
            "status": status,
            "node": None if node is EVERYWHERE else node,
            "experiment": experiment,
            "limit": min(max(limit, 1), 500),
        },
    )
    return [_to_proposal(row) for row in await cur.fetchall()]


async def get(
    conn: AsyncConnection, workspace_id: str, user_id: str, proposal_id: str
) -> dict[str, Any] | None:
    if not is_uuid(proposal_id):
        return None
    cur = await conn.execute(
        f"{_SELECT} AND p.id = %(id)s",  # type: ignore[arg-type]
        {"user": user_id, "ws": workspace_id, "id": proposal_id},
    )
    row = await cur.fetchone()
    return _to_proposal(row) if row else None


async def propose(
    conn: AsyncConnection,
    storage: Storage,
    *,
    node: str | None,
    path: str,
    content: bytes | dict[str, Any],
    author: str,
    author_id: str,
    mime: str | None = None,
    experiment_id: str | None = None,
    note: str | None = None,
    in_tx: Callable[[AsyncConnection, str], Awaitable[Any]] | None = None,
) -> str:
    """
    Proposes new content for a file: bytes, or a blob already stored ({sha256,
    size}, an experiment's file). The proposer's open proposal for the same
    file, if any, is replaced, so Claude revising its edit leaves one to review.
    Returns its id; ProposalError when the file already has this content.
    """
    path = normalize_path(path)
    mime = mime or mime_for_path(path)
    note = js_trim(note or "")
    if utf16_len(note) > MAX_NOTE_CHARS:
        raise ProposalError(f"Notes are at most {MAX_NOTE_CHARS} characters")
    ws = storage.workspace_id
    if isinstance(content, bytes):
        sha256, size = sha256_hex(content), len(content)
        await storage.blobs.put(sha256, content, mime)  # type: ignore[union-attr]
    else:
        sha256, size = content["sha256"], content["size"]

    async with conn.transaction():
        if isinstance(content, bytes):
            await conn.execute(
                "INSERT INTO blobs (sha256, size) VALUES (%s, %s) ON CONFLICT (sha256) DO NOTHING",
                (sha256, size),
            )
        # No row lock (viewers may propose, and can't lock a node): a proposal on a
        # node deleted meanwhile is just never listed.
        if node:
            cur = await conn.execute(
                "SELECT 1 FROM nodes WHERE id = %s AND workspace_id = %s AND deleted_at IS NULL",
                (node, ws),
            )
            if not await cur.fetchone():
                raise NodeNotFoundError("Node not found")
        cur = await conn.execute(
            """
            SELECT f.current_version_id, v.blob_sha256, f.mime
            FROM files f JOIN file_versions v ON v.id = f.current_version_id
            WHERE f.workspace_id = %s AND f.node_id IS NOT DISTINCT FROM %s::uuid
              AND f.experiment_id IS NULL AND f.path = %s AND f.deleted_at IS NULL""",
            (ws, node, path),
        )
        file = await cur.fetchone()
        if file and file[1] == sha256 and file[2] == mime:
            raise ProposalError(f"{path} already has this content; there is nothing to propose")
        fields = {
            "base_version_id": file[0] if file else None,
            "blob_sha256": sha256,
            "size": size,
            "mime": mime,
            "experiment_id": experiment_id,
            "note": note,
        }
        assignments = ", ".join(f"{column} = %({column})s" for column in fields)
        cur = await conn.execute(
            f"""
            UPDATE proposals SET {assignments}, updated_at = now()
            WHERE workspace_id = %(ws)s AND node_id IS NOT DISTINCT FROM %(node)s::uuid
              AND path = %(path)s AND author_type = %(author)s AND author_id = %(author_id)s
              AND status = 'open'
            RETURNING id""",  # type: ignore[arg-type]
            {
                **fields,
                "ws": ws,
                "node": node,
                "path": path,
                "author": author,
                "author_id": author_id,
            },
        )
        replaced = await cur.fetchone()
        # Chosen here: with row-level security a new row may not be readable back.
        proposal_id = str(replaced[0]) if replaced else str(uuid.uuid4())
        if not replaced:
            await conn.execute(
                """
                INSERT INTO proposals (id, workspace_id, node_id, path, author_type, author_id, base_version_id,
                                       blob_sha256, size, mime, experiment_id, note)
                VALUES (%(id)s, %(ws)s, %(node)s, %(path)s, %(author)s, %(author_id)s, %(base_version_id)s,
                        %(blob_sha256)s, %(size)s, %(mime)s, %(experiment_id)s, %(note)s)""",
                {
                    **fields,
                    "id": proposal_id,
                    "ws": ws,
                    "node": node,
                    "path": path,
                    "author": author,
                    "author_id": author_id,
                },
            )
        if in_tx:
            await in_tx(conn, proposal_id)
        await storage.notify(
            conn,
            {
                "op": "proposal",
                "change": "update" if replaced else "create",
                "id": proposal_id,
                "node": node,
                "path": path,
                "author": author,
                "authorId": author_id,
            },
        )
        return proposal_id


async def decide_in(
    conn: AsyncConnection,
    storage: Storage,
    proposal_id: str,
    decision: str,
    user_id: str,
) -> None:
    """
    Inside a transaction, marks an open proposal decided. For an accept, call it
    after writing the file, so it records the version that made. ProposalError
    if it was already decided.
    """
    status = DECIDED[decision]
    cur = await conn.execute(
        f"""
        UPDATE proposals p
        SET status = %(status)s, decided_by = %(user)s, decided_at = now(), updated_at = now(),
            version_id = CASE WHEN %(status)s = 'accepted' THEN (
              SELECT f.current_version_id FROM files f WHERE {_TARGET_FILE}) END
        WHERE p.id = %(id)s AND p.workspace_id = %(ws)s AND p.status = 'open'
        RETURNING p.node_id, p.path, p.author_type, p.author_id""",  # type: ignore[arg-type]
        {
            "status": status,
            "user": user_id,
            "id": proposal_id,
            "ws": storage.workspace_id,
        },
    )
    row = await cur.fetchone()
    if not row:
        raise ProposalError("This proposal was already accepted, rejected or withdrawn")
    node, path, author, author_id = row
    await storage.notify(
        conn,
        {
            "op": "proposal",
            "change": status,
            "id": proposal_id,
            "node": _uuid_or_none(node),
            "path": path,
            "author": author,
            "authorId": str(author_id),
        },
    )


async def decide(
    conn: AsyncConnection,
    storage: Storage,
    proposal_id: str,
    decision: str,
    user_id: str,
    in_tx: InTx | None = None,
) -> None:
    """Marks an open proposal decided in a transaction of its own."""
    async with conn.transaction():
        await decide_in(conn, storage, proposal_id, decision, user_id)
        if in_tx:
            await in_tx(conn)


async def promotable(
    conn: AsyncConnection, workspace_id: str, experiment_id: str
) -> list[dict[str, Any]]:
    """
    Files an experiment changed (or added) since it forked that its node doesn't
    have as they are now: what promoting it would propose. A file the experiment
    left alone isn't listed even if the node's copy moved on, so promoting never
    undoes someone else's work on the node.
    """
    if not is_uuid(experiment_id):
        return []
    cur = await conn.execute(
        """
        SELECT f.path, v.size, f.mime,
               CASE WHEN nf.id IS NULL THEN 'new' ELSE 'changed' END AS change,
               (SELECT p.id FROM proposals p
                WHERE p.experiment_id = e.id AND p.status = 'open' AND p.path = f.path
                  AND p.node_id IS NOT DISTINCT FROM e.node_id AND p.blob_sha256 = v.blob_sha256 AND p.mime = f.mime
                LIMIT 1) AS proposal
        FROM experiments e
        JOIN files f ON f.experiment_id = e.id AND f.deleted_at IS NULL
        JOIN file_versions v ON v.id = f.current_version_id
        LEFT JOIN file_versions fv ON fv.id = f.forked_from
        LEFT JOIN files nf ON nf.workspace_id = e.workspace_id AND nf.node_id IS NOT DISTINCT FROM e.node_id
          AND nf.experiment_id IS NULL AND nf.path = f.path AND nf.deleted_at IS NULL
        LEFT JOIN file_versions nv ON nv.id = nf.current_version_id
        WHERE e.id = %s AND e.workspace_id = %s AND e.deleted_at IS NULL
          AND (fv.id IS NULL OR fv.blob_sha256 <> v.blob_sha256 OR fv.mime <> f.mime)
          AND (nv.id IS NULL OR nv.blob_sha256 <> v.blob_sha256 OR nf.mime <> f.mime)
        ORDER BY f.path""",
        (experiment_id, workspace_id),
    )
    return [
        {
            "path": path,
            "size": int(size),
            "mime": mime,
            "change": change,
            "proposal": _uuid_or_none(proposal),
        }
        for path, size, mime, change, proposal in await cur.fetchall()
    ]


async def experiment_file(
    conn: AsyncConnection, workspace_id: str, experiment_id: str, path: str
) -> dict[str, Any] | None:
    """The current bytes' blob of an experiment's file, for proposing it."""
    cur = await conn.execute(
        """
        SELECT v.blob_sha256, v.size, f.mime
        FROM files f JOIN file_versions v ON v.id = f.current_version_id
        WHERE f.workspace_id = %s AND f.experiment_id = %s AND f.path = %s AND f.deleted_at IS NULL""",
        (workspace_id, experiment_id, normalize_path(path)),
    )
    row = await cur.fetchone()
    return {"sha256": row[0], "size": int(row[1]), "mime": row[2]} if row else None
