"""Personalized memory (#190, steps 8a to 8c), as apps/agent/src/memory/http.ts serves it.

    GET    /memory?thread=&node=         {mode, incognito, notes, inbox, shared,
                                         sharedProposals, targets, installs, types,
                                         limits}: the overview
    PUT    /memory/settings              {mode?: on | ask | off, thread?, incognito?}
    GET    /memory/activity              Claude's recent changes, newest first
    POST   /memory/inbox/<id>/accept     makes a proposed change (409 when the note
                                         changed since)
    POST   /memory/inbox/<id>/reject     drops it
    GET    /memory/export                every note as memory/<name>.md, zipped
    GET    /memory/notes/<name>          {note, versions}
    PUT    /memory/notes/<name>          {description, type, body} creates or replaces
                                         it (as yours; ?create=1 refuses a name in use)
    DELETE /memory/notes/<name>          deletes it for good, with its versions
    POST   /memory/notes/<name>/restore  {version} makes that version current
    POST   /memory/notes/<name>/archive  {archived} archives or brings it back
    POST   /memory/events/<id>/undo      undoes one of Claude's changes

    POST   /memory/shared                {scope, nodeId?, groupId?, name, description,
                                         type, body}: shares a copy there; {note} where
                                         you edit, else {proposal} for its editors
    GET    /memory/shared/<id>           {note, versions}
    PUT    /memory/shared/<id>           {description, type, body, version?} (editors)
    DELETE /memory/shared/<id>           deletes it for good (editors)
    PUT    /memory/shared/<id>/mode      {mode: auto | manual | off | null, everyone?}
    POST   /memory/shared/proposals/<id>/accept | reject | withdraw

    GET    /memory/packs?q=              {packs, isAdmin}: the hub's memory packs
    GET    /memory/packs/<name>?version= {pack}
    POST   /memory/packs                 {scope, nodeId?, groupId?, name, description}
    POST   /memory/packs/<name>/install  {scope, nodeId?, groupId?, version?}
    POST   /memory/packs/<name>/verify   {version, verified} (hub admins)
    POST   /memory/packs/<name>/yank     {version, yanked, reason?}
    DELETE /memory/installs/<id>         uninstalls it, with its notes (editors)
    POST   /memory/installs/<id>/fork    makes its notes the place's own

    POST   /memory/import                {text, label?} (pasted memory or a .md file)
                                         or a raw application/zip body (an export):
                                         {proposed, skipped, how}, all in the inbox

A user's own notes are theirs alone; shared notes follow the grants
(shared_memory_rank). These are served here only with MEMORY=on (as on the
TypeScript server) once storage is ready.

    GET    /memory/agent                 {prompt, tools}, and
    POST   /memory/agent/tools/<name>    for a remote backend's run (memory_agent.py)

/memory/agent is served here only for a memory token `via` "remote"; outside
MCP servers' tokens, and missing or bad ones, pass through to the TypeScript
server.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import Response

from . import chats, memory_agent
from .access import Principal
from .identity import MemoryGrant, identify, memory_claims, memory_grant
from .llm import CreateMessage
from .memory import (
    INDEX_CHARS,
    MAX_BODY,
    MAX_DESCRIPTION,
    MAX_NOTES,
    MEMORY_TYPES,
    MemoryConflictError,
    MemoryError_,
    MemoryNotFoundError,
    MemoryService,
)
from .memory_agent import REMOTE_VIA
from .memory_import import import_memory
from .memory_packs import MemoryPackHub
from .proxy import forward
from .run_report import js_json
from .session import Session
from .shared_memory import SharedMemoryService
from .skills import parse_admins
from .skills_routes import js_to_number
from .storage_routes import (
    ALL_METHODS,
    _MalformedPath,
    decode_component,
    first_param,
    parse_json,
    raw_path,
    read_body,
)
from .text_index import from_units, to_units

logger = logging.getLogger("api_py")
router = APIRouter()
_OWN_PATH = re.compile(r"^/memory(/|$)")
_AGENT_PATH = re.compile(r"^/memory/agent(/|$)")
# The sections served here; the others go to the TypeScript server.
OWN_SECTIONS = (
    "settings",
    "activity",
    "inbox",
    "export",
    "notes",
    "events",
    "shared",
    "packs",
    "installs",
    "import",
)
MAX_JSON_BYTES = 64 * 1024
# An import's body at most: a pasted memory, a file or a .zip export.
MAX_IMPORT_BYTES = 2 * 1024 * 1024


def send(status: int, body: Any) -> Response:
    return Response(
        js_json(body),
        status_code=status,
        media_type="application/json",
        headers={"Cache-Control": "no-store"},
    )


async def read_json(request: Request, limit: int = MAX_JSON_BYTES) -> dict[str, Any] | None:
    """The JSON object in the body (at most `limit` bytes, empty: {}), or None, as json() in http.ts."""
    data = await read_body(request, limit)
    if data is None:
        return None
    try:
        # Buffer.toString keeps a byte order mark, which JSON.parse refuses.
        value = parse_json(data.decode("utf-8", errors="replace") or "{}")
    except ValueError:
        return None
    return value if isinstance(value, dict) else None


def _parts(path: str) -> list[str] | None:
    """The path's segments after /memory, decoded; None when one has a malformed escape."""
    try:
        return [decode_component(p) for p in path[len("/memory") :].split("/") if p]
    except _MalformedPath:
        return None


def _served_here(request: Request) -> bool:
    path = raw_path(request)
    if not _OWN_PATH.match(path):
        return False
    parts = _parts(path)
    return parts is not None and (not parts or parts[0] in OWN_SECTIONS)


@router.api_route("/memory", methods=ALL_METHODS, include_in_schema=False)
@router.api_route("/memory/{rest:path}", methods=ALL_METHODS, include_in_schema=False)
async def memory_route(request: Request) -> Response:
    state = request.app.state
    secret = state.settings.auth_secret
    agent = _AGENT_PATH.match(raw_path(request)) is not None
    claims = memory_claims(request, secret) if agent else None
    # A remote backend's run is served here; outside MCP servers' tokens (and
    # bad ones, for the TypeScript server's 401) go through.
    here = claims is not None and claims["via"] == REMOTE_VIA if agent else _served_here(request)
    if not state.settings.memory or not here or not await state.storage_ready():
        return await forward(request, state.http)
    storage = state.storage
    try:
        if claims is not None:
            return await _agent(
                request, storage, await memory_grant(storage.access, secret, claims)
            )
        principal = await identify(request, storage.access, secret)
        if principal is None:
            return send(401, {"error": "Sign in first"})
        parts = _parts(raw_path(request)) or []
        if len(parts) > (4 if parts and parts[0] == "shared" else 3):
            return send(404, {"error": "Not found"})
        session = Session(storage, storage.access, principal)
        user = principal.user_id
        memory = Memory(
            own=MemoryService(session.scoped, session.ws, user),
            shared=SharedMemoryService(session.scoped, storage.pool, session.ws, user),
            packs=MemoryPackHub(storage.pool, session.ws, parse_admins(state.settings.hub_admins)),
            user=user,
            create_message=state.create_message,
        )
        return await _route(request, memory, parts)
    except MemoryError_ as err:
        return send(400, {"error": str(err)})
    except MemoryNotFoundError as err:
        return send(404, {"error": str(err)})
    except MemoryConflictError as err:
        return send(409, {"error": str(err)})
    except Exception:
        logger.exception("[memory] request failed")
        return send(500, {"error": "Memory request failed"})


async def _agent(request: Request, storage: Any, grant: MemoryGrant) -> Response:
    """/memory/agent for a remote backend's run (memory_agent.py)."""
    session = Session(
        storage, storage.access, Principal(user_id=grant.user_id, actor="agent", via=grant.via)
    )
    user = grant.user_id

    async def search_chats(query: str, exclude: str | None, limit: int | None) -> list:
        async with session.scoped() as conn:
            return await chats.search_chats(conn, session.ws, user, query, exclude, limit)

    async def read_chat(chat_id: str) -> dict[str, Any] | None:
        async with session.scoped() as conn:
            return await chats.chat_lines_of(conn, session.ws, user, chat_id)

    given = memory_agent.AgentRequest(
        service=MemoryService(session.scoped, session.ws, user),
        shared_service=SharedMemoryService(session.scoped, storage.pool, session.ws, user),
        thread=grant.thread,
        via=grant.via,
        node=grant.node,
        recall=memory_agent.recall_for(storage.semantic),
        search_chats=search_chats,
        read_chat=read_chat,
    )
    return await memory_agent.serve(request, raw_path(request), given, read_json)


@dataclass
class Memory:
    own: MemoryService
    shared: SharedMemoryService
    packs: MemoryPackHub
    user: str
    create_message: CreateMessage


def _int4(value: float) -> bool:
    return -(2**31) <= value < 2**31


def _number(value: Any) -> float:
    """Number(value) for a JSON value (null is 0)."""
    return 0.0 if value is None else js_to_number(value)


def _db_int(value: float) -> int:
    """A whole number for a query; one Postgres can't take as an integer fails there, as from the TypeScript server."""
    if not _int4(value):
        raise OverflowError(f"{value} is out of range for an integer")
    return int(value)


def _given_version(given: dict[str, Any]) -> float | None:
    """input.version === undefined ? undefined : Number(input.version)."""
    return None if "version" not in given else _number(given["version"])


async def _route(request: Request, m: Memory, parts: list[str]) -> Response:
    method = request.method
    memory = m.own
    section, name, action = (parts + [None, None, None])[:3]
    if method == "GET" and not section:
        thread = first_param(request, "thread")
        settings = await memory.settings(thread)
        notes = await memory.list()
        inbox = await memory.inbox()
        shared = await m.shared.list()
        proposals = await m.shared.proposals()
        targets = await m.shared.targets(first_param(request, "node"))
        installs = await m.packs.installs(m.user)
        return send(
            200,
            {
                **settings,
                "notes": notes,
                "inbox": inbox,
                "shared": shared,
                "sharedProposals": proposals,
                "targets": targets,
                "installs": installs,
                "types": list(MEMORY_TYPES),
                "limits": {
                    "notes": MAX_NOTES,
                    "body": MAX_BODY,
                    "description": MAX_DESCRIPTION,
                    "index": INDEX_CHARS,
                },
            },
        )
    if method == "PUT" and section == "settings" and not name:
        given = await read_json(request)
        if given is None:
            return send(400, {"error": "Invalid JSON body"})
        if "mode" in given:
            await memory.set_mode(given["mode"])
        if "incognito" in given:
            await memory.set_incognito(given.get("thread"), given["incognito"] is True)
        thread = given.get("thread")
        return send(200, await memory.settings(thread if isinstance(thread, str) else None))
    if method == "GET" and section == "activity" and not name:
        return send(200, {"activity": await memory.activity()})
    if method == "POST" and section == "inbox" and name and action in ("accept", "reject"):
        if action == "reject":
            await memory.reject(name)
            return send(200, {"id": name, "status": "rejected"})
        note, _event = await memory.accept(name)
        return send(200, {"id": name, "status": "accepted", "note": note})
    if method == "GET" and section == "export" and not name:
        return Response(
            await memory.export_zip(),
            status_code=200,
            headers={
                "Content-Type": "application/zip",
                "Content-Disposition": 'attachment; filename="memory.zip"',
                "Cache-Control": "no-store",
            },
        )
    if section == "notes" and name and not action:
        if method == "GET":
            note = await memory.get(name)
            if not note:
                raise MemoryNotFoundError(name)
            return send(200, {"note": note, "versions": await memory.versions(name)})
        if method == "PUT":
            given = await read_json(request)
            if given is None:
                return send(400, {"error": "Invalid JSON body"})
            create = first_param(request, "create") in ("1", "true")
            note, _event = await memory.save(name, given, "user", create=create)
            return send(200, {"note": note})
        if method == "DELETE":
            if not await memory.remove(name):
                raise MemoryNotFoundError(name)
            return send(200, {"name": name, "deleted": True})
    if method == "POST" and section == "notes" and name and action in ("restore", "archive"):
        given = await read_json(request)
        if given is None:
            return send(400, {"error": "Invalid JSON body"})
        if action == "archive":
            note, _event = await memory.archive(name, given.get("archived") is not False)
            return send(200, {"note": note})
        version = _number(given["version"]) if "version" in given else float("nan")
        if not version.is_integer() or version < 1:
            return send(400, {"error": "Say which version"})
        return send(200, {"note": await memory.restore(name, _db_int(version))})
    if section == "shared":
        return await _shared(request, m.shared, parts[1:])
    if method == "POST" and section == "import" and not name:
        return await _import(request, m)
    if section == "packs":
        return await _packs(request, m, parts[1:])
    if section == "installs" and name:
        if method == "DELETE" and not action:
            await m.packs.uninstall(m.user, name)
            return send(200, {"id": name, "deleted": True})
        if method == "POST" and action == "fork":
            return send(200, {"id": name, **(await m.packs.fork(m.user, name))})
    if method == "POST" and section == "events" and name and action == "undo":
        return send(200, await memory.undo(name))
    return _refused(method)


async def _import(request: Request, m: Memory) -> Response:
    if (request.headers.get("content-type") or "").startswith("application/zip"):
        data = await read_body(request, MAX_IMPORT_BYTES)
        if data is None:
            return send(413, {"error": "That file is too big to import (2 MB at most)"})
        return send(200, await import_memory(m.own, m.create_message, zip_bytes=data))
    given = await read_json(request, MAX_IMPORT_BYTES)
    if given is None:
        return send(400, {"error": "Invalid JSON body (2 MB at most)"})
    label = given.get("label")
    text = given.get("text")
    return send(
        200,
        await import_memory(
            m.own,
            m.create_message,
            text=text if isinstance(text, str) else "",
            label=from_units(to_units(label)[:100]) if isinstance(label, str) else None,
        ),
    )


def _refused(method: str) -> Response:
    if method == "GET":
        return send(404, {"error": "Not found"})
    return send(405, {"error": "Method not allowed"})


async def _shared(request: Request, shared: SharedMemoryService, parts: list[str]) -> Response:
    method = request.method
    note_id, action, decision = (parts + [None, None, None])[:3]
    if method == "POST" and not note_id:
        given = await read_json(request)
        if given is None:
            return send(400, {"error": "Invalid JSON body"})
        return send(200, await shared.share(given, given.get("name"), given))
    if (
        method == "POST"
        and note_id == "proposals"
        and action
        and len(parts) < 4
        and decision in ("accept", "reject", "withdraw")
    ):
        return send(
            200, {"id": action, "status": decision, **(await shared.decide(action, decision))}
        )
    if note_id and note_id != "proposals" and not action:
        if method == "GET":
            note = await shared.get(note_id)
            return send(200, {"note": note, "versions": await shared.versions(note_id)})
        if method == "PUT":
            given = await read_json(request)
            if given is None:
                return send(400, {"error": "Invalid JSON body"})
            version = _given_version(given)
            if version is not None and not version.is_integer():
                return send(400, {"error": "version is a number"})
            return send(
                200,
                {
                    "note": await shared.update(
                        note_id, given, None if version is None else int(version)
                    )
                },
            )
        if method == "DELETE":
            await shared.remove(note_id)
            return send(200, {"id": note_id, "deleted": True})
    if method == "PUT" and note_id and action == "mode" and not decision:
        given = await read_json(request)
        if given is None:
            return send(400, {"error": "Invalid JSON body"})
        return send(
            200,
            {
                "note": await shared.set_mode(
                    note_id, given.get("mode"), given.get("everyone") is True
                )
            },
        )
    return _refused(method)


async def _packs(request: Request, m: Memory, parts: list[str]) -> Response:
    method = request.method
    hub = m.packs
    name, action = (parts + [None, None])[:2]
    if method == "GET" and not name:
        return send(200, await hub.list(m.user, first_param(request, "q") or ""))
    if method == "GET" and name and not action:
        given = first_param(request, "version")
        version = js_to_number(given) if given else None
        if version is not None and not version.is_integer():
            return send(400, {"error": "version is a number"})
        return send(
            200, {"pack": await hub.detail(m.user, name, None if version is None else int(version))}
        )
    if method != "POST":
        return send(405, {"error": "Method not allowed"})
    body = await read_json(request)
    if body is None:
        return send(400, {"error": "Invalid JSON body"})
    if not name:
        return send(200, await hub.publish(m.user, body, body.get("name"), body.get("description")))
    version = _given_version(body)
    if version is not None and not version.is_integer():
        return send(400, {"error": "version is a number"})
    if action == "install":
        chosen = None if version is None else _db_int(version)
        return send(200, {"install": await hub.install(m.user, body, name, chosen)})
    if version is None:
        return send(400, {"error": "Say which version"})
    if action == "verify":
        await hub.verify(m.user, name, _db_int(version), body.get("verified") is not False)
        return send(200, {"pack": await hub.detail(m.user, name, int(version))})
    if action == "yank":
        await hub.yank(
            m.user, name, _db_int(version), body.get("yanked") is not False, body.get("reason")
        )
        return send(200, {"pack": await hub.detail(m.user, name, int(version))})
    return send(404, {"error": "Not found"})
