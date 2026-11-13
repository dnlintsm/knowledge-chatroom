"""The agent server's own routes besides the chat (issue #190, step 9), as apps/agent/src/server.ts answers them.

- `GET /identity/public-key`: the Ed25519 key outside services verify identity
  and storage tokens with (docs/remote-agent.md).
- `POST /identity/mcp-tokens`: a remote backend's tokens for its MCP servers
  (mcp_tokens.py).
- `POST /suggest`: the chat's follow-up chips (suggest.py).

They need no storage. Only these exact paths and methods are served here;
anything else under them goes on to the TypeScript server, which answers it
as before (404, or its chat for `POST /`).
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import Response

from . import tokens
from .mcp_tokens import MAX_BODY_BYTES, mcp_tokens
from .proxy import forward
from .run_report import js_json, js_order
from .storage_routes import ALL_METHODS, parse_json, raw_path
from .suggest import AGUI_MEDIA_TYPE, accepts_protobuf, encode_sse, suggest

router = APIRouter()


def _send(status: int, body: Any, headers: dict[str, str] | None = None) -> Response:
    return Response(
        js_json(body), status_code=status, media_type="application/json", headers=headers
    )


def _header(request: Request, name: str) -> str | None:
    """A header as Node gives it: repeated ones joined with ", "."""
    values = request.headers.getlist(name)
    return ", ".join(values) if values else None


def _parse(text: str) -> Any:
    """JSON.parse, with objects' keys in JavaScript's order; ValueError when it isn't JSON."""
    return js_order(parse_json(text))


@router.api_route("/identity/public-key", methods=ALL_METHODS, include_in_schema=False)
async def public_key_route(request: Request) -> Response:
    if request.method != "GET" or raw_path(request) != "/identity/public-key":
        return await forward(request, request.app.state.http)
    secret: str | None = request.app.state.settings.auth_secret
    if not secret:
        return _send(404, {"error": "Login is off: there are no identity tokens."})
    return _send(200, {"alg": "Ed25519", "key": tokens.public_key(secret)})


@router.api_route("/identity/mcp-tokens", methods=ALL_METHODS, include_in_schema=False)
async def mcp_tokens_route(request: Request) -> Response:
    if raw_path(request) != "/identity/mcp-tokens":
        return await forward(request, request.app.state.http)
    status, body = 405, {"error": "Method not allowed"}
    if request.method == "POST":
        # The whole body is read, but over 16 KiB it is no request at all.
        chunks: list[bytes] = []
        size = 0
        async for chunk in request.stream():
            size += len(chunk)
            if size <= MAX_BODY_BYTES:
                chunks.append(chunk)
        given: Any = None
        if size <= MAX_BODY_BYTES:
            try:
                given = _parse(b"".join(chunks).decode("utf-8", errors="replace") or "null")
            except ValueError:
                given = None
        headers = {
            name: value
            for name in (tokens.STORAGE_HEADER, tokens.MEMORY_HEADER)
            if (value := _header(request, name)) is not None
        }
        status, body = mcp_tokens(headers, given, request.app.state.settings.auth_secret)
    return _send(status, body, {"Cache-Control": "no-store"})


@router.api_route("/suggest", methods=ALL_METHODS, include_in_schema=False)
async def suggest_route(request: Request) -> Response:
    if request.method != "POST" or raw_path(request) != "/suggest":
        return await forward(request, request.app.state.http)
    secret: str | None = request.app.state.settings.auth_secret
    if secret and not tokens.verify(_header(request, tokens.IDENTITY_HEADER), secret):
        return _send(401, {"error": "Sign in first"})
    try:
        given = _parse((await request.body()).decode("utf-8", errors="replace"))
    except ValueError:
        given = None
    if given is None:
        # null too: the TypeScript server can't read a run out of it either.
        return _send(400, {"error": "Invalid JSON body"})
    events = await suggest(
        given if isinstance(given, dict) else {}, request.app.state.create_message
    )
    accept = _header(request, "accept")
    kind = AGUI_MEDIA_TYPE if accepts_protobuf(accept) else "text/event-stream"
    return Response(
        "".join(encode_sse(e) for e in events),
        status_code=200,
        headers={"Content-Type": kind, "Cache-Control": "no-cache"},
    )
