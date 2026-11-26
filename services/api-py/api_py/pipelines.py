"""Pipelines (docs/pipeline-identities.md): named, revocable identities for work that runs on its own.

    GET    /pipelines[?all]                  {pipelines: [Pipeline]}: yours; with ?all, every
                                             pipeline in the workspace (Owners and Admins)
    POST   /pipelines                        {name, places, operations, expiresInDays?}
                                             -> {pipeline, key: {id, hint, expiresAt, secret}}
                                             (201): the only answer that shows the key
    PATCH  /pipelines/<id>                   {name?, places?, operations?}: its owner
    POST   /pipelines/<id>/owner             {userId}: hand it over (Owners and Admins)
    POST   /pipelines/<id>/keys              {expiresInDays?} -> {key} (201): its owner; at
                                             most two live keys (409 for a third)
    DELETE /pipelines/<id>/keys/<key>        revoke a key: its owner, Owners and Admins
    DELETE /pipelines/<id>                   revoke it and all its keys: the same

A pipeline acts for its owner, narrowed to its places (the whole workspace, or
nodes and Experiments) and operations. Its keys are `kcp_` and 32 random
bytes; only their SHA-256 is kept, and every request looks its key up
(authenticate), so revoking takes effect at the next one. A request already
accepted ends as it would have. A revoked pipeline is kept, so what names it
still resolves.

These rows are administration, not content: they are read and written with
the app's own connection, and the checks are here, as for workspace
membership. Storage tokens and pipeline keys can't use these routes.
"""

from __future__ import annotations

import base64
import hashlib
import logging
import re
import secrets
from datetime import UTC, datetime, timedelta
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, Response
from psycopg import AsyncConnection
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from psycopg_pool import AsyncConnectionPool

from .access import AccessService, PipelineScope, Principal, is_uuid, iso
from .identity import identify
from .unserved import not_served
from .workspaces import WorkspaceError, resolve

logger = logging.getLogger("api_py")
router = APIRouter()
_ALL_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]

# The header the web app forwards a pipeline's key in (Authorization: Bearer kcp_...).
PIPELINE_HEADER = "x-knowledge-pipeline"
KEY_PREFIX = "kcp_"
_KEY = re.compile(r"kcp_[A-Za-z0-9_-]{43}")
OPERATIONS = ("read", "write", "runs", "upload")
DEFAULT_KEY_DAYS = 90
MAX_LIVE_KEYS = 2
MAX_PLACES = 50
# How often a key's last use is written: once a minute at most, so reads don't each become a write.
LAST_USED_EVERY = timedelta(minutes=1)

NOT_FOUND = "Pipeline not found"
NOT_OWNER = "Only the pipeline's owner can change it"
NOT_MANAGER = "Only the pipeline's owner, and the workspace's Owners and Admins, can revoke it"
ONLY_MANAGERS = "Only the workspace's Owners and Admins can hand a pipeline over"
REVOKED = "This pipeline was revoked; make a new one"
TOO_MANY_KEYS = f"A pipeline has at most {MAX_LIVE_KEYS} live keys; revoke one first"
CREATE_EXPECTED = (
    'Expected {name: string, places: null | [{node} | {experiment}], operations: ["read" | '
    '"write" | "runs" | "upload", ...], expiresInDays?: number}'
)
UPDATE_EXPECTED = (
    "Expected {name?: string, places?: null | [{node} | {experiment}], operations?: [...]}"
)


class PipelineRefused(Exception):
    """A pipeline key that can't act now (401): unknown, revoked, expired, or its pipeline suspended."""


def new_secret() -> str:
    """A key: `kcp_` and 32 random bytes in base64url."""
    return KEY_PREFIX + base64.urlsafe_b64encode(secrets.token_bytes(32)).rstrip(b"=").decode()


def key_hash(secret: str) -> bytes:
    return hashlib.sha256(secret.encode()).digest()


def _days(value: Any, max_days: int) -> int | None:
    """expiresInDays: a whole number from 1 to max_days, or the default when absent; None when invalid."""
    if value is None:
        return min(DEFAULT_KEY_DAYS, max_days)
    if isinstance(value, bool) or not isinstance(value, int | float) or value != int(value):
        return None
    days = int(value)
    return days if 1 <= days <= max_days else None


def _name(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    name = re.sub(r"\s+", " ", value).strip()
    return name if 0 < len(name) <= 200 else None


def _operations(value: Any) -> list[str] | None:
    if not isinstance(value, list) or not value:
        return None
    if not all(isinstance(op, str) and op in OPERATIONS for op in value):
        return None
    return [op for op in OPERATIONS if op in value]


def _places(value: Any) -> list[dict[str, str]] | None | bool:
    """None for the whole workspace, the list as given (ids lower-cased), or False when it isn't one."""
    if value is None:
        return None
    if not isinstance(value, list) or not value or len(value) > MAX_PLACES:
        return False
    places: list[dict[str, str]] = []
    for place in value:
        if not isinstance(place, dict) or len(place) != 1:
            return False
        ((kind, ident),) = place.items()
        if kind not in ("node", "experiment") or not isinstance(ident, str) or not is_uuid(ident):
            return False
        entry = {kind: ident.lower()}
        if entry not in places:
            places.append(entry)
    return places


def scope_of(row: dict[str, Any], key_id: str, key_hint: str) -> PipelineScope:
    places = row["places"]
    return PipelineScope(
        id=str(row["id"]),
        name=row["name"],
        key_id=key_id,
        key_hint=key_hint,
        nodes=None if places is None else tuple(p["node"] for p in places if "node" in p),
        experiments=()
        if places is None
        else tuple(p["experiment"] for p in places if "experiment" in p),
        operations=frozenset(row["operations"]),
    )


class Pipelines:
    """The pipelines and their keys in the database (030_pipelines.sql)."""

    def __init__(self, pool: AsyncConnectionPool) -> None:
        self.pool = pool

    async def authenticate(self, secret: str) -> tuple[Principal, str]:
        """
        The principal a key acts as, and its workspace; PipelineRefused with
        the reason when it can't act now. Looked up on every request, so a
        revocation takes effect at the next one.
        """
        if not _KEY.fullmatch(secret):
            raise PipelineRefused("This pipeline key isn't valid")
        async with self.pool.connection() as conn:
            cur = await conn.cursor(row_factory=dict_row).execute(
                """
                SELECT k.id AS key_id, k.hint, k.expires_at, k.revoked_at AS key_revoked,
                       k.last_used_at, p.id, p.name, p.owner_id, p.places, p.operations,
                       p.revoked_at, p.workspace_id, w.status AS workspace_status,
                       EXISTS (SELECT 1 FROM workspace_members m
                               WHERE m.workspace_id = p.workspace_id AND m.user_id = p.owner_id)
                         AS owner_member
                FROM pipeline_keys k
                JOIN pipelines p ON p.id = k.pipeline_id
                JOIN workspaces w ON w.id = p.workspace_id
                WHERE k.sha256 = %s""",
                (key_hash(secret),),
            )
            row = await cur.fetchone()
            if row is None:
                raise PipelineRefused("This pipeline key isn't valid")
            now = datetime.now(UTC)
            if row["key_revoked"] is not None:
                raise PipelineRefused("This pipeline key was revoked")
            if row["revoked_at"] is not None:
                raise PipelineRefused("This pipeline was revoked")
            if row["expires_at"] <= now:
                raise PipelineRefused(f"This pipeline key expired at {iso(row['expires_at'])}")
            if row["workspace_status"] != "active":
                raise PipelineRefused("This pipeline's workspace is archived")
            if row["owner_id"] is None or not row["owner_member"]:
                raise PipelineRefused(
                    "This pipeline is suspended: its owner is no longer a member of the "
                    "workspace. An Owner or Admin can hand it over."
                )
            if row["last_used_at"] is None or row["last_used_at"] <= now - LAST_USED_EVERY:
                await conn.execute(
                    "UPDATE pipeline_keys SET last_used_at = now() WHERE id = %s", (row["key_id"],)
                )
        scope = scope_of(row, str(row["key_id"]), row["hint"])
        principal = Principal(
            user_id=str(row["owner_id"]),
            actor="pipeline",
            via=f"pipeline:{scope.id}",
            bound_ws=str(row["workspace_id"]),
            pipeline=scope,
        )
        return principal, str(row["workspace_id"])

    async def listed(self, ws: str, user_id: str, everyone: bool) -> list[dict[str, Any]]:
        async with self.pool.connection() as conn:
            return await self._rows(conn, ws, None if everyone else user_id)

    async def get(self, conn: AsyncConnection, ws: str, pipeline_id: str) -> dict[str, Any] | None:
        found = await self._rows(conn, ws, None, pipeline_id)
        return found[0] if found else None

    async def _rows(
        self,
        conn: AsyncConnection,
        ws: str,
        owner: str | None,
        pipeline_id: str | None = None,
        lock: bool = False,
    ) -> list[dict[str, Any]]:
        if pipeline_id is not None and not is_uuid(pipeline_id):
            return []
        cur = await conn.cursor(row_factory=dict_row).execute(
            f"""
            SELECT p.id, p.name, p.owner_id, u.name AS owner_name, u.email AS owner_email,
                   p.created_by, p.places, p.operations, p.created_at, p.revoked_at,
                   EXISTS (SELECT 1 FROM workspace_members m
                           WHERE m.workspace_id = p.workspace_id AND m.user_id = p.owner_id)
                     AS owner_member
            FROM pipelines p LEFT JOIN users u ON u.id = p.owner_id
            WHERE p.workspace_id = %(ws)s
              AND (%(owner)s::uuid IS NULL OR p.owner_id = %(owner)s::uuid)
              AND (%(id)s::uuid IS NULL OR p.id = %(id)s::uuid)
            ORDER BY p.created_at, p.id {"FOR UPDATE OF p" if lock else ""}""",  # pyrefly: ignore[bad-argument-type]
            {"ws": ws, "owner": owner, "id": pipeline_id},
        )
        pipelines = await cur.fetchall()
        if not pipelines:
            return []
        keys = await conn.cursor(row_factory=dict_row).execute(
            """
            SELECT id, pipeline_id, hint, created_at, expires_at, last_used_at, revoked_at
            FROM pipeline_keys WHERE pipeline_id = ANY(%s) ORDER BY created_at, id""",
            ([p["id"] for p in pipelines],),
        )
        by_pipeline: dict[str, list[dict[str, Any]]] = {}
        now = datetime.now(UTC)
        for key in await keys.fetchall():
            by_pipeline.setdefault(str(key["pipeline_id"]), []).append(_key(key, now))
        return [_pipeline(p, by_pipeline.get(str(p["id"]), [])) for p in pipelines]

    async def _check_places(
        self, access: AccessService, user_id: str, places: list[dict[str, str]] | None
    ) -> None:
        """Every place must be one the owner can see now: a pipeline never reaches past its owner."""
        for place in places or []:
            if "node" in place:
                if await access.role(user_id, place["node"]) is None:
                    raise WorkspaceError(404, "Node not found")
            elif await access.experiment_access(user_id, place["experiment"]) is None:
                raise WorkspaceError(404, "Experiment not found")

    async def _add_key(
        self, conn: AsyncConnection, ws: str, pipeline_id: str, by: str, days: int
    ) -> dict[str, Any]:
        secret = new_secret()
        expires = datetime.now(UTC) + timedelta(days=days)
        cur = await conn.cursor(row_factory=dict_row).execute(
            """
            INSERT INTO pipeline_keys (pipeline_id, workspace_id, sha256, hint, created_by, expires_at)
            VALUES (%s, %s, %s, %s, %s, %s)
            RETURNING id, pipeline_id, hint, created_at, expires_at, last_used_at, revoked_at""",
            (pipeline_id, ws, key_hash(secret), secret[-4:], by, expires),
        )
        row = await cur.fetchone()
        assert row is not None
        return {**_key(row, datetime.now(UTC)), "secret": secret}

    async def create(
        self,
        access: AccessService,
        principal: Principal,
        name: str,
        places: list[dict[str, str]] | None,
        operations: list[str],
        days: int,
    ) -> dict[str, Any]:
        await self._check_places(access, principal.user_id, places)
        ws = access.workspace_id
        async with self.pool.connection() as conn, conn.transaction():
            cur = await conn.execute(
                """
                INSERT INTO pipelines (workspace_id, name, owner_id, created_by, places, operations)
                VALUES (%s, %s, %s, %s, %s, %s) RETURNING id""",
                (
                    ws,
                    name,
                    principal.user_id,
                    principal.user_id,
                    None if places is None else Jsonb(places),
                    operations,
                ),
            )
            (pipeline_id,) = await cur.fetchone()  # pyrefly: ignore[not-iterable]
            pipeline_id = str(pipeline_id)
            key = await self._add_key(conn, ws, pipeline_id, principal.user_id, days)
            await access.audit(
                conn,
                principal,
                "pipeline.create",
                {
                    "pipeline": pipeline_id,
                    "name": name,
                    "operations": operations,
                    "keyId": key["id"],
                },
            )
            pipeline = await self.get(conn, ws, pipeline_id)
        return {"pipeline": pipeline, "key": key}

    async def _locked(
        self, conn: AsyncConnection, ws: str, pipeline_id: str, user_id: str, manages: bool
    ) -> dict[str, Any]:
        """The pipeline, row locked, when the caller owns it or manages the workspace; 404 otherwise."""
        found = await self._rows(conn, ws, None, pipeline_id, lock=True)
        if not found or not (manages or found[0]["owner"] and found[0]["owner"]["id"] == user_id):
            raise WorkspaceError(404, NOT_FOUND)
        return found[0]

    async def update(
        self,
        access: AccessService,
        principal: Principal,
        manages: bool,
        pipeline_id: str,
        fields: dict[str, Any],
    ) -> dict[str, Any]:
        ws = access.workspace_id
        if "places" in fields:
            await self._check_places(access, principal.user_id, fields["places"])
        async with self.pool.connection() as conn, conn.transaction():
            found = await self._locked(conn, ws, pipeline_id, principal.user_id, manages)
            if not found["owner"] or found["owner"]["id"] != principal.user_id:
                raise WorkspaceError(403, NOT_OWNER)
            if found["status"] == "revoked":
                raise WorkspaceError(409, REVOKED)
            values = {
                k: Jsonb(v) if k == "places" and v is not None else v for k, v in fields.items()
            }
            if values:
                assignments = ", ".join(f"{column} = %s" for column in values)
                await conn.execute(
                    f"UPDATE pipelines SET {assignments} WHERE id = %s",  # pyrefly: ignore[bad-argument-type]
                    (*values.values(), pipeline_id),
                )
                await access.audit(
                    conn,
                    principal,
                    "pipeline.update",
                    {"pipeline": pipeline_id, "fields": sorted(fields)},
                )
            changed = await self.get(conn, ws, pipeline_id)
        assert changed is not None
        return changed

    async def hand_over(
        self, access: AccessService, principal: Principal, pipeline_id: str, to: str
    ) -> dict[str, Any]:
        """To another member, who it then acts for, with their access (Owners and Admins)."""
        ws = access.workspace_id
        async with self.pool.connection() as conn, conn.transaction():
            found = await self._locked(conn, ws, pipeline_id, principal.user_id, True)
            if found["status"] == "revoked":
                raise WorkspaceError(409, REVOKED)
            cur = await conn.execute(
                "SELECT 1 FROM workspace_members WHERE workspace_id = %s AND user_id = %s",
                (ws, to),
            )
            if await cur.fetchone() is None:
                raise WorkspaceError(404, "They aren't a member of this workspace")
            await conn.execute(
                "UPDATE pipelines SET owner_id = %s WHERE id = %s", (to, pipeline_id)
            )
            await access.audit(
                conn,
                principal,
                "pipeline.handover",
                {
                    "pipeline": pipeline_id,
                    "from": found["owner"]["id"] if found["owner"] else None,
                    "toUser": to,
                },
            )
            changed = await self.get(conn, ws, pipeline_id)
        assert changed is not None
        return changed

    async def add_key(
        self,
        access: AccessService,
        principal: Principal,
        manages: bool,
        pipeline_id: str,
        days: int,
    ) -> dict[str, Any]:
        ws = access.workspace_id
        async with self.pool.connection() as conn, conn.transaction():
            found = await self._locked(conn, ws, pipeline_id, principal.user_id, manages)
            if not found["owner"] or found["owner"]["id"] != principal.user_id:
                raise WorkspaceError(403, NOT_OWNER)
            if found["status"] == "revoked":
                raise WorkspaceError(409, REVOKED)
            if sum(1 for k in found["keys"] if k["status"] == "active") >= MAX_LIVE_KEYS:
                raise WorkspaceError(409, TOO_MANY_KEYS)
            key = await self._add_key(conn, ws, pipeline_id, principal.user_id, days)
            await access.audit(
                conn,
                principal,
                "pipeline.key.create",
                {"pipeline": pipeline_id, "keyId": key["id"]},
            )
        return key

    async def revoke_key(
        self,
        access: AccessService,
        principal: Principal,
        manages: bool,
        pipeline_id: str,
        key_id: str,
    ) -> bool:
        ws = access.workspace_id
        if not is_uuid(key_id):
            return False
        async with self.pool.connection() as conn, conn.transaction():
            await self._locked(conn, ws, pipeline_id, principal.user_id, manages)
            cur = await conn.execute(
                """
                UPDATE pipeline_keys SET revoked_at = now(), revoked_by = %s
                WHERE id = %s AND pipeline_id = %s AND revoked_at IS NULL""",
                (principal.user_id, key_id, pipeline_id),
            )
            if not cur.rowcount:
                return False
            await access.audit(
                conn, principal, "pipeline.key.revoke", {"pipeline": pipeline_id, "keyId": key_id}
            )
        return True

    async def revoke(
        self, access: AccessService, principal: Principal, manages: bool, pipeline_id: str
    ) -> bool:
        ws = access.workspace_id
        async with self.pool.connection() as conn, conn.transaction():
            found = await self._locked(conn, ws, pipeline_id, principal.user_id, manages)
            if found["status"] == "revoked":
                return False
            await conn.execute(
                "UPDATE pipelines SET revoked_at = now(), revoked_by = %s WHERE id = %s",
                (principal.user_id, pipeline_id),
            )
            await conn.execute(
                """
                UPDATE pipeline_keys SET revoked_at = now(), revoked_by = %s
                WHERE pipeline_id = %s AND revoked_at IS NULL""",
                (principal.user_id, pipeline_id),
            )
            await access.audit(conn, principal, "pipeline.revoke", {"pipeline": pipeline_id})
        return True


def _key(row: dict[str, Any], now: datetime) -> dict[str, Any]:
    status = (
        "revoked"
        if row["revoked_at"] is not None
        else "expired"
        if row["expires_at"] <= now
        else "active"
    )
    return {
        "id": str(row["id"]),
        "hint": row["hint"],
        "createdAt": iso(row["created_at"]),
        "expiresAt": iso(row["expires_at"]),
        "lastUsedAt": iso(row["last_used_at"]),
        "revokedAt": iso(row["revoked_at"]),
        "status": status,
    }


def _pipeline(row: dict[str, Any], keys: list[dict[str, Any]]) -> dict[str, Any]:
    owner = (
        None
        if row["owner_id"] is None
        else {
            "id": str(row["owner_id"]),
            "name": row["owner_name"] if row["owner_name"] is not None else row["owner_email"],
        }
    )
    status = (
        "revoked"
        if row["revoked_at"] is not None
        else "suspended"
        if owner is None or not row["owner_member"]
        else "active"
    )
    return {
        "id": str(row["id"]),
        "name": row["name"],
        "owner": owner,
        "createdBy": str(row["created_by"]) if row["created_by"] else None,
        "createdAt": iso(row["created_at"]),
        # Ids only: the caller's own tree names them, so nothing they can't see is named.
        "places": row["places"],
        "operations": list(row["operations"]),
        "status": status,
        "revokedAt": iso(row["revoked_at"]),
        "keys": keys,
    }


def _send(status: int, body: Any) -> JSONResponse:
    return JSONResponse(body, status_code=status, headers={"Cache-Control": "no-store"})


@router.api_route("/pipelines", methods=_ALL_METHODS, include_in_schema=False)
@router.api_route("/pipelines/{rest:path}", methods=_ALL_METHODS, include_in_schema=False)
async def pipelines_route(request: Request) -> Response:
    state = request.app.state
    if not state.settings.pipelines or not await state.storage_ready():
        return not_served(request)
    storage = state.storage
    try:
        if request.headers.get(PIPELINE_HEADER) is not None:
            return _send(403, {"error": "A pipeline key can't manage pipelines"})
        principal = await identify(
            request, storage.access, state.settings.auth_secret, storage_tokens=True
        )
        if principal is None:
            return _send(401, {"error": "Sign in to use the workspace"})
        if principal.via:
            return _send(403, {"error": "Claude doesn't make, see or revoke pipelines"})
        ws, membership = await resolve(request, state.workspaces, principal.user_id, None)
        return await _route(
            request,
            state.pipelines,
            storage.access.in_workspace(ws),
            principal,
            membership in ("owner", "admin"),
        )
    except WorkspaceError as err:
        return _send(err.status, {"error": str(err)})
    except Exception:
        logger.exception("[pipelines] request failed")
        return _send(500, {"error": "Storage error"})


async def _route(
    request: Request,
    pipelines: Pipelines,
    access: AccessService,
    principal: Principal,
    manages: bool,
) -> Response:
    from .storage_routes import read_json

    parts = [p for p in request.url.path.split("/")[2:] if p]
    method = request.method
    max_days = request.app.state.settings.pipeline_key_max_days
    user = principal.user_id

    if not parts:
        if method == "GET":
            everyone = "all" in request.query_params
            if everyone and not manages:
                return _send(
                    403, {"error": "Only the workspace's Owners and Admins see every pipeline"}
                )
            return _send(
                200, {"pipelines": await pipelines.listed(access.workspace_id, user, everyone)}
            )
        if method == "POST":
            body = await read_json(request)
            name = _name(body.get("name")) if body else None
            places = _places(body.get("places", False)) if body and "places" in body else False
            operations = _operations(body.get("operations")) if body else None
            days = _days(body.get("expiresInDays"), max_days) if body else None
            if (
                body is None
                or set(body) - {"name", "places", "operations", "expiresInDays"}
                or name is None
                or places is False
                or operations is None
                or days is None
            ):
                return _send(
                    400, {"error": f"{CREATE_EXPECTED}, with expiresInDays from 1 to {max_days}"}
                )
            made = await pipelines.create(access, principal, name, places, operations, days)  # pyrefly: ignore[bad-argument-type]
            return _send(201, made)
        return _send(405, {"error": "Method not allowed"})

    pipeline_id, *rest = parts
    if not is_uuid(pipeline_id):
        return _send(404, {"error": NOT_FOUND})
    if not rest:
        if method == "GET":
            async with pipelines.pool.connection() as conn:
                found = await pipelines.get(conn, access.workspace_id, pipeline_id)
            if found is None or not (manages or found["owner"] and found["owner"]["id"] == user):
                return _send(404, {"error": NOT_FOUND})
            return _send(200, found)
        if method == "PATCH":
            body = await read_json(request)
            fields: dict[str, Any] = {}
            bad = body is None or not body or bool(set(body) - {"name", "places", "operations"})
            if not bad and body is not None:
                if "name" in body:
                    fields["name"] = _name(body["name"])
                    bad = bad or fields["name"] is None
                if "places" in body:
                    fields["places"] = _places(body["places"])
                    bad = bad or fields["places"] is False
                if "operations" in body:
                    fields["operations"] = _operations(body["operations"])
                    bad = bad or fields["operations"] is None
            if bad:
                return _send(400, {"error": UPDATE_EXPECTED})
            return _send(
                200, await pipelines.update(access, principal, manages, pipeline_id, fields)
            )
        if method == "DELETE":
            if not await pipelines.revoke(access, principal, manages, pipeline_id):
                return _send(409, {"error": "This pipeline was revoked already"})
            return _send(200, {"revoked": True})
        return _send(405, {"error": "Method not allowed"})

    section = rest[0]
    if section == "owner" and len(rest) == 1 and method == "POST":
        if not manages:
            return _send(403, {"error": ONLY_MANAGERS})
        body = await read_json(request)
        to = body.get("userId") if body else None
        if not isinstance(to, str) or not is_uuid(to) or set(body or {}) - {"userId"}:
            return _send(400, {"error": "Expected {userId}"})
        return _send(200, await pipelines.hand_over(access, principal, pipeline_id, to.lower()))
    if section == "keys" and len(rest) == 1 and method == "POST":
        body = await read_json(request) if await request.body() else {}
        days = _days((body or {}).get("expiresInDays"), max_days) if body is not None else None
        if body is None or set(body) - {"expiresInDays"} or days is None:
            return _send(
                400, {"error": f"Expected {{expiresInDays?: number from 1 to {max_days}}}"}
            )
        key = await pipelines.add_key(access, principal, manages, pipeline_id, days)
        return _send(201, {"key": key})
    if section == "keys" and len(rest) == 2 and method == "DELETE":
        if not await pipelines.revoke_key(access, principal, manages, pipeline_id, rest[1]):
            return _send(404, {"error": "Key not found, or revoked already"})
        return _send(200, {"revoked": True})
    return _send(404, {"error": "Not found"})
