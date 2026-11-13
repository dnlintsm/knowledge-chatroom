"""Workspaces and their members (issue #226, docs/workspaces.md).

    GET    /workspaces                       {workspaces: [{id, slug, name, role}]}: yours
    POST   /workspaces                       {name, levels?} -> the new workspace (201),
                                             with you as its Owner
    GET    /workspaces/<id>                  {id, slug, name, role}: one of yours
    GET    /workspaces/<id>/members          {members: [{id, name, role, email?,
                                             createdAt?, lastSeenAt?}]}: names for
                                             everyone, the rest for Owners and Admins
    GET    /workspaces/<id>/lookup?email=    {user: {id, name}}: someone who has signed
                                             in, by exact email (Owners and Admins)
    POST   /workspaces/<id>/members          {userId, role: member | admin,
                                             access?: none | viewer | editor} -> 201,
                                             or 409 with their role when already a member

A workspace you aren't a member of answers 404, the same as one that doesn't
exist. Storage tokens can't use these routes: Claude doesn't manage workspaces.

Every other storage request runs in one workspace, which resolve() finds from
the X-Knowledge-Workspace header, the ?workspace= parameter (for EventSource
and plain links) and the `ws` claim of a storage or memory token. They must
agree; none at all means the default workspace, during the compatibility
period. Membership is checked on every request.
"""

from __future__ import annotations

import logging
import re
import unicodedata
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, Response
from psycopg import AsyncConnection, errors
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from psycopg_pool import AsyncConnectionPool

from . import tokens
from .access import LEGACY_TOKEN, Principal, is_uuid, iso
from .identity import identify, token_ws

logger = logging.getLogger("api_py")
router = APIRouter()

WS_HEADER = "x-knowledge-workspace"
WS_PARAM = "workspace"
MEMBER_ROLES = ("owner", "admin", "member")
# A new workspace's knowledge levels, unless the request names others.
DEFAULT_LEVELS = ("tech", "module", "loop", "process")
NOT_FOUND = "Workspace not found"
NO_SUCH_EMAIL = "No one with that email has signed in yet. They need to sign in once first."
_ALL_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]


class WorkspaceError(Exception):
    """A request's workspace can't be used: 400 (selectors disagree) or 404 (not yours, or no such workspace)."""

    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status


def slugify(name: str) -> str:
    """A slug for a workspace name: lower-case letters, digits and dashes, at most 48 characters."""
    ascii_name = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode()
    slug = re.sub(r"[^a-z0-9]+", "-", ascii_name.lower()).strip("-")[:48].strip("-")
    return slug or "workspace"


class Workspaces:
    """The workspaces and memberships in the database (023_workspace_members.sql)."""

    def __init__(self, pool: AsyncConnectionPool) -> None:
        self.pool = pool
        self._default: str | None = None

    async def default_id(self) -> str:
        if self._default is None:
            async with self.pool.connection() as conn:
                cur = await conn.execute("SELECT id FROM workspaces WHERE slug = 'default'")
                row = await cur.fetchone()
            if not row:
                raise RuntimeError("Workspace default not found")
            self._default = str(row[0])
        return self._default

    async def role(self, workspace_id: str, user_id: str) -> str | None:
        """The user's membership role in an active workspace, or None (also for a malformed id)."""
        if not is_uuid(workspace_id):
            return None
        async with self.pool.connection() as conn:
            cur = await conn.execute(
                """
                SELECT m.role FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id
                WHERE m.workspace_id = %s AND m.user_id = %s AND w.status = 'active'""",
                (workspace_id, user_id),
            )
            row = await cur.fetchone()
        return row[0] if row else None

    async def get(self, workspace_id: str, user_id: str) -> dict[str, Any] | None:
        """One workspace the user belongs to, with their role, or None."""
        if not is_uuid(workspace_id):
            return None
        found = await self._mine(user_id, workspace_id)
        return found[0] if found else None

    async def mine(self, user_id: str) -> list[dict[str, Any]]:
        """The workspaces the user belongs to, the default first, then by name."""
        return await self._mine(user_id, None)

    async def _mine(self, user_id: str, only: str | None) -> list[dict[str, Any]]:
        async with self.pool.connection() as conn:
            cur = conn.cursor(row_factory=dict_row)
            await cur.execute(
                """
                SELECT w.id, w.slug, w.name, m.role
                FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id
                WHERE m.user_id = %(user)s AND w.status = 'active'
                  AND (%(only)s::uuid IS NULL OR w.id = %(only)s::uuid)
                ORDER BY w.slug <> 'default', lower(w.name), w.created_at""",
                {"user": user_id, "only": only},
            )
            rows = await cur.fetchall()
        return [{**r, "id": str(r["id"])} for r in rows]

    async def create(self, user_id: str, name: str, levels: list[str]) -> dict[str, Any]:
        """
        A new workspace, with its creator as Owner and with Full access on its
        root, all in one transaction (decision 4), and its knowledge levels.
        """
        base = slugify(name)
        for attempt in range(1, 100):
            slug = base if attempt == 1 else f"{base[:44]}-{attempt}"
            try:
                async with self.pool.connection() as conn, conn.transaction():
                    cur = await conn.execute(
                        "INSERT INTO workspaces (slug, name, created_by) VALUES (%s, %s, %s) RETURNING id",
                        (slug, name, user_id),
                    )
                    (ws,) = await cur.fetchone()  # pyrefly: ignore[not-iterable]
                    ws = str(ws)
                    await conn.execute(
                        "INSERT INTO workspace_members (workspace_id, user_id, role, created_by) VALUES (%s, %s, 'owner', %s)",
                        (ws, user_id, user_id),
                    )
                    await conn.execute(
                        """
                        INSERT INTO grants (workspace_id, node_id, principal_type, principal_id, role, created_by)
                        VALUES (%s, NULL, 'user', %s, 'owner', %s)""",
                        (ws, user_id, user_id),
                    )
                    for depth, level in enumerate(levels, start=1):
                        await conn.execute(
                            "INSERT INTO node_types (workspace_id, name, depth) VALUES (%s, %s, %s)",
                            (ws, level, depth),
                        )
                    await _audit(
                        conn, ws, user_id, "workspace.create", {"name": name, "slug": slug}
                    )
                return {"id": ws, "slug": slug, "name": name, "role": "owner"}
            except errors.UniqueViolation as err:
                if "slug" not in str(err):
                    raise
        raise WorkspaceError(400, "Choose another name: too many workspaces have this one")

    async def members(
        self, workspace_id: str, private: bool, with_local: bool
    ) -> list[dict[str, Any]]:
        """The workspace's members; emails and times only when `private` (Owners and Admins)."""
        async with self.pool.connection() as conn:
            cur = conn.cursor(row_factory=dict_row)
            await cur.execute(
                """
                SELECT u.id, u.name, u.email, u.created_at, u.last_seen_at, m.role
                FROM workspace_members m JOIN users u ON u.id = m.user_id
                WHERE m.workspace_id = %s AND (%s OR u.subject <> 'local')
                ORDER BY lower(coalesce(u.name, u.email, '')), u.created_at""",
                (workspace_id, with_local),
            )
            rows = await cur.fetchall()
        members = []
        for r in rows:
            member = {"id": str(r["id"]), "name": r["name"], "role": r["role"]}
            if private:
                member |= {
                    "email": r["email"],
                    "createdAt": iso(r["created_at"]),
                    "lastSeenAt": iso(r["last_seen_at"]),
                }
            members.append(member)
        return members

    async def lookup(self, email: str) -> dict[str, Any] | None:
        """Someone who has signed in with exactly this email (case ignored): {id, name}, or None."""
        address = email.strip()
        if not address or "@" not in address:
            return None
        async with self.pool.connection() as conn:
            cur = await conn.execute(
                """
                SELECT id, name FROM users
                WHERE lower(email) = lower(%s) AND subject <> 'local'
                ORDER BY last_seen_at DESC NULLS LAST, created_at DESC
                LIMIT 1""",
                (address,),
            )
            row = await cur.fetchone()
        return {"id": str(row[0]), "name": row[1]} if row else None

    async def add_member(
        self, workspace_id: str, by: Principal, user_id: str, role: str, access: str | None
    ) -> tuple[bool, str]:
        """
        Adds a member, and their starting grant on the root, in one transaction:
        (True, role). An existing member changes nothing: (False, their role).
        The starting grant never replaces a grant they already have.
        """
        if not is_uuid(user_id):
            raise WorkspaceError(400, "Unknown user")
        async with self.pool.connection() as conn, conn.transaction():
            cur = await conn.execute(
                "SELECT 1 FROM users WHERE id = %s AND subject <> 'local'", (user_id,)
            )
            if not await cur.fetchone():
                raise WorkspaceError(400, "Unknown user")
            cur = await conn.execute(
                """
                INSERT INTO workspace_members (workspace_id, user_id, role, created_by)
                VALUES (%s, %s, %s, %s)
                ON CONFLICT DO NOTHING
                RETURNING role""",
                (workspace_id, user_id, role, by.user_id),
            )
            if not await cur.fetchone():
                cur = await conn.execute(
                    "SELECT role FROM workspace_members WHERE workspace_id = %s AND user_id = %s",
                    (workspace_id, user_id),
                )
                (current,) = await cur.fetchone()  # pyrefly: ignore[not-iterable]
                return False, current
            await _audit(
                conn, workspace_id, by.user_id, "member.add", {"user": user_id, "role": role}
            )
            if access:
                cur = await conn.execute(
                    """
                    INSERT INTO grants (workspace_id, node_id, principal_type, principal_id, role, created_by)
                    VALUES (%s, NULL, 'user', %s, %s, %s)
                    ON CONFLICT DO NOTHING
                    RETURNING id""",
                    (workspace_id, user_id, access, by.user_id),
                )
                if await cur.fetchone():
                    await _audit(
                        conn,
                        workspace_id,
                        by.user_id,
                        "grant.set",
                        {
                            "node": None,
                            "principalType": "user",
                            "principalId": user_id,
                            "role": access,
                        },
                    )
            return True, role


async def _audit(
    conn: AsyncConnection, workspace_id: str, user_id: str, action: str, target: dict[str, Any]
) -> None:
    await conn.execute(
        "INSERT INTO audit_log (workspace_id, actor_type, actor_id, action, target) VALUES (%s, 'user', %s, %s, %s)",
        (workspace_id, user_id, action, Jsonb(target)),
    )


def named_selectors(request: Request) -> list[str]:
    """The workspaces the header and the query parameter name (as sent, lower-cased)."""
    named = [request.headers.get(WS_HEADER)]
    params = request.query_params.getlist(WS_PARAM)
    named.append(params[0] if params else None)
    return [value.strip().lower() for value in named if value is not None]


async def resolve(
    request: Request, workspaces: Workspaces, user_id: str, bound: str | None
) -> tuple[str, str]:
    """
    The workspace this request runs in and the user's role there (docs/workspaces.md,
    "How a request finds its workspace"), membership checked: the header, the
    query parameter and a token's `ws` claim (`bound`; LEGACY_TOKEN for a token
    without one) must agree, and none of them means the default workspace.
    """
    chosen = set(named_selectors(request))
    if bound is not None:
        chosen.add(await workspaces.default_id() if bound == LEGACY_TOKEN else bound.lower())
    if len(chosen) > 1:
        raise WorkspaceError(400, "The request names more than one workspace")
    ws = chosen.pop() if chosen else await workspaces.default_id()
    role = await workspaces.role(ws, user_id)
    if role is None:
        raise WorkspaceError(404, NOT_FOUND)
    return ws, role


async def typescript_refusal(request: Request) -> Response | None:
    """
    Why a request that goes on to the TypeScript server is refused, or None.
    That server serves the default workspace only until it takes the workspace
    from the run (#226, step 4b), so a request that names another workspace,
    by selector or token, is refused here rather than served in the wrong one.
    """
    state = request.app.state
    workspaces: Workspaces | None = getattr(state, "workspaces", None)
    if workspaces is None:
        return None
    named = set(named_selectors(request))
    secret = state.settings.auth_secret
    for header, audience in (
        (tokens.STORAGE_HEADER, tokens.STORAGE_AUDIENCE),
        (tokens.MEMORY_HEADER, tokens.MEMORY_AUDIENCE),
    ):
        token = request.headers.get(header)
        claims = tokens.verify(token, secret, audience) if token and secret else None
        if claims:
            bound = token_ws(claims)
            named.add(LEGACY_TOKEN if bound == LEGACY_TOKEN else bound.lower())
    if not named:
        return None
    try:
        default = await workspaces.default_id()
    except Exception:  # No database yet: nothing but the default workspace exists.
        return None
    named = {default if ws == LEGACY_TOKEN else ws for ws in named}
    if len(named) > 1:
        return JSONResponse({"error": "The request names more than one workspace"}, status_code=400)
    if named != {default}:
        return JSONResponse(
            {"error": "This can only be used in the default workspace for now"}, status_code=400
        )
    return None


def _send(status: int, body: Any) -> JSONResponse:
    return JSONResponse(body, status_code=status, headers={"Cache-Control": "no-store"})


async def _read_json(request: Request) -> dict[str, Any] | None:
    try:
        body = await request.json()
    except ValueError:
        return None
    return body if isinstance(body, dict) else None


@router.api_route("/workspaces", methods=_ALL_METHODS, include_in_schema=False)
@router.api_route("/workspaces/{rest:path}", methods=_ALL_METHODS, include_in_schema=False)
async def workspaces_route(request: Request) -> Response:
    from .proxy import forward

    state = request.app.state
    if not await state.storage_ready():
        return await forward(request, state.http)
    storage = state.storage
    workspaces: Workspaces = state.workspaces
    try:
        principal = await identify(
            request, storage.access, state.settings.auth_secret, storage_tokens=True
        )
        if principal is None:
            return _send(401, {"error": "Sign in to use the workspace"})
        if principal.via:
            return _send(403, {"error": "Claude doesn't manage workspaces"})
        return await _route(request, workspaces, principal)
    except WorkspaceError as err:
        return _send(err.status, {"error": str(err)})
    except Exception:
        logger.exception("[workspaces] request failed")
        return _send(500, {"error": "Storage error"})


async def _route(request: Request, workspaces: Workspaces, principal: Principal) -> Response:
    parts = [p for p in request.url.path.split("/")[2:] if p]
    method = request.method
    user = principal.user_id

    if not parts:
        if method == "GET":
            return _send(200, {"workspaces": await workspaces.mine(user)})
        if method == "POST":
            body = await _read_json(request)
            name = (
                re.sub(r"\s+", " ", body["name"]).strip()
                if body and isinstance(body.get("name"), str)
                else ""
            )
            levels = body.get("levels", list(DEFAULT_LEVELS)) if body else None
            if (
                not name
                or len(name) > 200
                or not isinstance(levels, list)
                or len(levels) > 10
                or not all(isinstance(level, str) and level.strip() for level in levels)
            ):
                return _send(
                    400,
                    {
                        "error": "Expected {name: string (at most 200 characters), levels?: string[]}"
                    },
                )
            created = await workspaces.create(user, name, [level.strip() for level in levels])
            return _send(201, created)
        return _send(405, {"error": "Method not allowed"})

    ws, *rest = parts
    found = await workspaces.get(ws, user)
    if found is None:
        raise WorkspaceError(404, NOT_FOUND)
    manages = found["role"] in ("owner", "admin")
    section = rest[0] if rest else ""
    if len(rest) > 1:
        return _send(404, {"error": "Not found"})

    if not section and method == "GET":
        return _send(200, found)
    if section == "members" and method == "GET":
        local = await request.app.state.storage.access.local_user_id()
        return _send(
            200, {"members": await workspaces.members(found["id"], manages, user == local)}
        )
    if section in ("members", "lookup") and not manages:
        return _send(403, {"error": "Only the workspace's Owners and Admins can add people"})
    if section == "lookup" and method == "GET":
        params = request.query_params.getlist("email")
        person = await workspaces.lookup(params[0]) if params else None
        return _send(200, {"user": person}) if person else _send(404, {"error": NO_SUCH_EMAIL})
    if section == "members" and method == "POST":
        body = await _read_json(request)
        access = body.get("access", "viewer") if body else None
        if (
            not body
            or not isinstance(body.get("userId"), str)
            or body.get("role") not in ("member", "admin")
            or access not in ("none", "viewer", "editor")
        ):
            return _send(
                400,
                {
                    "error": 'Expected {userId, role: "member" | "admin", access?: "none" | "viewer" | "editor"}'
                },
            )
        added, role = await workspaces.add_member(
            found["id"],
            principal,
            body["userId"],
            body["role"],
            None if access == "none" else access,
        )
        if not added:
            return _send(409, {"error": "Already a member of this workspace", "role": role})
        return _send(201, {"member": {"id": body["userId"], "role": role}})
    return _send(404, {"error": "Not found"})
