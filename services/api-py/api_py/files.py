"""Files at the workspace root or in a knowledge node, as FileService in apps/agent/src/storage/files.ts.

Every write adds an immutable version; reads return the current one. Bytes go
to the blob store first, so a crash can leave an unreferenced blob (harmless,
collectable later) but never a dangling row. An experiment's files are their own
place: an experiment's files change on their own, apart from its node's.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Any

from psycopg import AsyncConnection, errors

from .access import is_uuid, iso
from .blobs import sha256_hex
from .experiments import lock_live_experiment
from .nodes import NodeNotFoundError
from .paths import kind_for_path, mime_for_path, normalize_path
from .storage import Storage
from .text_index import index_blob

InTx = Callable[[AsyncConnection], Awaitable[Any]]


class FileExistsError_(Exception):
    """A create-only write, or a rename, to a path that already has a file."""

    def __init__(self, path: str) -> None:
        super().__init__(f"{path} already exists")
        self.path = path


_INFO = """
    SELECT f.path, f.kind, f.mime, v.size, v.blob_sha256, f.updated_at, v.author_type
    FROM files f JOIN file_versions v ON v.id = f.current_version_id"""


def _to_info(row: tuple[Any, ...]) -> dict[str, Any]:
    return {
        "path": row[0],
        "kind": row[1],
        "mime": row[2],
        "size": int(row[3]),
        "sha256": row[4],
        "updatedAt": iso(row[5]),
        "author": row[6],
    }


class FileService:
    """One place's files: the workspace root (node_id None), a knowledge node, or an experiment."""

    def __init__(
        self, storage: Storage, node_id: str | None = None, experiment_id: str | None = None
    ) -> None:
        self.storage = storage
        # None for the workspace root, and for an experiment's files.
        self.node_id = node_id
        self.experiment_id = experiment_id

    @property
    def ws(self) -> str:
        return self.storage.workspace_id

    async def in_node(self, conn: AsyncConnection, node_id: str | None) -> FileService | None:
        """The same workspace's files in another node (None = root), or None if that node doesn't exist."""
        if node_id is not None:
            if not is_uuid(node_id):
                return None
            cur = await conn.execute(
                "SELECT 1 FROM nodes WHERE id = %s AND workspace_id = %s AND deleted_at IS NULL",
                (node_id, self.ws),
            )
            if not await cur.fetchone():
                return None
        return FileService(self.storage, node_id)

    async def in_experiment(self, conn: AsyncConnection, experiment_id: str) -> FileService | None:
        """An experiment's files, or None if it doesn't exist (see experiments.py)."""
        if not is_uuid(experiment_id):
            return None
        cur = await conn.execute(
            "SELECT 1 FROM experiments WHERE id = %s AND workspace_id = %s AND deleted_at IS NULL",
            (experiment_id, self.ws),
        )
        if not await cur.fetchone():
            return None
        return FileService(self.storage, None, experiment_id)

    @property
    def place(self) -> dict[str, Any]:
        """Where change events say this place's files are."""
        if self.experiment_id is not None:
            return {"node": None, "experiment": self.experiment_id}
        return {"node": self.node_id}

    def _here(self) -> tuple[str, tuple[Any, ...]]:
        """WHERE condition for files in this place."""
        if self.experiment_id is not None:
            return "f.workspace_id = %s AND f.experiment_id = %s", (self.ws, self.experiment_id)
        if self.node_id is None:
            return "f.workspace_id = %s AND f.node_id IS NULL AND f.experiment_id IS NULL", (
                self.ws,
            )
        return "f.workspace_id = %s AND f.node_id = %s", (self.ws, self.node_id)

    async def list(self, conn: AsyncConnection) -> list[dict[str, Any]]:
        here, args = self._here()
        cur = await conn.execute(
            f"{_INFO} WHERE {here} AND f.deleted_at IS NULL ORDER BY f.path",  # type: ignore[arg-type]
            args,
        )
        return [_to_info(row) for row in await cur.fetchall()]

    async def stat(self, conn: AsyncConnection, raw_path: str) -> dict[str, Any] | None:
        path = normalize_path(raw_path)
        here, args = self._here()
        cur = await conn.execute(
            f"{_INFO} WHERE {here} AND f.path = %s AND f.deleted_at IS NULL",  # type: ignore[arg-type]
            (*args, path),
        )
        row = await cur.fetchone()
        return _to_info(row) if row else None

    async def read(
        self, conn: AsyncConnection, raw_path: str
    ) -> tuple[dict[str, Any], bytes] | None:
        info = await self.stat(conn, raw_path)
        if not info:
            return None
        return info, await self.storage.blobs.get(info["sha256"])

    async def _lock_node(self, conn: AsyncConnection) -> None:
        """Holds the node or experiment until commit, so it can't be deleted under a write (NodeService.lockLive)."""
        if self.experiment_id is not None:
            await lock_live_experiment(conn, self.ws, self.experiment_id)
            return
        if self.node_id is None:
            return
        cur = await conn.execute(
            "SELECT 1 FROM nodes WHERE id = %s AND workspace_id = %s AND deleted_at IS NULL FOR SHARE",
            (self.node_id, self.ws),
        )
        if not await cur.fetchone():
            raise NodeNotFoundError("Node not found")

    async def write(
        self,
        conn: AsyncConnection,
        raw_path: str,
        data: bytes,
        *,
        mime: str | None = None,
        author: str = "user",
        author_id: str | None = None,
        in_tx: InTx | None = None,
        create_only: bool = False,
    ) -> dict[str, Any]:
        """Creates the file when missing; identical bytes add no version. create_only refuses an existing file."""
        path = normalize_path(raw_path)
        mime = mime or mime_for_path(path)
        sha256 = sha256_hex(data)
        await self.storage.blobs.put(sha256, data, mime)

        here, args = self._here()
        async with conn.transaction():
            await conn.execute(
                "INSERT INTO blobs (sha256, size) VALUES (%s, %s) ON CONFLICT (sha256) DO NOTHING",
                (sha256, len(data)),
            )
            await self._lock_node(conn)
            # Create the row if needed, then lock it so concurrent writers to one
            # path serialize instead of racing on the unique index.
            created = await conn.execute(
                """
                INSERT INTO files (workspace_id, node_id, experiment_id, path, kind, mime)
                VALUES (%s, %s, %s, %s, %s, %s)
                ON CONFLICT (workspace_id, node_id, experiment_id, path) WHERE deleted_at IS NULL DO NOTHING""",
                (self.ws, self.node_id, self.experiment_id, path, kind_for_path(path), mime),
            )
            cur = await conn.execute(
                f"""
                SELECT f.id, v.blob_sha256, f.mime
                FROM files f LEFT JOIN file_versions v ON v.id = f.current_version_id
                WHERE {here} AND f.path = %s AND f.deleted_at IS NULL
                FOR UPDATE OF f""",  # type: ignore[arg-type]
                (*args, path),
            )
            file_id, current_sha, current_mime = await cur.fetchone()  # type: ignore[misc]
            if created.rowcount == 0 and create_only:
                raise FileExistsError_(path)
            if current_sha != sha256 or current_mime != mime:
                cur = await conn.execute(
                    """
                    INSERT INTO file_versions (file_id, blob_sha256, size, mime, author_type, author_id)
                    VALUES (%s, %s, %s, %s, %s, %s) RETURNING id""",
                    (file_id, sha256, len(data), mime, author, author_id),
                )
                (version_id,) = await cur.fetchone()  # type: ignore[misc]
                # For search; once per distinct content.
                await index_blob(conn, sha256, data)
                await conn.execute(
                    "UPDATE files SET current_version_id = %s, mime = %s, updated_at = now() WHERE id = %s",
                    (version_id, mime, file_id),
                )
                if in_tx:
                    await in_tx(conn)
                await self.storage.notify(
                    conn,
                    {"op": "write", **self.place, "path": path, "sha256": sha256, "author": author},
                )
        info = await self.stat(conn, path)
        assert info is not None
        return info

    async def remove(self, conn: AsyncConnection, raw_path: str, in_tx: InTx | None = None) -> bool:
        """Soft delete: history stays, and the path is free for a new file."""
        path = normalize_path(raw_path)
        here, args = self._here()
        async with conn.transaction():
            cur = await conn.execute(
                f"SELECT f.id FROM files f WHERE {here} AND f.path = %s AND f.deleted_at IS NULL FOR UPDATE OF f",  # type: ignore[arg-type]
                (*args, path),
            )
            row = await cur.fetchone()
            if not row:
                return False
            await conn.execute("UPDATE files SET deleted_at = now() WHERE id = %s", (row[0],))
            if in_tx:
                await in_tx(conn)
            await self.storage.notify(conn, {"op": "delete", **self.place, "path": path})
            return True

    async def rename(
        self,
        conn: AsyncConnection,
        raw_from: str,
        raw_to: str,
        *,
        author: str = "user",
        in_tx: InTx | None = None,
    ) -> dict[str, Any] | None:
        """
        Moves a file to another path in the same place, keeping its history.
        None when there is no file at `raw_from`; FileExistsError_ when `raw_to` is
        taken. Change events name `author` (who renamed it).
        """
        source = normalize_path(raw_from)
        target = normalize_path(raw_to)
        here, args = self._here()
        try:
            async with conn.transaction():
                await self._lock_node(conn)
                cur = await conn.execute(
                    f"""
                    SELECT f.id, f.mime, v.blob_sha256
                    FROM files f JOIN file_versions v ON v.id = f.current_version_id
                    WHERE {here} AND f.path = %s AND f.deleted_at IS NULL
                    FOR UPDATE OF f""",  # type: ignore[arg-type]
                    (*args, source),
                )
                row = await cur.fetchone()
                if not row:
                    return None
                file_id, mime, sha256 = row
                if source != target:
                    cur = await conn.execute(
                        f"SELECT 1 FROM files f WHERE {here} AND f.path = %s AND f.deleted_at IS NULL",  # type: ignore[arg-type]
                        (*args, target),
                    )
                    if await cur.fetchone():
                        raise FileExistsError_(target)
                    # A type picked from the old name follows the new one; one set on upload stays.
                    new_mime = mime_for_path(target) if mime == mime_for_path(source) else mime
                    await conn.execute(
                        "UPDATE files SET path = %s, kind = %s, mime = %s, updated_at = now() WHERE id = %s",
                        (target, kind_for_path(target), new_mime, file_id),
                    )
                    if in_tx:
                        await in_tx(conn)
                    await self.storage.notify(conn, {"op": "delete", **self.place, "path": source})
                    await self.storage.notify(
                        conn,
                        {
                            "op": "write",
                            **self.place,
                            "path": target,
                            "sha256": sha256,
                            "author": author,
                        },
                    )
        except errors.UniqueViolation as err:
            # Someone else took the name between the check and the update.
            raise FileExistsError_(target) from err
        return await self.stat(conn, target)

    async def history(self, conn: AsyncConnection, raw_path: str) -> list[dict[str, Any]] | None:
        path = normalize_path(raw_path)
        here, args = self._here()
        cur = await conn.execute(
            f"SELECT f.id FROM files f WHERE {here} AND f.path = %s AND f.deleted_at IS NULL",  # type: ignore[arg-type]
            (*args, path),
        )
        row = await cur.fetchone()
        if not row:
            return None
        cur = await conn.execute(
            """
            SELECT id, blob_sha256, size, mime, author_type, author_id, created_at
            FROM file_versions WHERE file_id = %s
            ORDER BY created_at DESC, id DESC""",
            (row[0],),
        )
        return [
            {
                "id": str(r[0]),
                "sha256": r[1],
                "size": int(r[2]),
                "mime": r[3],
                "author": r[4],
                "authorId": str(r[5]) if r[5] is not None else None,
                "createdAt": iso(r[6]),
            }
            for r in await cur.fetchall()
        ]
