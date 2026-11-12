"""Each user's own memory notes (#190, step 8a), as apps/agent/src/memory/http.ts serves them.

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

Everything is the signed-in user's own: nobody reads another's notes. These
are served here only with MEMORY=on (as on the TypeScript server) once storage
is ready. The rest of /memory (the overview at GET /memory, shared notes,
packs, import and /memory/agent) still passes through to the TypeScript server
until the later parts of step 8.
"""

from __future__ import annotations

import logging
import re
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import Response

from .identity import identify
from .memory import MemoryConflictError, MemoryError_, MemoryNotFoundError, MemoryService
from .proxy import forward
from .run_report import js_json
from .session import Session
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

logger = logging.getLogger("api_py")
router = APIRouter()
_OWN_PATH = re.compile(r"^/memory(/|$)")
# The sections served here; the others go to the TypeScript server.
OWN_SECTIONS = ("settings", "activity", "inbox", "export", "notes", "events")
MAX_JSON_BYTES = 64 * 1024


def send(status: int, body: Any) -> Response:
    return Response(
        js_json(body),
        status_code=status,
        media_type="application/json",
        headers={"Cache-Control": "no-store"},
    )


async def read_json(request: Request) -> dict[str, Any] | None:
    """The JSON object in the body (at most 64 KiB, empty: {}), or None, as json() in http.ts."""
    data = await read_body(request, MAX_JSON_BYTES)
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
    return bool(parts) and parts[0] in OWN_SECTIONS  # type: ignore[index]


@router.api_route("/memory", methods=ALL_METHODS, include_in_schema=False)
@router.api_route("/memory/{rest:path}", methods=ALL_METHODS, include_in_schema=False)
async def memory_route(request: Request) -> Response:
    state = request.app.state
    if not state.settings.memory or not _served_here(request) or not await state.storage_ready():
        return await forward(request, state.http)
    storage = state.storage
    try:
        principal = await identify(request, storage.access, state.settings.auth_secret)
        if principal is None:
            return send(401, {"error": "Sign in first"})
        parts = _parts(raw_path(request)) or []
        if len(parts) > 3:
            return send(404, {"error": "Not found"})
        session = Session(storage, storage.access, principal)
        memory = MemoryService(session.scoped, session.ws, principal.user_id)
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


def _int4(value: float) -> bool:
    return -(2**31) <= value < 2**31


async def _route(request: Request, memory: MemoryService, parts: list[str]) -> Response:
    method = request.method
    section, name, action = (parts + [None, None, None])[:3]
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
        version = js_to_number(given["version"]) if "version" in given else float("nan")
        if not version.is_integer() or version < 1:
            return send(400, {"error": "Say which version"})
        if not _int4(version):
            # Postgres refuses it as an integer, as it does from the TypeScript server.
            raise OverflowError(f"version {version} is out of range")
        return send(200, {"note": await memory.restore(name, int(version))})
    if method == "POST" and section == "events" and name and action == "undo":
        return send(200, await memory.undo(name))
    if method == "GET":
        return send(404, {"error": "Not found"})
    return send(405, {"error": "Method not allowed"})
