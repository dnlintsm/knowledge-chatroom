"""The workspace storage this server serves, once the database is ready (issue #190).

It mirrors initStorage() in apps/agent/src/storage/index.ts: the one default
workspace, whether row-level security can be used, and the change events
that every process hears through LISTEN/NOTIFY (events.ts). The TypeScript
server still applies the migrations; this side opens only once the database
has exactly the ones it knows (db.py), and until then the ported routes pass
through to the TypeScript server, which answers as it starts.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from typing import Any

from psycopg import AsyncConnection
from psycopg_pool import AsyncConnectionPool

from .access import AccessService
from .blobs import BlobStore, S3Settings
from .db import APP_ROLE
from .events import EventHub
from .search import SearchService
from .semantic import SemanticIndex

logger = logging.getLogger("api_py")

# The channel and payload of apps/agent/src/storage/events.ts.
EVENTS_CHANNEL = "workspace_files"

# What prepareRowSecurity() in db.ts grants APP_ROLE.
_READ = "workspaces, node_types, blobs, nodes, files, file_versions, experiments, users, blob_texts, blob_chunks, proposals"
_WRITE = (
    "blobs, nodes, files, file_versions, experiments, audit_log, blob_texts, blob_chunks, proposals"
)
_MEMORY = (
    "memories, memory_versions, memory_events, memory_settings, memory_incognito_chats, memory_inbox, "
    "memory_learned_chats, shared_memories, shared_memory_versions, shared_memory_proposals, shared_memory_settings"
)


@dataclass
class Storage:
    pool: AsyncConnectionPool
    workspace_id: str
    # Whether users' queries also run as APP_ROLE, so Postgres checks access too.
    row_security: bool
    access: AccessService
    # The blob store and change events, for /files; None in tests that leave them out.
    blobs: BlobStore | None = None
    events: EventHub | None = None
    # Search by meaning, when an embedding model is set (semantic.py).
    semantic: SemanticIndex | None = None

    @property
    def search(self) -> SearchService:
        return SearchService(self.workspace_id, self.blobs, self.semantic)

    async def notify(self, conn: AsyncConnection, event: dict[str, Any]) -> None:
        """Tells every process about a change, when `conn`'s transaction commits."""
        payload = json.dumps(
            {**event, "workspaceId": self.workspace_id}, separators=(",", ":"), ensure_ascii=False
        )
        await conn.execute("SELECT pg_notify(%s, %s)", (EVENTS_CHANNEL, payload))


async def prepare_row_security(conn: AsyncConnection) -> bool:
    """
    Whether APP_ROLE can be used, after granting it what the services need,
    as prepareRowSecurity() in db.ts does (both run it; the grants are idempotent).
    """
    async with conn.transaction():
        await conn.execute("SELECT pg_advisory_xact_lock(hashtext('knowledge-chatroom:migrate'))")
        cur = await conn.execute(
            """
            SELECT r.oid IS NOT NULL AND (me.rolsuper OR pg_has_role(current_user, r.oid, 'MEMBER')) AS ok
            FROM pg_roles me LEFT JOIN pg_roles r ON r.rolname = %s
            WHERE me.rolname = current_user""",
            (APP_ROLE,),
        )
        row = await cur.fetchone()
        if not row or not row[0]:
            return False
        cur = await conn.execute("SELECT current_schema()")
        (schema,) = await cur.fetchone()  # type: ignore[misc]
        role = APP_ROLE
        quoted = '"' + schema.replace('"', '""') + '"'
        grants = [
            f"GRANT USAGE ON SCHEMA {quoted} TO {role}",
            f"GRANT SELECT ON {_READ} TO {role}",
            f"GRANT INSERT ON {_WRITE} TO {role}",
            f"GRANT UPDATE ON nodes, files, experiments, proposals TO {role}",
            f"GRANT USAGE ON SEQUENCE audit_log_id_seq TO {role}",
            f"GRANT SELECT, INSERT, UPDATE, DELETE ON chats, chat_runs TO {role}",
            f"GRANT SELECT, INSERT, UPDATE, DELETE ON {_MEMORY} TO {role}",
            f"GRANT SELECT ON memory_pack_installs, hub_memory_packs, hub_memory_pack_versions TO {role}",
        ]
        for statement in grants:
            await conn.execute(statement)  # type: ignore[arg-type]
        return True


async def open_storage(pool: AsyncConnectionPool, s3: S3Settings | None = None) -> Storage:
    """The storage of the default workspace; the database must be migrated. Without `s3`, no file routes."""
    async with pool.connection() as conn:
        row_security = await prepare_row_security(conn)
        cur = await conn.execute("SELECT id FROM workspaces WHERE slug = 'default'")
        row = await cur.fetchone()
    if not row:
        raise RuntimeError("Workspace default not found")
    if not row_security:
        logger.warning(
            "row-level security is off: this database user can't use role %s (see 004_row_security.sql). "
            "Access is still checked by the app.",
            APP_ROLE,
        )
    workspace_id = str(row[0])
    blobs = None
    if s3 is not None:
        blobs = BlobStore(s3)
        await blobs.ensure_bucket()
    return Storage(
        pool=pool,
        workspace_id=workspace_id,
        row_security=row_security,
        access=AccessService(pool, workspace_id),
        blobs=blobs,
        events=EventHub(pool.conninfo, workspace_id, EVENTS_CHANNEL),
    )
