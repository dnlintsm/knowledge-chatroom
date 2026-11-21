"""The workspace inventory, for whoever runs the deployment (issue #255, step 4).

docs/workspaces.md, "Workspace inventory". PLATFORM_ADMINS names the deployment
admins (emails or login subjects, as WORKSPACE_CREATORS and HUB_ADMINS do); in
local mode the local user is one. Nobody is one by default, and being one gives
nothing else: no membership, no content, no audit log.

    GET  /platform/workspaces               -> {workspaces: [PlatformWorkspace]}
    GET  /platform/users?email=             -> {user: {id, name, email}}: who to add
    POST /platform/workspaces/<id>/owners   {userId, fullAccess?} -> {workspace: PlatformWorkspace}

The list has no content: no node names, files, Experiments, chats, or members
beyond the Owners. Adding an Owner is for a workspace whose Owners can no
longer sign in. It takes the workspace's lock, as role changes do, and with
`fullAccess` also gives that Owner, and only them, Full access on the root.
Both are audited in that workspace's log, with the deployment admin as the
actor. Storage tokens can't use these routes.
"""

from __future__ import annotations

import logging
import re
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, Response
from psycopg import AsyncConnection
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from psycopg_pool import AsyncConnectionPool

from .access import Principal, is_uuid, iso
from .identity import identify
from .workspaces import SHARED_EMAIL, SharedEmail

logger = logging.getLogger("api_py")
router = APIRouter()

_ALL_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"]
NOT_ADMIN = "Only the deployment's admins (PLATFORM_ADMINS) see the workspace inventory"
NOT_FOUND = "Workspace not found"
UNKNOWN_USER = "Unknown user: they need to sign in once first"
NOBODY = "Nobody with that email has signed in yet"
NOT_YOURSELF = (
    "Deployment admins can't make themselves Owners: ask another admin, or add someone else"
)
DEFAULT_RECOVERY_IDLE_DAYS = 90

# One row per workspace: no content, and no member beyond the Owners.
_INVENTORY = """
SELECT w.id, w.slug, w.name, w.status, w.created_at,
  c.id AS creator_id, c.name AS creator_name,
  (SELECT count(*)::int FROM workspace_members m WHERE m.workspace_id = w.id) AS members,
  COALESCE((
    SELECT jsonb_agg(jsonb_build_object('id', u.id, 'name', u.name, 'email', u.email,
                                        'lastSeenAt', to_char(u.last_seen_at AT TIME ZONE 'UTC',
                                                              'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
                     ORDER BY lower(u.name), u.id)
    FROM workspace_members m JOIN users u ON u.id = m.user_id
    WHERE m.workspace_id = w.id AND m.role = 'owner'), '[]'::jsonb) AS owners,
  GREATEST(
    (SELECT max(at) FROM audit_log a WHERE a.workspace_id = w.id),
    (SELECT max(last_run_at) FROM chats ch WHERE ch.workspace_id = w.id),
    (SELECT max(updated_at) FROM files f WHERE f.workspace_id = w.id),
    (SELECT max(updated_at) FROM experiments e WHERE e.workspace_id = w.id)) AS last_active_at,
  EXISTS (
    SELECT 1 FROM workspace_members m JOIN users u ON u.id = m.user_id
    WHERE m.workspace_id = w.id AND u.subject <> 'local'
      AND u.last_seen_at > now() - make_interval(days => %(idle)s)
      AND effective_role(w.id, m.user_id, NULL) = 'owner') AS full_access_active
FROM workspaces w LEFT JOIN users c ON c.id = w.created_by
"""


class PlatformError(Exception):
    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status


def parse_admins(value: str | None) -> frozenset[str]:
    """PLATFORM_ADMINS: emails or login subjects, by commas or spaces."""
    return frozenset(v.lower() for v in re.split(r"[\s,]+", value or "") if v)


def _entry(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": str(row["id"]),
        "slug": row["slug"],
        "name": row["name"],
        "status": row["status"],
        "createdAt": iso(row["created_at"]),
        "createdBy": (
            {"id": str(row["creator_id"]), "name": row["creator_name"]}
            if row["creator_id"]
            else None
        ),
        "memberCount": row["members"],
        "owners": [
            {
                "id": str(o["id"]),
                "name": o["name"],
                "email": o["email"],
                "lastSeenAt": o["lastSeenAt"],
            }
            for o in row["owners"]
        ],
        "lastActiveAt": iso(row["last_active_at"]),
        # Whether a member who signed in within RECOVERY_IDLE_DAYS holds Full
        # access on the root; the screen preselects fullAccess when none does.
        "fullAccessHeld": row["full_access_active"],
    }


class Platform:
    """The inventory and Owner recovery, over the whole database."""

    def __init__(
        self,
        pool: AsyncConnectionPool,
        admins: frozenset[str],
        idle_days: int = DEFAULT_RECOVERY_IDLE_DAYS,
    ) -> None:
        self.pool = pool
        self.admins = admins
        self.idle_days = idle_days

    async def is_admin(self, user_id: str) -> bool:
        """Named in PLATFORM_ADMINS (email or login subject), or the local user."""
        async with self.pool.connection() as conn:
            cur = await conn.execute("SELECT subject, email FROM users WHERE id = %s", (user_id,))
            row = await cur.fetchone()
        if row is None:
            return False
        subject, email = row
        return (
            subject == "local"
            or subject.lower() in self.admins
            or bool(email and email.lower() in self.admins)
        )

    async def workspaces(self, only: str | None = None) -> list[dict[str, Any]]:
        """Every workspace, active and archived, newest first (or just `only`)."""
        where = "WHERE w.id = %(only)s" if only else ""
        async with self.pool.connection() as conn:
            cur = conn.cursor(row_factory=dict_row)
            await cur.execute(
                _INVENTORY + where + " ORDER BY w.created_at DESC, w.id",  # pyrefly: ignore[bad-argument-type]
                {"idle": self.idle_days, "only": only},
            )
            rows = await cur.fetchall()
        return [_entry(row) for row in rows]

    async def lookup(self, email: str) -> dict[str, Any] | None:
        """Someone who has signed in with exactly this email (case ignored), to make an Owner."""
        address = email.strip()
        if not address or "@" not in address:
            return None
        async with self.pool.connection() as conn:
            cur = await conn.execute(
                """
                SELECT id, name, email FROM users
                WHERE lower(email) = lower(%s) AND subject <> 'local'
                LIMIT 2""",
                (address,),
            )
            rows = await cur.fetchall()
        if len(rows) > 1:
            # Never the most recent of several: an Owner must not go to the wrong account.
            raise SharedEmail(SHARED_EMAIL)
        if not rows:
            return None
        return {"id": str(rows[0][0]), "name": rows[0][1], "email": rows[0][2]}

    async def add_owner(
        self, workspace_id: str, admin: str, user_id: str, full_access: bool
    ) -> dict[str, Any]:
        """
        Makes `user_id` an Owner of the workspace, adding them as a member if
        they aren't one, and with `full_access` gives them Full access on its
        root, in one transaction under the workspace's lock. The workspace's
        entry after.
        """
        if not is_uuid(workspace_id):
            raise PlatformError(404, NOT_FOUND)
        if not is_uuid(user_id):
            raise PlatformError(400, UNKNOWN_USER)
        if user_id == admin:
            raise PlatformError(400, NOT_YOURSELF)
        async with self.pool.connection() as conn, conn.transaction():
            # The lock role changes and removals take (workspaces.py, _lock).
            cur = await conn.execute(
                "SELECT 1 FROM workspaces WHERE id = %s FOR UPDATE", (workspace_id,)
            )
            if not await cur.fetchone():
                raise PlatformError(404, NOT_FOUND)
            cur = await conn.execute(
                "SELECT 1 FROM users WHERE id = %s AND subject <> 'local'", (user_id,)
            )
            if not await cur.fetchone():
                raise PlatformError(400, UNKNOWN_USER)
            cur = await conn.execute(
                "SELECT role FROM workspace_members WHERE workspace_id = %s AND user_id = %s",
                (workspace_id, user_id),
            )
            row = await cur.fetchone()
            previous = row[0] if row else None
            if previous is None:
                await conn.execute(
                    """
                    INSERT INTO workspace_members (workspace_id, user_id, role, created_by)
                    VALUES (%s, %s, 'owner', %s)""",
                    (workspace_id, user_id, admin),
                )
                # As when an Owner adds them: signing in may add them to the
                # default workspace again (024_workspace_departures.sql).
                await conn.execute(
                    "DELETE FROM workspace_departures WHERE workspace_id = %s AND user_id = %s",
                    (workspace_id, user_id),
                )
            elif previous != "owner":
                await conn.execute(
                    "UPDATE workspace_members SET role = 'owner' WHERE workspace_id = %s AND user_id = %s",
                    (workspace_id, user_id),
                )
            if previous != "owner":
                await _audit(
                    conn,
                    workspace_id,
                    admin,
                    "platform.owner",
                    {"user": user_id, "previous": previous},
                )
            if full_access and await _full_access(conn, workspace_id, user_id, admin):
                await _audit(
                    conn,
                    workspace_id,
                    admin,
                    "grant.set",
                    {
                        "node": None,
                        "principalType": "user",
                        "principalId": user_id,
                        "role": "owner",
                        "recovery": True,
                    },
                )
        (entry,) = await self.workspaces(workspace_id)
        return entry


async def _full_access(conn: AsyncConnection, workspace_id: str, user_id: str, by: str) -> bool:
    """Their direct grant on the root becomes Full access; whether that changed anything."""
    cur = await conn.execute(
        """
        UPDATE grants SET role = 'owner'
        WHERE workspace_id = %s AND node_id IS NULL AND principal_type = 'user'
          AND principal_id = %s AND role <> 'owner'
        RETURNING id""",
        (workspace_id, user_id),
    )
    if await cur.fetchone():
        return True
    cur = await conn.execute(
        """
        INSERT INTO grants (workspace_id, node_id, principal_type, principal_id, role, created_by)
        VALUES (%s, NULL, 'user', %s, 'owner', %s)
        ON CONFLICT DO NOTHING
        RETURNING id""",
        (workspace_id, user_id, by),
    )
    return bool(await cur.fetchone())


async def _audit(
    conn: AsyncConnection, workspace_id: str, admin: str, action: str, target: dict[str, Any]
) -> None:
    await conn.execute(
        "INSERT INTO audit_log (workspace_id, actor_type, actor_id, action, target) VALUES (%s, 'user', %s, %s, %s)",
        (workspace_id, admin, action, Jsonb(target)),
    )


def _send(status: int, body: Any) -> JSONResponse:
    return JSONResponse(body, status_code=status, headers={"Cache-Control": "no-store"})


@router.api_route("/platform", methods=_ALL_METHODS, include_in_schema=False)
@router.api_route("/platform/{rest:path}", methods=_ALL_METHODS, include_in_schema=False)
async def platform_route(request: Request) -> Response:
    state = request.app.state
    if not await state.storage_ready():
        return _send(503, {"error": "Storage is starting"})
    platform: Platform = state.platform
    try:
        principal = await identify(
            request, state.storage.access, state.settings.auth_secret, storage_tokens=True
        )
        if principal is None:
            return _send(401, {"error": "Sign in to use the workspace"})
        if principal.via:
            return _send(403, {"error": "Claude doesn't manage workspaces"})
        if not await platform.is_admin(principal.user_id):
            return _send(403, {"error": NOT_ADMIN})
        return await _route(request, platform, principal)
    except PlatformError as err:
        return _send(err.status, {"error": str(err)})
    except Exception:
        logger.exception("[platform] request failed")
        return _send(500, {"error": "Storage error"})


async def _route(request: Request, platform: Platform, principal: Principal) -> Response:
    parts = [p for p in request.url.path.split("/")[2:] if p]
    method = request.method
    if parts == ["workspaces"]:
        if method != "GET":
            return _send(405, {"error": "Method not allowed"})
        return _send(200, {"workspaces": await platform.workspaces()})
    if parts == ["users"]:
        if method != "GET":
            return _send(405, {"error": "Method not allowed"})
        emails = request.query_params.getlist("email")
        try:
            person = await platform.lookup(emails[0]) if emails else None
        except SharedEmail as err:
            return _send(404, {"error": str(err)})
        if person is None:
            return _send(404, {"error": NOBODY})
        return _send(200, {"user": person})
    if len(parts) == 3 and parts[0] == "workspaces" and parts[2] == "owners":
        if method != "POST":
            return _send(405, {"error": "Method not allowed"})
        from .storage_routes import read_json

        body = await read_json(request)  # at most 64 KiB
        user_id = body.get("userId") if isinstance(body, dict) else None
        full_access = body.get("fullAccess", False) if isinstance(body, dict) else None
        if not isinstance(user_id, str) or not isinstance(full_access, bool):
            return _send(400, {"error": "Expected {userId: string, fullAccess?: boolean}"})
        entry = await platform.add_owner(
            parts[1].lower(), principal.user_id, user_id.lower(), full_access
        )
        return _send(200, {"workspace": entry})
    return _send(404, {"error": "Not found"})
