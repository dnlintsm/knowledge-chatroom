"""Users, the org tree (groups), grants and the audit log, as apps/agent/src/storage/access.ts.

The role logic lives in SQL (effective_role in 003_access.sql); this is the
Python side, with the same queries, so both servers answer alike.
"""

from __future__ import annotations

import logging
import re
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Literal

from psycopg import AsyncConnection, errors
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from psycopg_pool import AsyncConnectionPool

Role = Literal["viewer", "editor", "owner"]
ROLES: tuple[Role, ...] = ("viewer", "editor", "owner")
_ROLE_RANK: dict[str, int] = {role: rank for rank, role in enumerate(ROLES)}
logger = logging.getLogger("api_py")

_UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.IGNORECASE)
# How often a user's last_seen_at is refreshed, at most.
SEEN_EVERY_SECONDS = 5 * 60

InTx = Callable[[AsyncConnection], Awaitable[Any]]


def is_uuid(value: object) -> bool:
    return isinstance(value, str) and bool(_UUID.match(value))


def _checked_role(value: object) -> Role | None:
    """Treat unexpected database roles as no access, and report the inconsistency."""
    if value is None or value == "viewer" or value == "editor" or value == "owner":
        return value
    logger.error("Unexpected effective role from database: %r", value)
    return None


def at_least(role: str | None, minimum: Role) -> bool:
    return _ROLE_RANK.get(role, -1) >= _ROLE_RANK[minimum] if role is not None else False


def iso(value: datetime | None) -> str | None:
    """A timestamp as JavaScript's toISOString() writes it: UTC, milliseconds, Z."""
    if value is None:
        return None
    utc = value.astimezone(UTC)
    return utc.strftime("%Y-%m-%dT%H:%M:%S.") + f"{utc.microsecond // 1000:03d}Z"


@dataclass(frozen=True)
class Principal:
    """Who is asking: a user, or Claude acting for that user (through `via`, a storage token's)."""

    user_id: str
    actor: Literal["user", "agent"] = "user"
    via: str | None = None


class ForbiddenError(Exception):
    """Signed in, but not allowed to do this (403)."""


class AccessError(Exception):
    """The request names something invalid: a bad name, an unknown user (400)."""


def _clean_name(name: str, what: str) -> str:
    trimmed = re.sub(r"\s+", " ", name.strip())
    if not trimmed:
        raise AccessError(f"A {what} needs a name")
    if len(trimmed) > 200:
        raise AccessError(f"{what} names are at most 200 characters")
    return trimmed


def _explain(err: errors.Error) -> Exception:
    if isinstance(err, errors.UniqueViolation):
        return AccessError("That name is already taken here")
    if isinstance(err, errors.ForeignKeyViolation):
        return AccessError("Unknown user or group")
    if isinstance(err, errors.RaiseException):
        return AccessError(err.diag.message_primary or "Invalid request")
    return err


class AccessService:
    def __init__(self, pool: AsyncConnectionPool, workspace_id: str) -> None:
        self.pool = pool
        self.workspace_id = workspace_id
        self._local_user: str | None = None
        self._subjects: dict[str, tuple[str, float]] = {}

    async def local_user_id(self) -> str:
        """The built-in user of a deployment without login."""
        if self._local_user is None:
            async with self.pool.connection() as conn:
                cur = await conn.execute("SELECT id FROM users WHERE subject = 'local'")
                row = await cur.fetchone()
            if not row:
                raise RuntimeError("The local user is missing (001_init.sql makes it)")
            self._local_user = str(row[0])
        return self._local_user

    async def user_for_subject(
        self, subject: str, email: str | None = None, name: str | None = None
    ) -> str:
        """
        The user for a login identity, created on first sight. Name and email
        follow the provider. The first user to sign in to a workspace that only
        the local user owns becomes its owner, so a new deployment can be set up.
        """
        cached = self._subjects.get(subject)
        if cached:
            user_id, seen = cached
            now = time.monotonic()
            if now - seen >= SEEN_EVERY_SECONDS:
                self._subjects[subject] = (user_id, now)
                async with self.pool.connection() as conn:
                    await conn.execute(
                        "UPDATE users SET last_seen_at = now() WHERE id = %s", (user_id,)
                    )
            return user_id
        async with self.pool.connection() as conn, conn.transaction():
            cur = await conn.execute(
                """
                INSERT INTO users (subject, email, name, last_seen_at)
                VALUES (%s, %s, %s, now())
                ON CONFLICT (subject) DO UPDATE
                  SET email = coalesce(EXCLUDED.email, users.email),
                      name = coalesce(EXCLUDED.name, users.name),
                      last_seen_at = now()
                RETURNING id""",
                (subject, email, name),
            )
            (user_id,) = await cur.fetchone()  # pyrefly: ignore[not-iterable]
            user_id = str(user_id)
            # Serialize first sign-ins so exactly one becomes the owner.
            await conn.execute(
                "SELECT pg_advisory_xact_lock(hashtext('knowledge-chatroom:first-owner'))"
            )
            await conn.execute(
                """
                INSERT INTO grants (workspace_id, node_id, principal_type, principal_id, role)
                SELECT %(ws)s, NULL, 'user', %(user)s, 'owner'
                WHERE NOT EXISTS (
                  SELECT 1 FROM grants g JOIN users u ON u.id = g.principal_id
                  WHERE g.workspace_id = %(ws)s AND g.principal_type = 'user'
                    AND g.role = 'owner' AND u.subject <> 'local')
                ON CONFLICT DO NOTHING""",
                {"ws": self.workspace_id, "user": user_id},
            )
        self._subjects[subject] = (user_id, time.monotonic())
        return user_id

    async def role(self, user_id: str, node_id: str | None) -> Role | None:
        """The user's best role on a node (None = workspace root), or None if none."""
        if node_id is not None and not is_uuid(node_id):
            return None
        async with self.pool.connection() as conn:
            cur = await conn.execute(
                "SELECT effective_role(%s, %s, %s::uuid)", (self.workspace_id, user_id, node_id)
            )
            row = await cur.fetchone()
        if row is None:
            raise RuntimeError("effective_role query returned no row")
        return _checked_role(row[0])

    async def sees_node(self, user_id: str, node_id: str) -> bool:
        """Whether the user sees the node or anything below it (a node event's audience)."""
        if not is_uuid(node_id):
            return False
        async with self.pool.connection() as conn:
            cur = await conn.execute(
                """
                SELECT bool_or(effective_role(%(ws)s, %(user)s, d.id) IS NOT NULL)
                FROM nodes n JOIN nodes d ON d.path <@ n.path AND d.workspace_id = n.workspace_id
                WHERE n.id = %(node)s AND n.workspace_id = %(ws)s""",
                {"ws": self.workspace_id, "user": user_id, "node": node_id},
            )
            row = await cur.fetchone()
        return bool(row and row[0])

    async def experiment_access(self, user_id: str, experiment_id: str) -> str | None:
        """What the user may do with an experiment's files ("writer", "reader"), or None (ExperimentService.access)."""
        if not is_uuid(experiment_id):
            return None
        async with self.pool.connection() as conn:
            cur = await conn.execute(
                "SELECT experiment_access(%s, %s::uuid)", (user_id, experiment_id)
            )
            (found,) = await cur.fetchone()  # pyrefly: ignore[not-iterable]
        return found

    async def hears_experiment(self, user_id: str, experiment_id: str, change: str) -> bool:
        """Whether the user hears about this change to an experiment (ExperimentService.hears)."""
        if not is_uuid(experiment_id):
            return False
        async with self.pool.connection() as conn:
            cur = await conn.execute(
                """
                SELECT e.author_id = %(user)s
                    OR ((e.status <> 'draft' OR %(change)s = 'status')
                        AND effective_role(e.workspace_id, %(user)s, e.node_id) IS NOT NULL)
                FROM experiments e
                WHERE e.id = %(id)s AND e.workspace_id = %(ws)s""",
                {"user": user_id, "change": change, "id": experiment_id, "ws": self.workspace_id},
            )
            row = await cur.fetchone()
        return bool(row and row[0])

    async def node_roles(self, user_id: str) -> dict[str, Role | None]:
        """The user's role on every live node, keyed by node id."""
        async with self.pool.connection() as conn:
            cur = await conn.execute(
                """
                SELECT id, effective_role(%(ws)s, %(user)s, id) FROM nodes
                WHERE workspace_id = %(ws)s AND deleted_at IS NULL""",
                {"ws": self.workspace_id, "user": user_id},
            )
            return {str(node): _checked_role(role) for node, role in await cur.fetchall()}

    async def user(self, user_id: str) -> dict[str, Any] | None:
        """One user's id, subject, email and name, or None."""
        if not is_uuid(user_id):
            return None
        async with self.pool.connection() as conn:
            cur = conn.cursor(row_factory=dict_row)
            await cur.execute(
                "SELECT id, subject, email, name FROM users WHERE id = %s", (user_id,)
            )
            row = await cur.fetchone()
        return {**row, "id": str(row["id"])} if row else None

    async def users(self) -> list[dict[str, Any]]:
        async with self.pool.connection() as conn:
            cur = conn.cursor(row_factory=dict_row)
            await cur.execute(
                "SELECT id, subject, email, name FROM users ORDER BY coalesce(name, email, subject)"
            )
            return [{**row, "id": str(row["id"])} for row in await cur.fetchall()]

    async def people(self) -> list[dict[str, Any]]:
        """Everyone who has signed in, with their workspace role and groups; not the built-in local user."""
        async with self.pool.connection() as conn:
            cur = conn.cursor(row_factory=dict_row)
            await cur.execute(
                """
                SELECT u.id, u.subject, u.email, u.name, u.created_at, u.last_seen_at,
                       g.id AS grant_id, g.role,
                       effective_role(%(ws)s, u.id, NULL) AS effective_role,
                       coalesce((SELECT array_agg(m.group_id ORDER BY m.group_id)
                                 FROM group_members m JOIN groups gr ON gr.id = m.group_id
                                 WHERE m.user_id = u.id AND gr.workspace_id = %(ws)s), '{}') AS group_ids
                FROM users u
                LEFT JOIN grants g ON g.workspace_id = %(ws)s AND g.node_id IS NULL
                  AND g.principal_type = 'user' AND g.principal_id = u.id
                WHERE u.subject <> 'local'
                ORDER BY lower(coalesce(u.name, u.email, u.subject))""",
                {"ws": self.workspace_id},
            )
            rows = await cur.fetchall()
        return [
            {
                "id": str(r["id"]),
                "subject": r["subject"],
                "email": r["email"],
                "name": r["name"],
                "createdAt": iso(r["created_at"]),
                "lastSeenAt": iso(r["last_seen_at"]),
                "role": r["role"],
                "grantId": str(r["grant_id"]) if r["grant_id"] else None,
                "effectiveRole": r["effective_role"],
                "groupIds": [str(g) for g in r["group_ids"]],
            }
            for r in rows
        ]

    async def groups(self) -> list[dict[str, Any]]:
        async with self.pool.connection() as conn:
            cur = await conn.execute(
                """
                SELECT g.id, g.parent_id, g.name,
                       coalesce(array_agg(m.user_id) FILTER (WHERE m.user_id IS NOT NULL), '{}')
                FROM groups g LEFT JOIN group_members m ON m.group_id = g.id
                WHERE g.workspace_id = %s
                GROUP BY g.id
                ORDER BY nlevel(g.path), lower(g.name)""",
                (self.workspace_id,),
            )
            rows = await cur.fetchall()
        return [
            {
                "id": str(gid),
                "parentId": str(parent) if parent else None,
                "name": name,
                "memberIds": [str(m) for m in members],
            }
            for gid, parent, name, members in rows
        ]

    async def create_group(
        self, parent_id: str | None, name: str, in_tx: Callable[..., Awaitable[Any]]
    ) -> str:
        clean = _clean_name(name, "group")
        if parent_id is not None and not is_uuid(parent_id):
            raise AccessError("Parent group not found")
        try:
            async with self.pool.connection() as conn, conn.transaction():
                cur = await conn.execute(
                    "INSERT INTO groups (workspace_id, parent_id, name) VALUES (%s, %s, %s) RETURNING id",
                    (self.workspace_id, parent_id, clean),
                )
                (gid,) = await cur.fetchone()  # pyrefly: ignore[not-iterable]
                await in_tx(conn, str(gid))
                return str(gid)
        except errors.Error as err:
            raise _explain(err) from err

    async def rename_group(self, group_id: str, name: str, in_tx: InTx) -> bool:
        clean = _clean_name(name, "group")
        if not is_uuid(group_id):
            return False
        try:
            async with self.pool.connection() as conn, conn.transaction():
                cur = await conn.execute(
                    "UPDATE groups SET name = %s WHERE id = %s AND workspace_id = %s",
                    (clean, group_id, self.workspace_id),
                )
                if not cur.rowcount:
                    return False
                await in_tx(conn)
                return True
        except errors.Error as err:
            raise _explain(err) from err

    async def delete_group(self, group_id: str, in_tx: InTx) -> bool:
        """Deletes the group, its sub-groups, their memberships and grants."""
        if not is_uuid(group_id):
            return False
        async with self.pool.connection() as conn, conn.transaction():
            cur = await conn.execute(
                "DELETE FROM groups WHERE id = %s AND workspace_id = %s",
                (group_id, self.workspace_id),
            )
            if not cur.rowcount:
                return False
            await in_tx(conn)
            return True

    async def set_member(self, group_id: str, user_id: str, member: bool, in_tx: InTx) -> bool:
        if not is_uuid(group_id) or not is_uuid(user_id):
            return False
        try:
            async with self.pool.connection() as conn, conn.transaction():
                cur = await conn.execute(
                    "SELECT 1 FROM groups WHERE id = %s AND workspace_id = %s",
                    (group_id, self.workspace_id),
                )
                if not await cur.fetchone():
                    return False
                if member:
                    cur = await conn.execute(
                        "INSERT INTO group_members (group_id, user_id) VALUES (%s, %s) ON CONFLICT DO NOTHING",
                        (group_id, user_id),
                    )
                else:
                    cur = await conn.execute(
                        "DELETE FROM group_members WHERE group_id = %s AND user_id = %s",
                        (group_id, user_id),
                    )
                if cur.rowcount:
                    await in_tx(conn)
                return True
        except errors.Error as err:
            raise _explain(err) from err

    _ALL = object()

    async def grants(self, node_id: str | None | object = _ALL) -> list[dict[str, Any]]:
        """Grants on one node (None = workspace), or on every node by default."""
        if isinstance(node_id, str) and node_id and not is_uuid(node_id):
            return []
        where = ""
        params: list[Any] = [self.workspace_id]
        if node_id is None:
            where = "AND node_id IS NULL"
        elif node_id is not self._ALL:
            where = "AND node_id = %s"
            params.append(node_id)
        async with self.pool.connection() as conn:
            cur = await conn.execute(
                "SELECT id, node_id, principal_type, principal_id, role, created_at FROM grants "  # pyrefly: ignore[bad-argument-type]
                f"WHERE workspace_id = %s {where} ORDER BY created_at",
                params,
            )
            rows = await cur.fetchall()
        return [
            {
                "id": str(gid),
                "nodeId": str(node) if node else None,
                "principalType": ptype,
                "principalId": str(pid),
                "role": role,
                "createdAt": iso(created),
            }
            for gid, node, ptype, pid, role, created in rows
        ]

    async def set_grant(
        self,
        node_id: str | None,
        principal_type: str,
        principal_id: str,
        role: str,
        created_by: str,
        in_tx: InTx,
    ) -> str:
        """Gives a user or group a role on a node (None = workspace); replaces their earlier role there."""
        if role not in ROLES:
            raise AccessError("Role must be viewer, editor or owner")
        if not is_uuid(principal_id):
            raise AccessError("Unknown user or group")
        try:
            async with self.pool.connection() as conn, conn.transaction():
                if principal_type == "user":
                    cur = await conn.execute("SELECT 1 FROM users WHERE id = %s", (principal_id,))
                else:
                    cur = await conn.execute(
                        "SELECT 1 FROM groups WHERE id = %s AND workspace_id = %s",
                        (principal_id, self.workspace_id),
                    )
                if not await cur.fetchone():
                    raise AccessError(f"Unknown {principal_type}")
                await self._keep_an_owner(conn, node_id, principal_type, principal_id, role)
                cur = await conn.execute(
                    """
                    INSERT INTO grants (workspace_id, node_id, principal_type, principal_id, role, created_by)
                    VALUES (%s, %s, %s, %s, %s, %s)
                    ON CONFLICT (workspace_id, node_id, principal_type, principal_id)
                    DO UPDATE SET role = EXCLUDED.role
                    RETURNING id""",
                    (self.workspace_id, node_id, principal_type, principal_id, role, created_by),
                )
                (gid,) = await cur.fetchone()  # pyrefly: ignore[not-iterable]
                await in_tx(conn)
                return str(gid)
        except errors.Error as err:
            raise _explain(err) from err

    async def revoke(self, grant_id: str, in_tx: InTx) -> bool:
        if not is_uuid(grant_id):
            return False
        async with self.pool.connection() as conn, conn.transaction():
            cur = await conn.execute(
                "SELECT node_id, principal_type, principal_id FROM grants WHERE id = %s AND workspace_id = %s",
                (grant_id, self.workspace_id),
            )
            grant = await cur.fetchone()
            if not grant:
                return False
            node, ptype, pid = grant
            await self._keep_an_owner(conn, str(node) if node else None, ptype, str(pid), None)
            await conn.execute("DELETE FROM grants WHERE id = %s", (grant_id,))
            await in_tx(conn)
            return True

    async def _keep_an_owner(
        self,
        conn: AsyncConnection,
        node_id: str | None,
        principal_type: str,
        principal_id: str,
        role: str | None,
    ) -> None:
        """Refuses a change that would leave the workspace without a user who owns it."""
        if node_id is not None or role == "owner":
            return
        await conn.execute(
            "SELECT pg_advisory_xact_lock(hashtext('knowledge-chatroom:first-owner'))"
        )
        # Once people sign in, the local user can't, so it doesn't count as an owner.
        local = await self.local_user_id()
        changing_local = principal_type == "user" and principal_id == local
        cur = await conn.execute(
            """
            SELECT 1 FROM grants
            WHERE workspace_id = %(ws)s AND node_id IS NULL AND role = 'owner'
              AND principal_type = 'user'
              AND NOT (principal_type = %(ptype)s AND principal_id = %(pid)s)
              AND (%(changing_local)s OR principal_id <> %(local)s)""",
            {
                "ws": self.workspace_id,
                "ptype": principal_type,
                "pid": principal_id,
                "changing_local": changing_local,
                "local": local,
            },
        )
        if not await cur.fetchone():
            raise AccessError(
                "The workspace needs at least one owner; make someone else owner first"
            )

    async def own_new_node(self, conn: AsyncConnection, user_id: str, node_id: str) -> None:
        """Makes the user owner of a node they just added (013_node_creator_owns.sql)."""
        await conn.execute(
            "SELECT own_new_node(workspace_id, %s, id, path) FROM nodes WHERE id = %s AND workspace_id = %s",
            (user_id, node_id, self.workspace_id),
        )

    async def audit(
        self, conn: AsyncConnection, principal: Principal, action: str, target: dict[str, Any]
    ) -> None:
        recorded = {**target, "via": principal.via} if principal.via else target
        await conn.execute(
            "INSERT INTO audit_log (workspace_id, actor_type, actor_id, action, target) VALUES (%s, %s, %s, %s, %s)",
            (self.workspace_id, principal.actor, principal.user_id, action, Jsonb(recorded)),
        )

    async def audit_log(
        self, limit: int = 100, kinds: list[str] | None = None
    ) -> list[dict[str, Any]]:
        """Newest first; `kinds` keeps only actions starting with those (e.g. "group" for group.*)."""
        where = "AND split_part(action, '.', 1) = ANY(%(kinds)s)" if kinds else ""
        async with self.pool.connection() as conn:
            cur = await conn.execute(
                "SELECT id, actor_type, actor_id, action, target, at FROM audit_log "  # pyrefly: ignore[bad-argument-type]
                f"WHERE workspace_id = %(ws)s {where} ORDER BY at DESC, id DESC LIMIT %(limit)s",
                {"ws": self.workspace_id, "kinds": kinds, "limit": min(max(limit, 1), 1000)},
            )
            rows = await cur.fetchall()
        return [
            {
                "id": str(eid),
                "actorType": actor_type,
                "actorId": str(actor) if actor else None,
                "action": action,
                "target": target,
                "at": iso(at),
            }
            for eid, actor_type, actor, action, target, at in rows
        ]
