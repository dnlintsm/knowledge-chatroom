"""Workspaces and their members (docs/workspaces.md).

    GET    /workspaces[?archived=true]       {workspaces: [{id, slug, name, role, status}],
                                             canCreate}: yours, and whether you may
                                             create one; with archived=true also the
                                             archived ones you own
    POST   /workspaces                       {name, slug?, levels?} -> the new workspace
                                             (201), with you as its Owner; 409 when
                                             the slug asked for is taken, 403 when
                                             WORKSPACE_CREATORS doesn't name you
    GET    /workspaces/<id>                  {id, slug, name, role, status}: one of
                                             yours (an archived one only for its Owners)
    PATCH  /workspaces/<id>                  {name?, status?: active | archived}: rename
                                             (Owners and Admins), archive or restore
                                             (Owners; never the default workspace)
    GET    /workspaces/<id>/members          {members: [{id, name, role, email?,
                                             createdAt?, lastSeenAt?}]}: names for
                                             everyone, the rest for Owners and Admins
    GET    /workspaces/<id>/lookup?email=    {user: {id, name}}: someone who has signed
                                             in, by exact email (Owners and Admins)
    POST   /workspaces/<id>/members          {userId, role: member | admin,
                                             access?: none | viewer | editor} -> 201,
                                             or 409 with their role when already a member
    PATCH  /workspaces/<id>/members/<user>   {role} -> {member: {id, role}}: Owners set
                                             any role; Admins make a Member Admin, or
                                             step down themselves; 409 for the last Owner
    DELETE /workspaces/<id>/members/<user>   -> {removed: {grants, groups, collaborations}}: remove
                                             someone (Owners anyone, Admins Members), or
                                             leave (your own id); 409 for the last Owner
    GET    /workspaces/<id>/members/<user>/removal
                                             {grants, groups: [{id, name}], collaborations,
                                             experiments: [{id, title, nodeId}]}: what removing them
                                             takes away, and the shared Experiments
                                             they maintain that you can see

A workspace you aren't a member of answers 404, the same as one that doesn't
exist. Storage tokens can't use these routes: Claude doesn't manage workspaces.

Every other storage request runs in one workspace, which resolve() finds from
the X-Knowledge-Workspace header, the ?workspace= parameter (for EventSource
and plain links) and the `ws` claim of a storage or memory token. They must
agree; none at all means the default workspace, during the compatibility
period. Membership is checked on every request.
"""

from __future__ import annotations

import json
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

from .access import LEGACY_TOKEN, Principal, is_uuid, iso
from .identity import identify
from .storage import EVENTS_CHANNEL
from .unserved import not_served

logger = logging.getLogger("api_py")
router = APIRouter()

WS_HEADER = "x-knowledge-workspace"
WS_PARAM = "workspace"
MEMBER_ROLES = ("owner", "admin", "member")
# A new workspace's knowledge levels, unless the request names others.
DEFAULT_LEVELS = ("tech", "module", "loop", "process")
NOT_FOUND = "Workspace not found"
CANNOT_CREATE = "Creating workspaces is limited on this server. Ask its administrator, or an Owner or Admin to add you to theirs."
SLUG_TAKEN = "Another workspace already has this address"
# A slug asked for: what slugify() makes, lower-case letters and digits in dash-separated runs.
SLUG = re.compile(r"[a-z0-9]+(?:-[a-z0-9]+)*")
SLUG_MAX = 48
NO_SUCH_EMAIL = "No one with that email has signed in yet. They need to sign in once first."
SHARED_EMAIL = (
    "More than one account has signed in with that email, so it doesn't say who you mean. "
    "Ask your login provider's administrator which account is theirs."
)


class SharedEmail(LookupError):
    """An email lookup matched more than one account."""


LAST_OWNER = "A workspace needs at least one owner. Make someone else an Owner first."
NOT_A_MEMBER = "Not a member of this workspace"
_ALL_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]


class WorkspaceError(Exception):
    """
    A request's workspace can't be used: 400 (selectors disagree) or 404 (not
    yours, or no such workspace); or one can't be created (400, 409).
    """

    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status


def _is_slug(value: object) -> bool:
    """Whether `value` is a slug someone may ask for (SLUG, at most SLUG_MAX characters)."""
    return isinstance(value, str) and len(value) <= SLUG_MAX and SLUG.fullmatch(value) is not None


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

    async def get(
        self, workspace_id: str, user_id: str, archived: bool = False
    ) -> dict[str, Any] | None:
        """
        One workspace the user belongs to, with their role, or None. With
        `archived`, also an archived one, but only for its Owners.
        """
        if not is_uuid(workspace_id):
            return None
        found = await self._mine(user_id, workspace_id, archived)
        return found[0] if found else None

    async def mine(self, user_id: str, archived: bool = False) -> list[dict[str, Any]]:
        """
        The workspaces the user belongs to, the default first, then by name;
        with `archived`, also the archived ones they own.
        """
        return await self._mine(user_id, None, archived)

    async def _mine(self, user_id: str, only: str | None, archived: bool) -> list[dict[str, Any]]:
        async with self.pool.connection() as conn:
            cur = conn.cursor(row_factory=dict_row)
            await cur.execute(
                """
                SELECT w.id, w.slug, w.name, m.role, w.status
                FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id
                WHERE m.user_id = %(user)s
                  AND (w.status = 'active' OR (%(archived)s AND m.role = 'owner'))
                  AND (%(only)s::uuid IS NULL OR w.id = %(only)s::uuid)
                ORDER BY w.status <> 'active', w.slug <> 'default', lower(w.name), w.created_at""",
                {"user": user_id, "only": only, "archived": archived},
            )
            rows = await cur.fetchall()
        return [{**r, "id": str(r["id"])} for r in rows]

    async def update(
        self, workspace: dict[str, Any], by: str, name: str | None, status: str | None
    ) -> dict[str, Any]:
        """
        Renames, archives or restores a workspace the caller may change (the
        route checks who may), with an audit entry for each change.
        """
        ws = workspace["id"]
        async with self.pool.connection() as conn, conn.transaction():
            if name is not None and name != workspace["name"]:
                await conn.execute("UPDATE workspaces SET name = %s WHERE id = %s", (name, ws))
                await _audit(
                    conn, ws, by, "workspace.rename", {"name": name, "previous": workspace["name"]}
                )
            if status is not None and status != workspace["status"]:
                await conn.execute("UPDATE workspaces SET status = %s WHERE id = %s", (status, ws))
                action = "workspace.archive" if status == "archived" else "workspace.restore"
                await _audit(conn, ws, by, action, {"slug": workspace["slug"]})
                # Wakes the workspace's open streams, which then close (Session.still_member).
                await conn.execute(
                    "SELECT pg_notify(%s, %s)",
                    (
                        EVENTS_CHANNEL,
                        json.dumps({"op": "workspace", "change": status, "workspaceId": ws}),
                    ),
                )
        return {
            **workspace,
            **({"name": name} if name is not None else {}),
            **({"status": status} if status is not None else {}),
        }

    @staticmethod
    async def _lock(conn: AsyncConnection, workspace_id: str) -> None:
        """
        Serializes membership changes in one workspace, so two Owners demoting
        or removing each other at once can't leave it with none: the
        keep-owner trigger only sees committed rows.
        """
        await conn.execute("SELECT 1 FROM workspaces WHERE id = %s FOR UPDATE", (workspace_id,))

    @staticmethod
    async def _member_role(
        conn: AsyncConnection, workspace_id: str, user_id: str, lock: bool = False
    ) -> str | None:
        """
        Their role, or None. With `lock`, holds the membership row first, so
        grant and group writes for them (access.py, _need_member) finish
        before a removal deletes what they hold, or find them gone.
        """
        if not is_uuid(user_id):
            return None
        query = (
            "SELECT role FROM workspace_members WHERE workspace_id = %s AND user_id = %s FOR UPDATE"
            if lock
            else "SELECT role FROM workspace_members WHERE workspace_id = %s AND user_id = %s"
        )
        cur = await conn.execute(query, (workspace_id, user_id))
        row = await cur.fetchone()
        return row[0] if row else None

    @staticmethod
    async def _another_owner(conn: AsyncConnection, workspace_id: str, user_id: str) -> bool:
        """
        Whether the workspace keeps an Owner without `user_id`, as the
        keep-owner trigger asks (024_workspace_departures.sql): the built-in
        local user counts only for itself, since nobody signs in as it.
        """
        cur = await conn.execute(
            "SELECT workspace_keeps_owner(%s, %s)",
            (workspace_id, user_id),
        )
        (keeps,) = await cur.fetchone()  # pyrefly: ignore[not-iterable]
        return keeps

    async def _role_now(self, conn: AsyncConnection, workspace_id: str, by: str) -> str:
        """
        The caller's own role, read under the workspace's lock. The route read
        it before the lock to decide whether to ask at all, and an Owner or
        Admin demoted or removed in between must not get one more change
        through. Gone from the workspace: it isn't theirs to see.
        """
        role = await self._member_role(conn, workspace_id, by)
        if role is None:
            raise WorkspaceError(404, NOT_FOUND)
        return role

    async def change_role(
        self, workspace_id: str, by: str, by_role: str, user_id: str, role: str
    ) -> str:
        """
        Gives a member another role (docs/workspaces.md, "Changing a role"):
        Owners any role to anyone, Admins a Member to Admin and themselves to
        Member. Never the last Owner's. Changes no grant. Returns the new role.
        """
        async with self.pool.connection() as conn, conn.transaction():
            await self._lock(conn, workspace_id)
            by_role = await self._role_now(conn, workspace_id, by)
            current = await self._member_role(conn, workspace_id, user_id)
            if current is None:
                raise WorkspaceError(404, NOT_A_MEMBER)
            if current == role:
                return role
            if by_role != "owner" and not (
                (current == "member" and role == "admin")
                or (user_id == by and current == "admin" and role == "member")
            ):
                raise WorkspaceError(
                    403,
                    "Admins can make a Member an Admin, or step down themselves; Owners change other roles",
                )
            if current == "owner" and not await self._another_owner(conn, workspace_id, user_id):
                raise WorkspaceError(409, LAST_OWNER)
            await conn.execute(
                "UPDATE workspace_members SET role = %s WHERE workspace_id = %s AND user_id = %s",
                (role, workspace_id, user_id),
            )
            await _audit(
                conn,
                workspace_id,
                by,
                "member.role",
                {"user": user_id, "role": role, "previous": current},
            )
        return role

    async def remove_member(
        self, workspace_id: str, by: str, by_role: str, user_id: str
    ) -> dict[str, int]:
        """
        Removes a member, or lets one leave (`user_id` == `by`), in one
        transaction (docs/workspaces.md, "Removing a member, or leaving"): the
        membership, their direct grants and their memberships of the
        workspace's groups go, and a departure keeps the default workspace from
        adding them back at sign-in. Their own data stays. Never the last Owner.
        """
        leaving = user_id == by
        async with self.pool.connection() as conn, conn.transaction():
            await self._lock(conn, workspace_id)
            by_role = await self._role_now(conn, workspace_id, by)
            current = await self._member_role(conn, workspace_id, user_id, lock=True)
            if current is None:
                raise WorkspaceError(404, NOT_A_MEMBER)
            if (
                not leaving
                and by_role != "owner"
                and not (by_role == "admin" and current == "member")
            ):
                raise WorkspaceError(403, "Admins can remove Members only")
            if current == "owner" and not await self._another_owner(conn, workspace_id, user_id):
                raise WorkspaceError(409, LAST_OWNER)
            cur = await conn.execute(
                """
                DELETE FROM grants
                WHERE workspace_id = %s AND principal_type = 'user' AND principal_id = %s""",
                (workspace_id, user_id),
            )
            grants = cur.rowcount
            cur = await conn.execute(
                """
                DELETE FROM group_members gm USING groups g
                WHERE g.id = gm.group_id AND g.workspace_id = %s AND gm.user_id = %s""",
                (workspace_id, user_id),
            )
            groups = cur.rowcount
            # Collaborator places are access someone gave them, like grants.
            cur = await conn.execute(
                """
                DELETE FROM experiment_collaborators c USING experiments e
                WHERE e.id = c.experiment_id AND e.workspace_id = %s AND c.user_id = %s""",
                (workspace_id, user_id),
            )
            collaborations = cur.rowcount
            await conn.execute(
                "DELETE FROM workspace_members WHERE workspace_id = %s AND user_id = %s",
                (workspace_id, user_id),
            )
            await conn.execute(
                """
                INSERT INTO workspace_departures (workspace_id, user_id, removed_by)
                VALUES (%s, %s, %s)
                ON CONFLICT (workspace_id, user_id)
                DO UPDATE SET departed_at = now(), removed_by = EXCLUDED.removed_by""",
                (workspace_id, user_id, by),
            )
            await _audit(
                conn,
                workspace_id,
                by,
                "member.leave" if leaving else "member.remove",
                {
                    "user": user_id,
                    "role": current,
                    "grants": grants,
                    "groups": groups,
                    "collaborations": collaborations,
                },
            )
        return {"grants": grants, "groups": groups, "collaborations": collaborations}

    async def removal(self, workspace_id: str, viewer: str, user_id: str) -> dict[str, Any]:
        """
        What removing a member takes away, for the confirmation: how many direct
        grants, which of the workspace's groups, and the shared or archived
        Experiments they maintain that `viewer` can see, and how many
        Experiments they collaborate on. Never drafts.
        """
        async with self.pool.connection() as conn:
            if await self._member_role(conn, workspace_id, user_id) is None:
                raise WorkspaceError(404, NOT_A_MEMBER)
            cur = await conn.execute(
                """
                SELECT count(*) FROM grants
                WHERE workspace_id = %s AND principal_type = 'user' AND principal_id = %s""",
                (workspace_id, user_id),
            )
            (grants,) = await cur.fetchone()  # pyrefly: ignore[not-iterable]
            cur = await conn.execute(
                """
                SELECT count(*) FROM experiment_collaborators c JOIN experiments e ON e.id = c.experiment_id
                WHERE e.workspace_id = %s AND c.user_id = %s AND e.deleted_at IS NULL""",
                (workspace_id, user_id),
            )
            (collaborations,) = await cur.fetchone()  # pyrefly: ignore[not-iterable]
            cur = conn.cursor(row_factory=dict_row)
            await cur.execute(
                """
                SELECT g.id, g.name FROM groups g JOIN group_members gm ON gm.group_id = g.id
                WHERE g.workspace_id = %s AND gm.user_id = %s
                ORDER BY lower(g.name)""",
                (workspace_id, user_id),
            )
            groups = [{"id": str(r["id"]), "name": r["name"]} for r in await cur.fetchall()]
            await cur.execute(
                """
                SELECT e.id, e.title, e.node_id FROM experiments e
                WHERE e.workspace_id = %(ws)s AND e.maintainer_id = %(user)s
                  AND e.status <> 'draft' AND e.deleted_at IS NULL
                  AND experiment_access(%(viewer)s, e.id) IS NOT NULL
                ORDER BY e.created_at DESC""",
                {"ws": workspace_id, "user": user_id, "viewer": viewer},
            )
            experiments = [
                {
                    "id": str(r["id"]),
                    "title": r["title"],
                    "nodeId": str(r["node_id"]) if r["node_id"] else None,
                }
                for r in await cur.fetchall()
            ]
        return {
            "grants": grants,
            "groups": groups,
            "collaborations": collaborations,
            "experiments": experiments,
        }

    async def create(
        self, user_id: str, name: str, levels: list[str], asked: str | None = None
    ) -> dict[str, Any]:
        """
        A new workspace, with its creator as Owner and with Full access on its
        root, all in one transaction (decision 4), and its knowledge levels.
        Its slug is `asked` (409 when taken), or one made from the name, with a
        number added when that is taken.
        """
        base = asked or slugify(name)
        for attempt in range(1, 2 if asked else 100):
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
                return {"id": ws, "slug": slug, "name": name, "role": "owner", "status": "active"}
            except errors.UniqueViolation as err:
                if "slug" not in str(err):
                    raise
                if asked:
                    raise WorkspaceError(409, SLUG_TAKEN) from err
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

    async def may_create(self, user_id: str, creators: frozenset[str] | None) -> bool:
        """
        Whether the user may create a workspace (decision 4): anyone signed in
        unless WORKSPACE_CREATORS names who may (their email or login
        subject); the local user always may (decision 3).
        """
        if creators is None:
            return True
        async with self.pool.connection() as conn:
            cur = await conn.execute("SELECT subject, email FROM users WHERE id = %s", (user_id,))
            row = await cur.fetchone()
        if row is None:
            return False
        subject, email = row
        return (
            subject == "local"
            or subject.lower() in creators
            or bool(email and email.lower() in creators)
        )

    async def lookup(self, email: str) -> dict[str, Any] | None:
        """
        Someone who has signed in with exactly this email (case ignored): {id, name}, or None.
        Raises SharedEmail when more than one account has it: an email names
        one person only if the login provider keeps it unique.
        """
        address = email.strip()
        if not address or "@" not in address:
            return None
        async with self.pool.connection() as conn:
            cur = await conn.execute(
                """
                SELECT id, name FROM users
                WHERE lower(email) = lower(%s) AND subject <> 'local'
                LIMIT 2""",
                (address,),
            )
            rows = await cur.fetchall()
        if len(rows) > 1:
            raise SharedEmail(SHARED_EMAIL)
        return {"id": str(rows[0][0]), "name": rows[0][1]} if rows else None

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
            # Added again after leaving or being removed: signing in may add them
            # to the default workspace again (024_workspace_departures.sql).
            await conn.execute(
                "DELETE FROM workspace_departures WHERE workspace_id = %s AND user_id = %s",
                (workspace_id, user_id),
            )
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


def _creators(value: str | None) -> frozenset[str] | None:
    """WORKSPACE_CREATORS: emails or login subjects, by commas or spaces; None when unset or empty."""
    names = frozenset(v.lower() for v in re.split(r"[\s,]+", value or "") if v)
    return names or None


def _send(status: int, body: Any) -> JSONResponse:
    return JSONResponse(body, status_code=status, headers={"Cache-Control": "no-store"})


async def _read_json(request: Request) -> dict[str, Any] | None:
    """The JSON object in the body, at most 64 KiB (storage_routes.read_json), or None."""
    from .storage_routes import read_json

    return await read_json(request)


@router.api_route("/workspaces", methods=_ALL_METHODS, include_in_schema=False)
@router.api_route("/workspaces/{rest:path}", methods=_ALL_METHODS, include_in_schema=False)
async def workspaces_route(request: Request) -> Response:
    state = request.app.state
    if not await state.storage_ready():
        return not_served(request)
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
        creators = _creators(request.app.state.settings.workspace_creators)
        if method == "GET":
            archived = request.query_params.get("archived") == "true"
            return _send(
                200,
                {
                    "workspaces": await workspaces.mine(user, archived),
                    "canCreate": await workspaces.may_create(user, creators),
                },
            )
        if method == "POST":
            if not await workspaces.may_create(user, creators):
                return _send(403, {"error": CANNOT_CREATE})
            body = await _read_json(request)
            name = _name(body.get("name")) if body else ""
            levels = body.get("levels", list(DEFAULT_LEVELS)) if body else None
            slug = body.get("slug") if body else None
            if (
                not name
                or len(name) > 200
                or (slug is not None and not _is_slug(slug))
                or not isinstance(levels, list)
                or len(levels) > 10
                or not all(isinstance(level, str) and level.strip() for level in levels)
            ):
                return _send(
                    400,
                    {
                        "error": "Expected {name: string (at most 200 characters), slug?: string "
                        "(lower-case letters, digits and dashes, at most 48), levels?: string[]}"
                    },
                )
            created = await workspaces.create(user, name, [level.strip() for level in levels], slug)
            return _send(201, created)
        return _send(405, {"error": "Method not allowed"})

    ws, *rest = parts
    if not rest:
        # An archived workspace is still there for its Owners, to restore it.
        found = await workspaces.get(ws, user, archived=True)
        if found is None:
            raise WorkspaceError(404, NOT_FOUND)
        if method == "GET":
            return _send(200, found)
        if method == "PATCH":
            return await _update(request, workspaces, found, user)
        return _send(405, {"error": "Method not allowed"})
    found = await workspaces.get(ws, user)
    if found is None:
        raise WorkspaceError(404, NOT_FOUND)
    manages = found["role"] in ("owner", "admin")
    section = rest[0]
    if section == "members" and len(rest) > 1:
        return await _member(request, workspaces, found, user, rest[1:])
    if len(rest) > 1:
        return _send(404, {"error": "Not found"})
    if section == "members" and method == "GET":
        local = await request.app.state.storage.access.local_user_id()
        return _send(
            200, {"members": await workspaces.members(found["id"], manages, user == local)}
        )
    if section in ("members", "lookup") and not manages:
        return _send(403, {"error": "Only the workspace's Owners and Admins can add people"})
    if section == "lookup" and method == "GET":
        params = request.query_params.getlist("email")
        try:
            person = await workspaces.lookup(params[0]) if params else None
        except SharedEmail as err:
            return _send(404, {"error": str(err)})
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


def _name(value: object) -> str:
    """A workspace name as given, with runs of white space made one space; "" when not a string."""
    return re.sub(r"\s+", " ", value).strip() if isinstance(value, str) else ""


async def _update(
    request: Request, workspaces: Workspaces, found: dict[str, Any], user: str
) -> Response:
    """PATCH /workspaces/<id>: rename (Owners and Admins), archive or restore (Owners)."""
    body = await _read_json(request)
    name = _name(body.get("name")) if body and "name" in body else None
    status = body.get("status") if body else None
    if (
        not body
        or (name is None and status is None)
        or (name is not None and not 0 < len(name) <= 200)
        or (status is not None and status not in ("active", "archived"))
    ):
        return _send(
            400,
            {
                "error": 'Expected {name?: string (at most 200 characters), status?: "active" | "archived"}'
            },
        )
    role = found["role"]
    if name is not None and role not in ("owner", "admin"):
        return _send(403, {"error": "Only the workspace's Owners and Admins can rename it"})
    if status is not None and status != found["status"]:
        if role != "owner":
            return _send(403, {"error": "Only the workspace's Owners can archive or restore it"})
        if status == "archived" and found["id"] == await workspaces.default_id():
            return _send(
                400,
                {
                    "error": "The default workspace can't be archived: requests that name no workspace go there"
                },
            )
    return _send(200, await workspaces.update(found, user, name, status))


async def _member(
    request: Request, workspaces: Workspaces, found: dict[str, Any], user: str, rest: list[str]
) -> Response:
    """
    /workspaces/<id>/members/<user>[/removal]: change a role, remove someone or
    leave, and preview a removal (docs/workspaces.md, "Administration and handover").
    """
    target, *more = rest
    target = target.lower()
    method = request.method
    role = found["role"]
    manages = role in ("owner", "admin")
    yourself = target == user
    if more == ["removal"] and method == "GET":
        if not (manages or yourself):
            return _send(403, {"error": "Only the workspace's Owners and Admins can remove people"})
        return _send(200, await workspaces.removal(found["id"], user, target))
    if more:
        return _send(404, {"error": "Not found"})
    if method == "PATCH":
        if not manages:
            return _send(403, {"error": "Only the workspace's Owners and Admins can change roles"})
        body = await _read_json(request)
        new_role = body.get("role") if body else None
        if new_role not in MEMBER_ROLES:
            return _send(400, {"error": 'Expected {role: "owner" | "admin" | "member"}'})
        changed = await workspaces.change_role(found["id"], user, role, target, new_role)
        return _send(200, {"member": {"id": target, "role": changed}})
    if method == "DELETE":
        if not (manages or yourself):
            return _send(403, {"error": "Only the workspace's Owners and Admins can remove people"})
        removed = await workspaces.remove_member(found["id"], user, role, target)
        return _send(200, {"removed": removed})
    return _send(405, {"error": "Method not allowed"})
