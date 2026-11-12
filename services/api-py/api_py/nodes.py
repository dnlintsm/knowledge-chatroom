"""The knowledge tree of one workspace, as apps/agent/src/storage/nodes.ts.

Levels come from node_types (seeded as tech > module > loop > process), and
every node sits exactly one level below its parent; the database enforces
that (002_knowledge_tree.sql). Each function runs on the connection it is
given, inside the transaction Session opens for its principal.
"""

from __future__ import annotations

import re
from collections.abc import Awaitable, Callable
from typing import Any

from psycopg import AsyncConnection, errors

from .access import is_uuid, iso
from .storage import Storage


class NodeError(Exception):
    """The request can't be done as asked: a bad name, no deeper level, a duplicate (400)."""


class NodeNotFoundError(NodeError):
    """No such node, or one the principal can't see (404)."""


_NODE_COLUMNS = """
    n.id, n.parent_id, t.name AS type, t.depth, n.name, n.updated_at,
    (SELECT count(*) FROM files f WHERE f.node_id = n.id AND f.deleted_at IS NULL) AS file_count"""


def _to_node(row: tuple[Any, ...]) -> dict[str, Any]:
    node_id, parent, type_, depth, name, updated, files = row
    return {
        "id": str(node_id),
        "parentId": str(parent) if parent else None,
        "type": type_,
        "depth": depth,
        "name": name,
        "fileCount": int(files),
        "updatedAt": iso(updated),
    }


def clean_name(name: str) -> str:
    trimmed = re.sub(r"\s+", " ", name.strip())
    if not trimmed:
        raise NodeError("A node needs a name")
    if len(trimmed) > 200:
        raise NodeError("Node names are at most 200 characters")
    return trimmed


def _explain(err: errors.Error) -> Exception:
    """Constraint and trigger errors, as messages a user can act on."""
    if isinstance(err, errors.UniqueViolation):
        return NodeError("A node with that name already exists here")
    if isinstance(err, errors.RaiseException):
        return NodeError(err.diag.message_primary or "Invalid node")
    return err


async def types(conn: AsyncConnection, workspace_id: str) -> list[dict[str, Any]]:
    cur = await conn.execute(
        "SELECT name, depth FROM node_types WHERE workspace_id = %s ORDER BY depth", (workspace_id,)
    )
    return [{"name": name, "depth": depth} for name, depth in await cur.fetchall()]


async def list_nodes(conn: AsyncConnection, workspace_id: str) -> list[dict[str, Any]]:
    """Every live node, parents before children, siblings by name."""
    cur = await conn.execute(
        f"SELECT {_NODE_COLUMNS} FROM nodes n JOIN node_types t ON t.id = n.type_id "  # type: ignore[arg-type]
        "WHERE n.workspace_id = %s AND n.deleted_at IS NULL ORDER BY t.depth, lower(n.name)",
        (workspace_id,),
    )
    return [_to_node(row) for row in await cur.fetchall()]


async def get(conn: AsyncConnection, workspace_id: str, node_id: str) -> dict[str, Any] | None:
    if not is_uuid(node_id):
        return None
    cur = await conn.execute(
        f"SELECT {_NODE_COLUMNS} FROM nodes n JOIN node_types t ON t.id = n.type_id "  # type: ignore[arg-type]
        "WHERE n.id = %s AND n.workspace_id = %s AND n.deleted_at IS NULL",
        (node_id, workspace_id),
    )
    row = await cur.fetchone()
    return _to_node(row) if row else None


async def find_child(
    conn: AsyncConnection, workspace_id: str, parent_id: str | None, raw_name: str
) -> dict[str, Any] | None:
    """The live node named `raw_name` (any case) right below `parent_id` (None: the top level)."""
    name = clean_name(raw_name)
    if parent_id is not None and not is_uuid(parent_id):
        return None
    cur = await conn.execute(
        f"SELECT {_NODE_COLUMNS} FROM nodes n JOIN node_types t ON t.id = n.type_id "  # type: ignore[arg-type]
        "WHERE n.workspace_id = %s AND n.deleted_at IS NULL AND n.parent_id IS NOT DISTINCT FROM %s::uuid "
        "AND lower(n.name) = lower(%s)",
        (workspace_id, parent_id, name),
    )
    row = await cur.fetchone()
    return _to_node(row) if row else None


async def lineage(
    conn: AsyncConnection, workspace_id: str, node_id: str
) -> list[dict[str, Any]] | None:
    """The node and its ancestors, top level first; None if the node is missing."""
    if not is_uuid(node_id):
        return None
    cur = await conn.execute(
        """
        SELECT a.id, a.parent_id, t.name AS type, t.depth, a.name, a.updated_at,
               (SELECT count(*) FROM files f WHERE f.node_id = a.id AND f.deleted_at IS NULL) AS file_count
        FROM nodes n
        JOIN nodes a ON a.path @> n.path AND a.workspace_id = n.workspace_id
        JOIN node_types t ON t.id = a.type_id
        WHERE n.id = %s AND n.workspace_id = %s AND n.deleted_at IS NULL
        ORDER BY t.depth""",
        (node_id, workspace_id),
    )
    rows = await cur.fetchall()
    return [_to_node(row) for row in rows] or None


async def create(
    conn: AsyncConnection,
    storage: Storage,
    parent_id: str | None,
    raw_name: str,
    in_tx: Callable[[AsyncConnection, str], Awaitable[Any]],
) -> dict[str, Any]:
    """Adds a node under `parent_id` (None for the top level), one level below its parent."""
    name = clean_name(raw_name)
    ws = storage.workspace_id
    if parent_id is not None and not is_uuid(parent_id):
        raise NodeNotFoundError("Parent node not found")
    try:
        async with conn.transaction():
            parent = None
            if parent_id:
                # Held until commit, so a delete of the parent waits and then
                # removes this child too, instead of leaving it orphaned.
                cur = await conn.execute(
                    """
                    SELECT t.depth, t.name FROM nodes n JOIN node_types t ON t.id = n.type_id
                    WHERE n.id = %s AND n.workspace_id = %s AND n.deleted_at IS NULL
                    FOR SHARE OF n""",
                    (parent_id, ws),
                )
                parent = await cur.fetchone()
                if not parent:
                    raise NodeNotFoundError("Parent node not found")
            cur = await conn.execute(
                "SELECT id FROM node_types WHERE workspace_id = %s AND depth = %s",
                (ws, (parent[0] if parent else 0) + 1),
            )
            level = await cur.fetchone()
            if not level:
                raise NodeError(
                    f"Nothing can go below a {parent[1]}"
                    if parent
                    else "No knowledge levels are set up"
                )
            cur = await conn.execute(
                "INSERT INTO nodes (workspace_id, parent_id, type_id, name) VALUES (%s, %s, %s, %s) RETURNING id",
                (ws, parent_id, level[0], name),
            )
            (new_id,) = await cur.fetchone()  # type: ignore[misc]
            new_id = str(new_id)
            await in_tx(conn, new_id)
            await storage.notify(conn, {"op": "node", "change": "create", "id": new_id})
    except errors.Error as err:
        raise _explain(err) from err
    node = await get(conn, ws, new_id)
    assert node is not None
    return node


async def rename(
    conn: AsyncConnection,
    storage: Storage,
    node_id: str,
    raw_name: str,
    in_tx: Callable[[AsyncConnection], Awaitable[Any]],
) -> dict[str, Any] | None:
    name = clean_name(raw_name)
    if not is_uuid(node_id):
        return None
    try:
        async with conn.transaction():
            cur = await conn.execute(
                "UPDATE nodes SET name = %s, updated_at = now() "
                "WHERE id = %s AND workspace_id = %s AND deleted_at IS NULL",
                (name, node_id, storage.workspace_id),
            )
            if not cur.rowcount:
                return None
            await in_tx(conn)
            await storage.notify(conn, {"op": "node", "change": "rename", "id": node_id})
    except errors.Error as err:
        raise _explain(err) from err
    return await get(conn, storage.workspace_id, node_id)


async def remove(
    conn: AsyncConnection,
    storage: Storage,
    node_id: str,
    in_tx: Callable[[AsyncConnection], Awaitable[Any]],
) -> bool:
    """Soft-deletes the node, everything below it, and their files. History stays."""
    if not is_uuid(node_id):
        return False
    ws = storage.workspace_id
    async with conn.transaction():
        cur = await conn.execute(
            "SELECT path FROM nodes WHERE id = %s AND workspace_id = %s AND deleted_at IS NULL FOR UPDATE",
            (node_id, ws),
        )
        target = await cur.fetchone()
        if not target:
            return False
        await conn.execute(
            """
            WITH gone AS (
              UPDATE nodes SET deleted_at = now()
              WHERE workspace_id = %s AND deleted_at IS NULL AND path <@ %s::ltree
              RETURNING id)
            UPDATE files SET deleted_at = now()
            WHERE deleted_at IS NULL AND node_id IN (SELECT id FROM gone)""",
            (ws, str(target[0])),
        )
        await in_tx(conn)
        await storage.notify(conn, {"op": "node", "change": "delete", "id": node_id})
        return True
