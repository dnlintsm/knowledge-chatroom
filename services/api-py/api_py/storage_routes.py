"""The storage API's routes that have moved to Python (#190), as apps/agent/src/storage/http.ts serves them.

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

    GET    /files?node=             the files at the root or in a node (?experiment=<id>:
                                    an experiment's)
    GET    /files?watch             change events (server-sent), those this user may see
    GET    /files/<path>?node=      the content (a signed store link for binary files
                                    when S3_PUBLIC_URL is set); ?versions: its history
    PUT    /files/<path>?node=      write it (If-None-Match: * only creates); ?propose
                                    (&note=): propose it instead (201)
    PATCH  /files/<path>?node=      {path} -> rename
    DELETE /files/<path>?node=      soft delete

    GET    /experiments?node=<id>   {experiments} you can see, on a node (node=root: at
                                    the root) or anywhere
    POST   /experiments             {nodeId|null, title, hypothesis?, params?, results?,
                                    state?} -> a new draft (201), forked from its node
    GET    /experiments/<id>        one experiment
    PATCH  /experiments/<id>        {title?, hypothesis?, params?, results?, status?, state?}
    DELETE /experiments/<id>        soft delete, with its files
    POST   /experiments/runs        {nodeId?, title?, hypothesis?, params?, inputs?,
                                    rerunOf?, provenance?} -> a new run (201) with a report.md
    POST   /experiments/<id>/finish {results, state?: done|failed} -> the finished run
    POST   /experiments/<id>/inputs {inputs: [{path, node?, experiment?, as?}]}
    POST   /experiments/upload      multipart: a "meta" part {id, path, title, ...} and
                                    one part per file -> {experiment, lineage, created,
                                    files} (201)

    GET    /proposals?node=&experiment=&status=   proposals you can see (status:
                                    open (default), accepted, rejected, withdrawn, all)
    POST   /proposals               {experimentId, paths?, note?} -> promote an
                                    experiment's changes (201)
    GET    /proposals/promotable?experiment=<id>  what promoting would propose
    GET    /proposals/<id>          one proposal
    GET    /proposals/<id>/content  its proposed bytes
    POST   /proposals/<id>/accept|reject|withdraw

    GET    /search?q=<text>         {results}: files you can read whose text or path
                                    matches, best first (search.py); &scope=<node id>
                                    only there and below, &near=<node id> or
                                    &experiment=<id> ranks files near there first,
                                    &limit= (at most 50)

    GET    /chats                   {threads, nextCursor}: your chats, most recently
                                    active first; ?agent=<id>, &archived (include
                                    archived ones), &limit= (at most 200), &cursor=
    GET    /chats/<id>              {chat, messages}: one of your chats, with its
                                    messages as of its latest run
    GET    /chats/<id>/runs         {runs}: its runs' AG-UI events, in order
    POST   /chats/<id>/runs         {agentId, runId, parentRunId?, events, messages,
                                    name?} -> the chat (201): saves a finished run,
                                    starting the chat on its first; 403 when the id
                                    is someone else's
    PATCH  /chats/<id>              {name?, archived?}
    DELETE /chats/<id>              for good, with its runs
    Chats are their user's alone (017_chats.sql): workspace owners don't see
    them, and storage tokens can't reach them.

Until the database has the migrations this server knows (db.py applies them
as it starts), these pass through to the TypeScript
server, which answers as it does while storage starts or when it is off.
Paths are read as sent: each segment is percent-decoded on its own, so a %2F
stays inside its segment, as the TypeScript server reads them.
"""

from __future__ import annotations

import asyncio
import json
import logging
import math
import re
from datetime import datetime
from email.utils import format_datetime
from typing import Any
from urllib.parse import unquote

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, Response, StreamingResponse

from . import uploads
from .access import ROLES, AccessError, ForbiddenError
from .chats import ChatError, ChatTakenError
from .experiments import ANYWHERE, ExperimentError, ExperimentExistsError
from .files import FileExistsError_
from .identity import identify
from .nodes import NodeError, NodeNotFoundError
from .paths import (
    InvalidPathError,
    is_text_file,
    js_trim,
    kind_for_path,
    normalize_path,
    utf16_len,
)
from .proposals import EVERYWHERE, ProposalError
from .proxy import forward
from .run_report import js_json, js_number
from .search import SearchError
from .session import Session
from .workspaces import WorkspaceError, resolve

logger = logging.getLogger("api_py")
router = APIRouter()
ALL_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]
MAX_JSON_BYTES = 64 * 1024
_BAD_ESCAPE = re.compile(r"%(?![0-9a-fA-F]{2})")
# The prefixes as sent. Starlette routes on the decoded path, so /%61ccess or
# /access%2Fusers reach these routes too, but the TypeScript server reads the raw
# path and serves those as files. They go to it, so a storage token's limits
# (agent_refusal) always see the section the handlers act on.
_OWN_PATH = re.compile(r"^/(access|nodes|files|experiments|proposals|search|chats)(/|$)")
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


def _js_int(text: str) -> int | float | None:
    """
    A JSON integer as JSON.parse reads it, a double: past 2**53 it is rounded as
    JavaScript rounds it, so what is stored is what the TypeScript server would
    store and what a run's report shows. Too large for a double: null, as
    JSON.stringify writes Infinity.
    """
    if len(text.lstrip("-")) <= 15:
        return int(text)
    value = float(text)
    if math.isinf(value):
        return None
    if abs(value) < 2**53:
        return int(text)
    # The digits JSON.stringify would send on, e.g. 12345678901234567000.
    return value if abs(value) >= 1e21 else int(js_number(value))


def _js_float(text: str) -> float | None:
    value = float(text)
    return None if math.isinf(value) else value


def _refuse(constant: str) -> None:
    raise ValueError(constant)  # NaN and Infinity aren't JSON


def parse_json(text: str) -> Any:
    """JSON.parse: numbers read as JavaScript reads them; ValueError when it isn't JSON."""
    return json.loads(text, parse_constant=_refuse, parse_int=_js_int, parse_float=_js_float)


async def read_json(request: Request) -> dict[str, Any] | None:
    """The JSON object in the body (at most 64 KiB), or None, as readJson() in http.ts."""
    body = await read_body(request, MAX_JSON_BYTES)
    if body is None:
        return None
    try:
        # As TextDecoder reads it: a leading byte order mark dropped.
        value = parse_json(body.decode("utf-8", errors="replace").removeprefix("\ufeff"))
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
    if section == "chats":
        return "Chat history stays with its user: storage tokens can't reach it"
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
            skill = (
                kind_for_path(normalize_path("/".join(decode_component(p) for p in sub.split("/"))))
                == "skill"
            )
        except (_MalformedPath, InvalidPathError):
            return None  # the file route answers bad paths itself
        return "Claude's changes to skills are proposals: add ?propose" if skill else None
    if section == "nodes":
        return None if method == "POST" and sub == "" else "Claude doesn't rename or delete nodes"
    if section == "experiments":
        if method == "POST" and sub == "upload":
            return "Uploading an experiment adds nodes and is its user's own: storage tokens can't use /experiments/upload"
        if method == "POST" and sub in ("", "runs"):
            return None
        if method == "PATCH" and sub != "" and "/" not in sub:
            return None
        if method == "POST" and re.fullmatch(r"[^/]+/(inputs|finish)", sub):
            return None
        return "Claude doesn't delete experiments or move folders into them"
    if section == "proposals":
        return (
            None
            if method == "POST" and sub == ""
            else "Claude doesn't accept, reject or withdraw proposals"
        )
    if section == "access":
        return "Claude doesn't manage access"
    return "Claude can't do that with a storage token"


async def _session(request: Request) -> Session | Response:
    """This request's Session, in its workspace (workspaces.resolve), or the answer when it is refused."""
    state = request.app.state
    storage = state.storage
    principal = await identify(
        request, storage.access, state.settings.auth_secret, storage_tokens=True
    )
    if principal is None:
        return error(401, "Sign in to use the workspace")
    if principal.via:
        refusal = agent_refusal(request)
        if refusal:
            return error(403, refusal)
    try:
        ws, membership = await resolve(
            request, state.workspaces, principal.user_id, principal.bound_ws
        )
    except WorkspaceError as err:
        return error(err.status, str(err))
    here = storage.in_workspace(ws)
    return Session(here, here.access, principal, membership)


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
    except (ForbiddenError, ChatTakenError) as err:
        return error(403, str(err))
    except ExperimentExistsError as err:
        return error(409, str(err), exists=True)
    except FileExistsError_ as err:
        return error(412, str(err), exists=True)
    except (
        NodeError,
        AccessError,
        InvalidPathError,
        ExperimentError,
        ProposalError,
        SearchError,
        ChatError,
    ) as err:
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


def _no_blob_store(request: Request) -> bool:
    """File content needs the blob store; without one here, the TypeScript server answers."""
    return request.app.state.storage.blobs is None


@router.api_route("/files", methods=ALL_METHODS, include_in_schema=False)
@router.api_route("/files/{rest:path}", methods=ALL_METHODS, include_in_schema=False)
async def files_route(request: Request) -> Response:
    return await _serve(request, handle_files, _no_blob_store)


def _experiment_path(request: Request) -> str:
    """What follows /experiments/, decoded as a whole (decodeURIComponent in http.ts)."""
    return decode_component(re.sub(r"^/experiments/?", "", raw_path(request)))


@router.api_route("/experiments", methods=ALL_METHODS, include_in_schema=False)
@router.api_route("/experiments/{rest:path}", methods=ALL_METHODS, include_in_schema=False)
async def experiments_route(request: Request) -> Response:
    return await _serve(request, handle_experiments, _no_blob_store)


@router.api_route("/search", methods=ALL_METHODS, include_in_schema=False)
@router.api_route("/search/{rest:path}", methods=ALL_METHODS, include_in_schema=False)
async def search_route(request: Request) -> Response:
    return await _serve(request, handle_search)


async def handle_search(request: Request, session: Session) -> Response:
    if not re.fullmatch(r"/search/?", raw_path(request)):
        return error(404, "Not found")
    if request.method != "GET":
        return error(405, "Method not allowed")
    limit = parse_int(first_param(request, "limit") or "")
    results = await session.search(
        first_param(request, "q") or "",
        scope=first_param(request, "scope") or None,
        near=first_param(request, "near") or None,
        near_experiment=first_param(request, "experiment") or None,
        limit=limit,
    )
    return json_response(200, {"results": results})


# Chat runs carry tool results and attachments, so they may be large.
MAX_RUN_BYTES = 32 * 1024 * 1024
RUN_SHAPE = "Expected {agentId, runId: string, parentRunId?: string, events, messages: array, name?: string}"


@router.api_route("/chats", methods=ALL_METHODS, include_in_schema=False)
@router.api_route("/chats/{rest:path}", methods=ALL_METHODS, include_in_schema=False)
async def chats_route(request: Request) -> Response:
    return await _serve(request, handle_chats)


def _absent_null_or_string(body: dict[str, Any], key: str) -> bool:
    return body.get(key) is None or isinstance(body[key], str)


async def read_run(request: Request) -> dict[str, Any] | Response:
    """A POST /chats/<id>/runs body, or the answer refusing it."""
    data = await read_body(request, MAX_RUN_BYTES)
    if data is None:
        return error(413, f"A run may be at most {MAX_RUN_BYTES} bytes")
    try:
        # As TextDecoder reads it: a leading byte order mark dropped.
        body = parse_json(data.decode("utf-8", errors="replace").removeprefix("\ufeff"))
    except ValueError:
        body = None
    if (
        not isinstance(body, dict)
        or not isinstance(body.get("agentId"), str)
        or not isinstance(body.get("runId"), str)
        or not isinstance(body.get("events"), list)
        or not isinstance(body.get("messages"), list)
        or not _absent_null_or_string(body, "parentRunId")
        or not _absent_null_or_string(body, "name")
    ):
        return error(400, RUN_SHAPE)
    return body


async def handle_chats(request: Request, session: Session) -> Response:
    parts = raw_path(request).split("/")[2:]  # after /chats
    try:
        chat_id = decode_component(parts[0]) if parts and parts[0] else None
    except _MalformedPath:
        return error(400, "Malformed chat id")
    sub = "/".join(parts[1:])
    method = request.method

    if not chat_id:
        if method != "GET":
            return error(405, "Method not allowed")
        return json_response(
            200,
            await session.chats(
                agent_id=first_param(request, "agent") or None,
                include_archived="archived" in request.query_params,
                limit=parse_int(first_param(request, "limit") or ""),
                cursor=first_param(request, "cursor") or None,
            ),
        )

    if sub == "runs":
        if method == "GET":
            runs = await session.chat_runs(chat_id)
            return (
                json_response(200, {"runs": runs})
                if runs is not None
                else error(404, "Chat not found")
            )
        if method != "POST":
            return error(405, "Method not allowed")
        body = await read_run(request)
        if isinstance(body, Response):
            return body
        run = {
            key: body.get(key)
            for key in ("agentId", "runId", "parentRunId", "events", "messages", "name")
        }
        return json_response(201, await session.append_chat_run(chat_id, run))
    if sub:
        return error(404, "Not found")

    if method == "GET":
        chat = await session.chat(chat_id)
        return json_response(200, chat) if chat else error(404, "Chat not found")
    if method == "PATCH":
        body = await read_json(request)
        if (
            body is None
            or not _absent_null_or_string(body, "name")
            or ("archived" in body and not isinstance(body["archived"], bool))
        ):
            return error(400, "Expected {name?: string, archived?: boolean}")
        changes = {key: body[key] for key in ("name", "archived") if key in body}
        found = await session.update_chat(chat_id, **changes)
        return json_response(200, found) if found else error(404, "Chat not found")
    if method == "DELETE":
        deleted = await session.remove_chat(chat_id)
        return json_response(200, {"deleted": chat_id}) if deleted else error(404, "Chat not found")
    return error(405, "Method not allowed")


@router.api_route("/proposals", methods=ALL_METHODS, include_in_schema=False)
@router.api_route("/proposals/{rest:path}", methods=ALL_METHODS, include_in_schema=False)
async def proposals_route(request: Request) -> Response:
    return await _serve(request, handle_proposals, _no_blob_store)


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
            return json_response(201, await session.create_node(parent_id, body["name"]))  # pyrefly: ignore[bad-argument-type]
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
                return json_response(
                    201,
                    {"id": await session.create_group(parent_id, body["name"])},  # pyrefly: ignore[bad-argument-type]
                )
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
            return json_response(
                200, {"grants": await session.grants(first_param(request, "node") or None)}
            )
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
                    400,
                    'Expected {node: string | null, principalType: "user" | "group", principalId, role}',
                )
            grant_id = await session.set_grant(
                node,  # pyrefly: ignore[bad-argument-type]
                body["principalType"],
                body["principalId"],
                body["role"],
            )
            return json_response(200, {"id": grant_id})
        if ident and method == "DELETE":
            return done(await session.revoke(ident))

    if section == "audit" and not ident and method == "GET":
        limit = parse_int(first_param(request, "limit") or "100")
        kinds = [k for k in request.query_params.getlist("kind") if k]
        return json_response(
            200, {"entries": await session.audit_log(100 if limit is None else limit, kinds)}
        )

    return not_found()


async def handle_files(request: Request, session: Session) -> Response:
    try:
        path = "/".join(
            decode_component(p) for p in re.sub(r"^/files/?", "", raw_path(request)).split("/")
        )
    except _MalformedPath:
        return error(400, "Malformed path encoding")
    method = request.method

    if path == "" and method == "GET" and "watch" in request.query_params:
        return await watch(session)

    experiment = first_param(request, "experiment")
    files = (
        await session.experiment_files(experiment)
        if experiment
        else await session.files(first_param(request, "node") or None)
    )

    if path == "":
        if method != "GET":
            return error(405, "Method not allowed")
        return json_response(200, {"files": await files.list()})

    if method == "GET":
        if "versions" in request.query_params:
            versions = await files.history(path)
            return (
                error(404, "Not found")
                if versions is None
                else json_response(200, {"versions": versions})
            )
        # Binary files come straight from the object store when it is reachable
        # from browsers: a short-lived link, made after the access check above.
        # Text stays here, since the UI fetches it from this origin.
        info = await files.stat(path)
        if info and not is_text_file(info["path"], info["mime"]):
            link = await session.storage.require_blobs().download_url(
                info["sha256"], info["mime"], info["path"].split("/")[-1]
            )
            if link:
                return Response(
                    status_code=302, headers={"Location": link, "Cache-Control": "no-store"}
                )
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
        if "propose" in request.query_params:
            if experiment:
                return error(
                    400, "An experiment's files change directly; promote it to propose them"
                )
            note = first_param(request, "note")
            return json_response(
                201, await session.propose(files.node_id, path, content, mime=mime, note=note)
            )
        create_only = js_trim(request.headers.get("if-none-match", "")) == "*"
        return json_response(
            200, await files.write(path, content, mime=mime, create_only=create_only)
        )

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


EXPERIMENT_EXPECTED = (
    "Expected {title?, hypothesis?: string, params?, results?: object, status?: draft|shared|archived, "
    "state?: ready|running|done|failed}"
)
# Sharing or archiving an experiment changes who sees it: the user's call, not
# an outside service's, so storage tokens (principal.via) leave status alone.
STATUS_REFUSED = (
    "Claude doesn't share or archive experiments with a storage token: leave out status"
)
INPUTS_EXPECTED = (
    "Expected {inputs: [{path: string, node?: string|null, experiment?: string|null, as?: string}]}"
)
# Most a run's caller-given provenance may hold, as JSON.
MAX_PROVENANCE_BYTES = 16 * 1024
RUN_EXPECTED = (
    "Expected {nodeId?: string|null, title?: string, hypothesis?: string, params?: object, "
    "inputs?: [{path, node?, experiment?, as?}], rerunOf?: string, provenance?: {chat?: string, model?: string, "
    "skill?: {name, source?, version?: number, sha256?}, tools?: {[name]: version}, ...}}"
)
# Provenance only the server writes: who started it and when, its inputs, its source run, when it finished.
SERVER_PROVENANCE = ("startedBy", "startedAt", "finishedAt", "inputs", "rerunOf")
# A run request with no nodeId: rerun in the earlier run's place.
_NOT_GIVEN = object()


def experiment_input(body: dict[str, Any]) -> dict[str, Any] | None:
    """The experiment fields in a request body, in the order http.ts reads them; None when one has the wrong type."""
    given: dict[str, Any] = {}
    for key in ("title", "hypothesis", "status", "state"):
        if key not in body:
            continue
        if not isinstance(body[key], str):
            return None
        given[key] = body[key]
    for key in ("params", "results"):
        if key in body:
            given[key] = body[key]
    return given


def refuses_status(session: Session, given: dict[str, Any]) -> bool:
    return bool(session.principal.via) and "status" in given and given["status"] != "draft"


def _string_or_null(value: Any) -> bool:
    return value is None or isinstance(value, str)


def run_inputs(value: Any) -> list[dict[str, Any]] | None:
    """A list of run inputs from a request body, or None when it isn't one."""
    if not isinstance(value, list):
        return None
    out = []
    for item in value:
        if not isinstance(item, dict):
            return None
        path, node, experiment = item.get("path"), item.get("node"), item.get("experiment")
        if (
            not isinstance(path, str)
            or not _string_or_null(node)
            or not _string_or_null(experiment)
            or ("as" in item and not isinstance(item["as"], str))
        ):
            return None
        entry = {"path": path, "node": node, "experiment": experiment}
        if "as" in item:
            entry["as"] = item["as"]
        out.append(entry)
    return out


def _absent_or(value: dict[str, Any], key: str, kind: type | tuple[type, ...]) -> bool:
    """Absent, or of `kind` (null isn't; a boolean isn't a number)."""
    if key not in value:
        return True
    found = value[key]
    return isinstance(found, kind) and not (kind is not str and isinstance(found, bool))


def caller_provenance(provenance: dict[str, Any]) -> dict[str, Any] | None:
    """
    What a caller says about its run, without the server's own keys, or None
    when a field the run panel shows (chat, model, skill, tools) has another
    shape than it reads. Other keys are kept as they are.
    """
    kept = {key: value for key, value in provenance.items() if key not in SERVER_PROVENANCE}
    chat, model, skill, tools = (kept.get(key) for key in ("chat", "model", "skill", "tools"))
    if not _string_or_null(chat) or not _string_or_null(model):
        return None
    if skill is not None and not (
        isinstance(skill, dict)
        and isinstance(skill.get("name"), str)
        and _absent_or(skill, "source", str)
        and _absent_or(skill, "version", (int, float))
        and _absent_or(skill, "sha256", str)
    ):
        return None
    if tools is not None and not (
        isinstance(tools, dict) and all(isinstance(v, str) for v in tools.values())
    ):
        return None
    return kept


def run_request(body: dict[str, Any]) -> dict[str, Any] | None:
    """A POST /experiments/runs body, or None when it isn't one."""
    rest = {k: v for k, v in body.items() if k not in ("nodeId", "inputs", "rerunOf", "provenance")}
    node_id = body.get("nodeId", _NOT_GIVEN)
    if node_id is not _NOT_GIVEN and not _string_or_null(node_id):
        return None
    rerun_of = body.get("rerunOf")
    if "rerunOf" in body and not isinstance(rerun_of, str):
        return None
    provenance = body.get("provenance", {})
    if not isinstance(provenance, dict) or utf16_len(js_json(provenance)) > MAX_PROVENANCE_BYTES:
        return None
    given = caller_provenance(provenance)
    if given is None:
        return None
    inputs = None
    if "inputs" in body:
        inputs = run_inputs(body["inputs"])
        if inputs is None:
            return None
    # A run starts running, as a draft; finish it with /finish, share it in the app.
    if any(key in rest for key in ("results", "status", "state")):
        return None
    if "params" in rest and not isinstance(rest["params"], dict):
        return None
    fields = experiment_input(rest)
    if fields is None:
        return None
    return {
        "nodeId": node_id,
        "inputs": inputs,
        "rerunOf": rerun_of,
        "provenance": given,
        "input": fields,
    }


UPLOAD_META = (
    'Expected a "meta" part with {id: uuid, path: "Tech/Module/Loop/Process" | string[], title: string, '
    "hypothesis?: string, params?, results?: object, state?: ready|running|done|failed}"
)


async def read_upload(request: Request) -> dict[str, Any]:
    """
    The parts of a POST /experiments/upload (readUpload in http.ts): its "meta"
    JSON and its files, each named by its field. The form is read whole before
    anything is written, so a broken upload changes nothing.
    """
    content_type = request.headers.get("content-type", "")
    if not re.match(r"multipart/form-data\s*;", content_type, re.IGNORECASE):
        raise uploads.UploadError(
            415, 'Send the experiment as multipart/form-data: a "meta" part and one part per file'
        )
    found = await uploads.read_parts(
        content_type, request.stream(), request.app.state.settings.max_upload_bytes
    )
    meta: Any = None
    if found.meta is not None:
        try:
            meta = parse_json(found.meta)
        except ValueError as err:
            raise uploads.UploadError(400, f'The "meta" part isn\'t JSON. {UPLOAD_META}') from err
    if not isinstance(meta, dict):
        raise uploads.UploadError(400, UPLOAD_META)
    path = meta.get("path")
    if isinstance(path, str):
        names: list[str] | None = path.split("/")
    elif isinstance(path, list) and all(p is None or isinstance(p, str) for p in path):
        names = ["" if p is None else p for p in path]
    else:
        names = None
    given = experiment_input(meta)
    if (
        not isinstance(meta.get("id"), str)
        or names is None
        or given is None
        or not isinstance(meta.get("title"), str)
    ):
        raise uploads.UploadError(400, UPLOAD_META)
    return {"id": meta["id"], "path": names, "input": given, "files": found.files}


async def handle_experiments(request: Request, session: Session) -> Response:
    experiment_id = _experiment_path(request)
    method = request.method
    if not experiment_id:
        if method == "GET":
            node = first_param(request, "node")
            where = None if node == "root" else node or ANYWHERE
            return json_response(200, {"experiments": await session.experiments(where)})
        if method == "POST":
            body = await read_json(request)
            given = experiment_input(body) if body is not None else None
            if (
                body is None
                or "nodeId" not in body
                or not _string_or_null(body["nodeId"])
                or given is None
            ):
                return error(
                    400,
                    f"Expected {{nodeId: string|null, title: string, …}}; {EXPERIMENT_EXPECTED}",
                )
            if refuses_status(session, given):
                return error(403, STATUS_REFUSED)
            return json_response(201, await session.create_experiment(body["nodeId"], given))
        return error(405, "Method not allowed")

    if experiment_id == "upload":
        if method != "POST":
            return error(405, "Method not allowed")
        try:
            upload = await read_upload(request)
        except uploads.UploadError as err:
            return error(err.status, str(err))
        # Like POST /experiments: a new experiment is a draft whatever status says.
        return json_response(
            201,
            await session.upload_experiment(
                upload["id"], upload["path"], upload["input"], upload["files"]
            ),
        )

    if experiment_id == "runs":
        if method != "POST":
            return error(405, "Method not allowed")
        body = await read_json(request)
        run = run_request(body) if body is not None else None
        if run is None:
            return error(400, RUN_EXPECTED)
        if run["rerunOf"]:
            place = {} if run["nodeId"] is _NOT_GIVEN else {"node_id": run["nodeId"]}
            rerun = await session.rerun(
                run["rerunOf"], run["input"], run["inputs"], provenance=run["provenance"], **place
            )
            return json_response(201, rerun)
        if not run["input"].get("title"):
            return error(400, "A new run needs a title (or rerunOf)")
        node_id = None if run["nodeId"] is _NOT_GIVEN else run["nodeId"]
        return json_response(
            201, await session.start_run(node_id, run["input"], run["inputs"], run["provenance"])
        )

    finish_of = re.fullmatch(r"([^/]+)/finish", experiment_id)
    if finish_of:
        if method != "POST":
            return error(405, "Method not allowed")
        body = await read_json(request)
        results = body.get("results") if body else None
        state = body.get("state") if body else None
        state = "done" if state is None else state
        if not isinstance(results, dict) or state not in ("done", "failed"):
            return error(400, "Expected {results: object, state?: done|failed}")
        return json_response(200, await session.finish_run(finish_of.group(1), results, state))

    inputs_of = re.fullmatch(r"([^/]+)/inputs", experiment_id)
    if inputs_of:
        if method != "POST":
            return error(405, "Method not allowed")
        body = await read_json(request)
        inputs = run_inputs(body.get("inputs")) if body is not None else None
        if inputs is None:
            return error(400, INPUTS_EXPECTED)
        return json_response(200, await session.add_run_inputs(inputs_of.group(1), inputs))

    if method == "GET":
        return json_response(200, await session.experiment(experiment_id))
    if method == "PATCH":
        body = await read_json(request)
        given = experiment_input(body) if body is not None else None
        if given is None:
            return error(400, EXPERIMENT_EXPECTED)
        # Any status change: back to draft from archived would make it writable again.
        if session.principal.via and "status" in given:
            return error(403, STATUS_REFUSED)
        return json_response(200, await session.update_experiment(experiment_id, given))
    if method == "DELETE":
        if await session.delete_experiment(experiment_id):
            return json_response(200, {"deleted": experiment_id})
        return error(404, "Experiment not found")
    return error(405, "Method not allowed")


PROPOSAL_STATUSES = ("open", "accepted", "rejected", "withdrawn", "all")
DECISIONS = ("accept", "reject", "withdraw")


async def handle_proposals(request: Request, session: Session) -> Response:
    parts = [decode_component(p) for p in raw_path(request).split("/")[2:]]  # after /proposals
    proposal_id = parts[0] if parts else ""
    action = parts[1] if len(parts) > 1 else ""
    method = request.method

    if not proposal_id:
        if method == "GET":
            node = first_param(request, "node")
            status = first_param(request, "status")
            status = "open" if status is None else status
            if status not in PROPOSAL_STATUSES:
                return error(400, f"status must be one of {', '.join(PROPOSAL_STATUSES)}")
            where = EVERYWHERE if node is None else None if node in ("root", "") else node
            experiment = first_param(request, "experiment") or None
            found = await session.proposals(node=where, experiment=experiment, status=status)
            return json_response(200, {"proposals": found})
        if method == "POST":
            body = await read_json(request)
            paths = body.get("paths") if body else None
            if (
                body is None
                or not isinstance(body.get("experimentId"), str)
                or (
                    "paths" in body
                    and not (isinstance(paths, list) and all(isinstance(p, str) for p in paths))
                )
                or ("note" in body and not isinstance(body["note"], str))
            ):
                return error(
                    400, "Expected {experimentId: string, paths?: string[], note?: string}"
                )
            promoted = await session.promote(body["experimentId"], paths, body.get("note"))
            return json_response(201, {"proposals": promoted})
        return error(405, "Method not allowed")

    if proposal_id == "promotable" and not action:
        if method != "GET":
            return error(405, "Method not allowed")
        experiment = first_param(request, "experiment")
        if not experiment:
            return error(400, "Expected ?experiment=<id>")
        return json_response(200, {"files": await session.promotable(experiment)})

    if not action:
        if method != "GET":
            return error(405, "Method not allowed")
        return json_response(200, await session.proposal(proposal_id))
    if action == "content":
        if method != "GET":
            return error(405, "Method not allowed")
        proposal, content = await session.proposal_content(proposal_id)
        return Response(
            content,
            headers={
                "Content-Type": proposal["mime"],
                "Cache-Control": "no-cache",
                **STORED_CONTENT_HEADERS,
            },
        )
    if action in DECISIONS:
        if method != "POST":
            return error(405, "Method not allowed")
        return json_response(200, await session.decide(proposal_id, action))
    return error(404, "Not found")


async def watch(session: Session) -> Response:
    """
    The changes this principal may see in the session's workspace, as server-sent
    events, in order: each is checked before the next, membership first. Subscribes before answering, so a failure still
    gets a normal error answer.
    """
    queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
    unsubscribe = await session.storage.require_events().subscribe(session.ws, queue.put_nowait)

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
                    # Membership first: once it's gone, so is the stream (docs/workspaces.md).
                    if not await session.still_member():
                        return
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
