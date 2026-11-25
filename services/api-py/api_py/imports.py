"""
Import folder as Experiment (docs/experiment-runs.md): a folder already in
the workspace becomes an Experiment without its bytes being sent again. The
Experiment's files share the folder's stored bytes and start a history of
their own, so the folder stays as it was unless it is moved.
"""

from __future__ import annotations

import json
from typing import Any

from psycopg import AsyncConnection

from .paths import kind_for_path

# The planned parameters, when the folder has them at its top.
PARAMS_FILE = "params.json"
POINTER_FILE = "EXPERIMENT.md"


def _like(prefix: str) -> str:
    """A LIKE pattern for the paths under `prefix`/."""
    escaped = prefix.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"{escaped}/%"


async def folder_files(
    conn: AsyncConnection, workspace_id: str, node_id: str | None, folder: str
) -> list[dict[str, Any]]:
    """The live files under `folder` in a node (None: the workspace root), with their versions now."""
    cur = await conn.execute(
        """
        SELECT f.path, v.id, v.blob_sha256, v.size, v.mime
        FROM files f JOIN file_versions v ON v.id = f.current_version_id
        WHERE f.workspace_id = %(ws)s AND f.experiment_id IS NULL AND f.deleted_at IS NULL
          AND f.node_id IS NOT DISTINCT FROM %(node)s::uuid
          AND f.path LIKE %(under)s ESCAPE '\\'
        ORDER BY f.path""",
        {"ws": workspace_id, "node": node_id, "under": _like(folder)},
    )
    return [
        {
            "path": row[0],
            "relative": row[0][len(folder) + 1 :],
            "version": str(row[1]),
            "sha256": row[2],
            "size": int(row[3]),
            "mime": row[4],
        }
        for row in await cur.fetchall()
    ]


def planned_params(data: bytes) -> dict[str, Any] | None:
    """A params.json's object, or None when it isn't one."""
    try:
        value = json.loads(data.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        return None
    return value if isinstance(value, dict) else None


async def copy_into(
    conn: AsyncConnection,
    workspace_id: str,
    experiment_id: str,
    files: list[dict[str, Any]],
    author: str,
    author_id: str,
) -> None:
    """
    Adds each file to the Experiment at its path relative to the folder, as a
    new file whose first version shares the folder's stored bytes. Not marked
    as forked from the folder, so its history starts here.
    """
    for f in files:
        cur = await conn.execute(
            """
            INSERT INTO files (workspace_id, experiment_id, path, kind, mime)
            VALUES (%s, %s, %s, %s, %s) RETURNING id""",
            (workspace_id, experiment_id, f["relative"], kind_for_path(f["relative"]), f["mime"]),
        )
        (file_id,) = await cur.fetchone()  # pyrefly: ignore[not-iterable]
        cur = await conn.execute(
            """
            INSERT INTO file_versions (file_id, blob_sha256, size, mime, author_type, author_id)
            VALUES (%s, %s, %s, %s, %s, %s) RETURNING id""",
            (file_id, f["sha256"], f["size"], f["mime"], author, author_id),
        )
        (version_id,) = await cur.fetchone()  # pyrefly: ignore[not-iterable]
        await conn.execute(
            "UPDATE files SET current_version_id = %s WHERE id = %s", (version_id, file_id)
        )


async def restriction(
    conn: AsyncConnection, workspace_id: str, source: str | None, destination: str | None
) -> dict[str, Any] | None:
    """
    The restricted node the folder is in, nearest first, when the destination
    is outside it: importing there opens the folder's content to whoever can
    see the destination. None otherwise.
    """
    if source is None:
        return None
    cur = await conn.execute(
        """
        SELECT r.id, r.name,
               %(dest)s::uuid IS NOT NULL AND EXISTS (
                 SELECT 1 FROM nodes d WHERE d.id = %(dest)s::uuid AND d.path <@ r.path)
        FROM nodes s JOIN nodes r
          ON r.workspace_id = s.workspace_id AND r.restricted AND r.deleted_at IS NULL
         AND s.path <@ r.path
        WHERE s.id = %(source)s::uuid AND s.workspace_id = %(ws)s
        ORDER BY nlevel(r.path) DESC LIMIT 1""",
        {"ws": workspace_id, "source": source, "dest": destination},
    )
    row = await cur.fetchone()
    if row is None or row[2]:
        return None
    return {"id": str(row[0]), "name": row[1]}


def pointer_text(title: str, experiment_id: str) -> bytes:
    """EXPERIMENT.md: the Experiment's title and link, nothing else from it."""
    return (
        f"# {title}\n\nThis folder was imported as the experiment "
        f"[{title}](/?experiment_id={experiment_id}).\n"
    ).encode()
