"""The storage API's /access and /nodes in Python (issue #190, step 2), as apps/agent/src/storage/http.ts.

    GET    /access                  {me, rootRole}
    GET    /access/users            everyone who has signed in
    GET    /access/people           the same, with sign-up and last-active times,
                                    workspace role and groups (workspace owners only)
    GET    /access/groups           the org tree, with direct members
    POST   /access/groups           {parentId|null, name}
    PATCH  /access/groups/<id>      {name}
    DELETE /access/groups/<id>      with its sub-groups
    PUT    /access/groups/<id>/members/<userId>    add a member
    DELETE /access/groups/<id>/members/<userId>    remove one
    GET    /access/grants?node=<id> grants on a node (no node = workspace)
    POST   /access/grants           {node|null, principalType, principalId, role}
    DELETE /access/grants/<id>
    GET    /access/audit?limit=&kind=  recent changes, newest first

    GET    /nodes                   {types, rootRole, nodes}
    POST   /nodes                   {parentId|null, name} -> the new node (201)
    GET    /nodes/<id>              {node, lineage}, lineage top level first
    PATCH  /nodes/<id>              {name} -> rename
    DELETE /nodes/<id>              soft delete, with everything below it

    GET    /files?node=             the files at the root or in a node
    GET    /files?watch             change events (server-sent), those this user may see
    GET    /files/<path>?node=      the content (a signed store link for binary files
                                    when S3_PUBLIC_URL is set); ?versions: its history
    PUT    /files/<path>?node=      write it (If-None-Match: * only creates)
    PATCH  /files/<path>?node=      {path} -> rename
    DELETE /files/<path>?node=      soft delete

An experiment's files (?experiment=) and proposed versions (?propose) still go
to the TypeScript server until experiments and proposals move (step 4).

Until the database has the migrations this server knows (the TypeScript
server applies them as it starts), these pass through to the TypeScript
server, which answers as it does while storage starts or when it is off.
Paths are read as sent: each segment is percent-decoded on its own, so a %2F
stays inside its segment, as the TypeScript server reads them.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
from datetime import datetime
from email.utils import format_datetime
from typing import Any
from urllib.parse import unquote

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, Response, StreamingResponse

from .access import ROLES, AccessError, ForbiddenError
from .files import FileExistsError_
from .identity import identify
from .nodes import NodeError, NodeNotFoundError
from .paths import (
    InvalidPathError,
    is_text_file,
    js_trim,
    kind_for_path,
    normalize_path,
)
from .proxy import forward
from .session import Session

logger = logging.getLogger("api_py")
router = APIRouter()
ALL_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]
MAX_JSON_BYTES = 64 * 1024
_BAD_ESCAPE = re.compile(r"%(?![0-9a-fA-F]{2})")
# The prefixes as sent. Starlette routes on the decoded path, so /%61ccess or
# /access%2Fusers reach these routes too, but the TypeScript server reads the raw
# path and serves those as files. They go to it, so a storage token's limits
# (agent_refusal) always see the section the handlers act on.
_OWN_PATH = re.compile(r"^/(access|nodes|files)(/|$)")
# A file watch's keep-alive comment, so idle connections are not cut.
HEARTBEAT_SECONDS = 25.0
# Stored bytes are served from the app's origin, so a file opened as a page (an
# HTML file, an SVG with a script) must not run as the app: no scripts, no
# same-origin access, and no sniffing past the declared type.
STORED_CONTENT_HEADERS = {"Content-Security-Policy": "sandbox", "X-Content-Type-Options": "nosniff"}


class _MalformedPath(Exception):
    """A path decodeURIComponent would refuse (a stray % or bytes that aren't UTF-8)."""


def decode_component(segment: str) -> str:
    """decodeURIComponent: percent escapes as UTF-8, failing where JavaScript fails."""
    if _BAD_ESCAPE.search(segment):
        raise _MalformedPath(segment)
    try:
        return unquote(segment, errors="strict")
    except UnicodeDecodeError as err:
        raise _MalformedPath(segment) from err


def json_response(status: int, body: Any) -> JSONResponse:
    return JSONResponse(body, status_code=status)


def error(status: int, message: str, **extra: Any) -> JSONResponse:
    return JSONResponse({"error": message, **extra}, status_code=status)


def raw_path(request: Request) -> str:
    return (request.scope.get("raw_path") or request.scope["path"].encode()).decode("latin-1")


def first_param(request: Request, name: str) -> str | None:
    """URLSearchParams.get: the first value, not Starlette's last."""
    values = request.query_params.getlist(name)
    return values[0] if values else None


def parse_int(value: str) -> int | None:
    """Number.parseInt: leading digits after optional spaces and sign; None for NaN."""
    match = re.match(r"\s*([+-]?\d+)", value)
    return int(match.group(1)) if match else None


async def read_body(request: Request, limit: int) -> bytes | None:
    """The body, or None when it is over `limit` bytes (readBody in http.ts)."""
    chunks: list[bytes] = []
    size = 0
    async for chunk in request.stream():
        size += len(chunk)
        if size > limit:
            return None
        chunks.append(chunk)
    return b"".join(chunks)


async def read_json(request: Request) -> dict[str, Any] | None:
    """The JSON object in the body (at most 64 KiB), or None, as readJson() in http.ts."""
    body = await read_body(request, MAX_JSON_BYTES)
    if body is None:
        return None

    def refuse(constant: str) -> None:
        raise ValueError(constant)  # NaN and Infinity aren't JSON

    try:
        value = json.loads(body.decode("utf-8", errors="replace"), parse_constant=refuse)
    except ValueError:
        return None
    return value if isinstance(value, dict) else None


def optional_id(value: Any) -> str | None | bool:
    """A string, None for null or missing, or False when it is something else."""
    if value is None:
        return None
    return value if isinstance(value, str) else False


def agent_refusal(request: Request) -> str | None:
    """Why Claude, through a storage token, may not make this request (agentRefusal in http.ts, for these routes)."""
    method = request.method
    section, *rest = raw_path(request).split("/")[1:]
    sub = "/".join(rest)
    if method in ("GET", "HEAD"):
        return "Claude doesn't manage access" if section == "access" and sub != "" else None
    if section == "files":
        if method != "PUT":
            return "Claude doesn't rename or delete files"
        if "propose" in request.query_params or first_param(request, "experiment"):
            return None
        if first_param(request, "node"):
            return "Claude's writes in a knowledge node are proposals: add ?propose"
        try:
            skill = kind_for_path(normalize_path("/".join(decode_component(p) for p in sub.split("/")))) == "skill"
        except (_MalformedPath, InvalidPathError):
            return None  # the file route answers bad paths itself
        return "Claude's changes to skills are proposals: add ?propose" if skill else None
    if section == "nodes":
        return None if method == "POST" and sub == "" else "Claude doesn't rename or delete nodes"
    if section == "access":
        return "Claude doesn't manage access"
    return "Claude can't do that with a storage token"


async def _session(request: Request) -> Session | Response:
    """This request's Session, or the answer when it is refused."""
    storage = request.app.state.storage
    secret = request.app.state.settings.auth_secret
    principal = await identify(request, storage.access, secret, storage_tokens=True)
    if principal is None:
        return error(401, "Sign in to use the workspace")
    if principal.via:
        refusal = agent_refusal(request)
        if refusal:
            return error(403, refusal)
    return Session(storage, storage.access, principal)


async def _serve(request: Request, handler, typescript_serves=None) -> Response:
    """Serves a request with `handler`, or passes it on while it is the TypeScript server's (`typescript_serves`)."""
    if (
        not _OWN_PATH.match(raw_path(request))
        or not await request.app.state.storage_ready()
        or (typescript_serves and typescript_serves(request))
    ):
        return await forward(request, request.app.state.http)
    try:
        session = await _session(request)
        if isinstance(session, Response):
            return session
        return await handler(request, session)
    except NodeNotFoundError as err:
        return error(404, str(err))
    except ForbiddenError as err:
        return error(403, str(err))
    except FileExistsError_ as err:
        return error(412, str(err), exists=True)
    except (NodeError, AccessError, InvalidPathError) as err:
        return error(400, str(err))
    except Exception:
        logger.exception("[storage] request failed")
        return error(500, "Storage error")


@router.api_route("/nodes", methods=ALL_METHODS, include_in_schema=False)
@router.api_route("/nodes/{rest:path}", methods=ALL_METHODS, include_in_schema=False)
async def nodes_route(request: Request) -> Response:
    return await _serve(request, handle_nodes)


@router.api_route("/access", methods=ALL_METHODS, include_in_schema=False)
@router.api_route("/access/{rest:path}", methods=ALL_METHODS, include_in_schema=False)
async def access_route(request: Request) -> Response:
    return await _serve(request, handle_access)


def _typescript_files(request: Request) -> bool:
    """Experiment files and proposals, which the TypeScript server serves until step 4, or no blob store here."""
    return (
        bool(first_param(request, "experiment"))
        or "propose" in request.query_params
        or request.app.state.storage.blobs is None
    )


@router.api_route("/files", methods=ALL_METHODS, include_in_schema=False)
@router.api_route("/files/{rest:path}", methods=ALL_METHODS, include_in_schema=False)
async def files_route(request: Request) -> Response:
    return await _serve(request, handle_files, _typescript_files)


async def handle_nodes(request: Request, session: Session) -> Response:
    node_id = decode_component(re.sub(r"^/nodes/?", "", raw_path(request)))
    method = request.method
    if not node_id:
        if method == "GET":
            return json_response(200, await session.tree())
        if method == "POST":
            body = await read_json(request)
            parent_id = optional_id(body.get("parentId")) if body else None
            if not body or not isinstance(body.get("name"), str) or parent_id is False:
                return error(400, "Expected {parentId: string | null, name: string}")
            return json_response(201, await session.create_node(parent_id, body["name"]))  # type: ignore[arg-type]
        return error(405, "Method not allowed")

    if method == "GET":
        lineage = await session.lineage(node_id)
        return json_response(200, {"node": lineage[-1], "lineage": lineage})
    if method == "PATCH":
        body = await read_json(request)
        if not body or not isinstance(body.get("name"), str):
            return error(400, "Expected {name: string}")
        node = await session.rename_node(node_id, body["name"])
        return json_response(200, node) if node else error(404, "Node not found")
    if method == "DELETE":
        if await session.delete_node(node_id):
            return json_response(200, {"deleted": node_id})
        return error(404, "Node not found")
    return error(405, "Method not allowed")


async def handle_access(request: Request, session: Session) -> Response:
    parts = [decode_component(p) for p in raw_path(request).split("/")[2:]]  # after /access
    section, ident, sub, sub_id = (parts + [""] * 4)[:4]
    method = request.method

    def not_found() -> Response:
        return error(404, "Not found")

    def done(ok: bool) -> Response:
        return json_response(200, {"ok": True}) if ok else not_found()

    if not section:
        if method != "GET":
            return error(405, "Method not allowed")
        me = next((u for u in await session.users() if u["id"] == session.principal.user_id), None)
        return json_response(200, {"me": me, "rootRole": await session.role(None)})

    if section == "users" and not ident and method == "GET":
        return json_response(200, {"users": await session.users()})

    if section == "people" and not ident and method == "GET":
        return json_response(200, {"people": await session.people()})

    if section == "groups":
        if not ident:
            if method == "GET":
                return json_response(200, {"groups": await session.groups()})
            if method == "POST":
                body = await read_json(request)
                parent_id = optional_id(body.get("parentId")) if body else None
                if not body or not isinstance(body.get("name"), str) or parent_id is False:
                    return error(400, "Expected {parentId: string | null, name: string}")
                return json_response(201, {"id": await session.create_group(parent_id, body["name"])})  # type: ignore[arg-type]
        elif not sub:
            if method == "PATCH":
                body = await read_json(request)
                if not body or not isinstance(body.get("name"), str):
                    return error(400, "Expected {name: string}")
                return done(await session.rename_group(ident, body["name"]))
            if method == "DELETE":
                return done(await session.delete_group(ident))
        elif sub == "members" and sub_id and method in ("PUT", "DELETE"):
            return done(await session.set_member(ident, sub_id, method == "PUT"))

    if section == "grants":
        if not ident and method == "GET":
            return json_response(200, {"grants": await session.grants(first_param(request, "node") or None)})
        if not ident and method == "POST":
            body = await read_json(request)
            node = optional_id(body.get("node")) if body else None
            if (
                not body
                or node is False
                or body.get("principalType") not in ("user", "group")
                or not isinstance(body.get("principalId"), str)
                or body.get("role") not in ROLES
            ):
                return error(
                    400, 'Expected {node: string | null, principalType: "user" | "group", principalId, role}'
                )
            grant_id = await session.set_grant(node, body["principalType"], body["principalId"], body["role"])  # type: ignore[arg-type]
            return json_response(200, {"id": grant_id})
        if ident and method == "DELETE":
            return done(await session.revoke(ident))

    if section == "audit" and not ident and method == "GET":
        limit = parse_int(first_param(request, "limit") or "100")
        kinds = [k for k in request.query_params.getlist("kind") if k]
        return json_response(200, {"entries": await session.audit_log(100 if limit is None else limit, kinds)})

    return not_found()


async def handle_files(request: Request, session: Session) -> Response:
    try:
        path = "/".join(decode_component(p) for p in re.sub(r"^/files/?", "", raw_path(request)).split("/"))
    except _MalformedPath:
        return error(400, "Malformed path encoding")
    method = request.method

    if path == "" and method == "GET" and "watch" in request.query_params:
        return await watch(session)

    files = await session.files(first_param(request, "node") or None)

    if path == "":
        if method != "GET":
            return error(405, "Method not allowed")
        return json_response(200, {"files": await files.list()})

    if method == "GET":
        if "versions" in request.query_params:
            versions = await files.history(path)
            return error(404, "Not found") if versions is None else json_response(200, {"versions": versions})
        # Binary files come straight from the object store when it is reachable
        # from browsers: a short-lived link, made after the access check above.
        # Text stays here, since the UI fetches it from this origin.
        info = await files.stat(path)
        if info and not is_text_file(info["path"], info["mime"]):
            link = await session.storage.blobs.download_url(  # type: ignore[union-attr]
                info["sha256"], info["mime"], info["path"].split("/")[-1]
            )
            if link:
                return Response(status_code=302, headers={"Location": link, "Cache-Control": "no-store"})
        found = await files.read(path) if info else None
        if not found:
            return error(404, "Not found")
        info, content = found
        etag = f'"{info["sha256"]}"'
        if request.headers.get("if-none-match") == etag:
            return Response(status_code=304, headers={"ETag": etag})
        modified = datetime.fromisoformat(info["updatedAt"])
        return Response(
            content,
            headers={
                # As given, without the charset Starlette would add to text/*.
                "Content-Type": info["mime"],
                "ETag": etag,
                "Last-Modified": format_datetime(modified.replace(microsecond=0), usegmt=True),
                "X-File-Author": info["author"],
                "Cache-Control": "no-cache",
                **STORED_CONTENT_HEADERS,
            },
        )

    if method == "PUT":
        limit = request.app.state.settings.max_upload_bytes
        content = await read_body(request, limit)
        if content is None:
            return error(413, f"File exceeds {limit} bytes")
        header = js_trim(request.headers.get("content-type", "").split(";")[0])
        mime = header if header and header != "application/octet-stream" else None
        create_only = js_trim(request.headers.get("if-none-match", "")) == "*"
        return json_response(200, await files.write(path, content, mime=mime, create_only=create_only))

    if method == "PATCH":
        body = await read_json(request)
        if not body or not isinstance(body.get("path"), str):
            return error(400, "Expected {path: string}")
        info = await files.rename(path, body["path"])
        return json_response(200, info) if info else error(404, "Not found")

    if method == "DELETE":
        if await files.remove(path):
            return json_response(200, {"deleted": path})
        return error(404, "Not found")

    return error(405, "Method not allowed")


async def watch(session: Session) -> Response:
    """
    The changes this principal may see, as server-sent events, in order: each is
    checked before the next. Subscribes before answering, so a failure still
    gets a normal error answer.
    """
    queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
    unsubscribe = await session.storage.events.subscribe(queue.put_nowait)  # type: ignore[union-attr]

    async def stream():
        loop = asyncio.get_running_loop()
        next_ping = loop.time() + HEARTBEAT_SECONDS
        waiting: asyncio.Task[dict[str, Any]] | None = None
        try:
            # A comment line first so proxies flush the headers.
            yield b": watching\n\n"
            while True:
                waiting = waiting or asyncio.ensure_future(queue.get())
                done, _ = await asyncio.wait({waiting}, timeout=max(0.0, next_ping - loop.time()))
                if not done:
                    yield b": ping\n\n"
                    next_ping += HEARTBEAT_SECONDS
                    continue
                event, waiting = waiting.result(), None
                try:
                    if await session.can_see(event):
                        data = json.dumps(event, separators=(",", ":"), ensure_ascii=False)
                        yield f"data: {data}\n\n".encode()
                except Exception:
                    logger.exception("[storage] watch")
        finally:
            if waiting:
                waiting.cancel()
            unsubscribe()

    return StreamingResponse(
        stream(),
        headers={
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
