"""The chat's "+" menu of outside tools and the app's calls to them (#190, step 7b), as apps/agent/src/tools-api.ts.

    GET  /tools                   {tools: [{server, label, chip, description, icon,
                                  mode, callable}]}: the "+" menu
    POST /tools/<server>/<tool>   {arguments} -> {result, text}, or 4xx/502 {error}: one
                                  call of a tool in that server's ui.tools, as the
                                  signed-in user

The servers come from MCP_SERVERS, read as apps/agent/src/mcp.ts reads it; only
those with a `ui` block show up here. A call goes to the server as a chat run's
would: with the user's identity (forwardIdentity, signed for "mcp:<server>") and
a storage token (storageAccess), so the server sees the same person whether
Claude or a button asked. These routes don't need storage. While MCP_SERVERS
isn't set here, they pass through to the TypeScript server, which reads its own.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import time
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import Response

from . import tokens
from .paths import JS_SPACE, js_trim, utf16_len
from .proxy import forward
from .run_report import js_json
from .skills_routes import js_to_number
from .storage_routes import (
    ALL_METHODS,
    _MalformedPath,
    decode_component,
    parse_json,
    raw_path,
    read_body,
)

logger = logging.getLogger("api_py")
router = APIRouter()
_OWN_PATH = re.compile(r"^/tools(/|$)")
MAX_BODY_BYTES = 64 * 1024
TOOL_IDENTITY_SECONDS = 60 * 60
DEFAULT_CALL_TIMEOUT_MS = 120_000

# Names the agent's own tool server already uses.
_RESERVED = {"copilotkit"}
_NAME = re.compile(r"[A-Za-z0-9_-]{1,64}")
_VAR = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}")
_ERROR_PREFIX = re.compile(r"^Error executing tool [A-Za-z0-9_-]+: ")
_AGENT_HEADERS = (tokens.IDENTITY_HEADER, tokens.STORAGE_HEADER, tokens.MEMORY_HEADER)


@dataclass(frozen=True)
class ToolUi:
    label: str
    chip: str
    description: str | None
    icon: str | None
    mode: str
    # Tools the app may call directly for the signed-in user.
    tools: tuple[str, ...]


@dataclass(frozen=True)
class ExternalServer:
    type: str  # http | sse | stdio
    url: str | None = None
    headers: dict[str, str] = field(default_factory=dict)
    forward_identity: bool = False
    storage_access: bool = False
    memory_access: bool = False
    ui: ToolUi | None = None


def _expand(value: str, env: Mapping[str, str], where: str) -> str:
    """`${VAR}` -> the environment's value (empty when unset, with a warning)."""

    def one(match: re.Match[str]) -> str:
        found = env.get(match.group(1))
        if found is None:
            logger.warning("[mcp] %s uses ${%s}, which isn't set", where, match.group(1))
        return found or ""

    return _VAR.sub(one, value)


def _strings(value: Any, env: Mapping[str, str], where: str) -> dict[str, str] | None:
    if value is None:
        return None
    if not isinstance(value, dict) or any(not isinstance(v, str) for v in value.values()):
        raise ValueError(f"{where} must map names to strings")
    return {k: _expand(v, env, f"{where}.{k}") for k, v in value.items()}


def _parse_ui(raw: Any) -> ToolUi:
    if not isinstance(raw, dict):
        raise ValueError("ui must be an object")  # noqa: TRY004 - a bad setting, logged with the rest

    def text(key: str, most: int) -> str | None:
        value = raw.get(key)
        if value is None:
            return None
        if not isinstance(value, str) or not js_trim(value) or utf16_len(value) > most:
            raise ValueError(f"ui.{key} must be a string of at most {most} characters")
        return js_trim(value)

    label = text("label", 40)
    if not label:
        raise ValueError("ui needs a label")
    mode = raw.get("mode")
    mode = "auto" if mode is None else mode
    if mode not in ("auto", "manual"):
        raise ValueError('ui.mode must be "auto" or "manual"')
    names = raw.get("tools")
    names = [] if names is None else names
    if not isinstance(names, list) or not all(
        isinstance(t, str) and _NAME.fullmatch(t) for t in names
    ):
        raise ValueError("ui.tools must be a list of tool names")
    return ToolUi(
        label=label,
        chip=text("chip", 24) or label,
        description=text("description", 200),
        icon=text("icon", 40),
        mode=mode,
        tools=tuple(dict.fromkeys(names)),
    )


def _parse_server(name: str, raw: Any, env: Mapping[str, str]) -> ExternalServer:
    if not _NAME.fullmatch(name):
        raise ValueError("names may use letters, digits, _ and - only")
    if name in _RESERVED:
        raise ValueError("that name is the agent's own tool server")
    if not isinstance(raw, dict):
        raise ValueError("must be an object")  # noqa: TRY004 - a bad setting, logged with the rest
    kind = raw.get("type")
    kind = "http" if kind is None else kind
    flags = {
        key: raw.get(key) is True for key in ("forwardIdentity", "storageAccess", "memoryAccess")
    }
    if kind == "stdio":
        if not isinstance(raw.get("command"), str) or not raw["command"]:
            raise ValueError("stdio needs a command")
        args = raw.get("args")
        if args is not None and not (
            isinstance(args, list) and all(isinstance(a, str) for a in args)
        ):
            raise ValueError("args must be a list of strings")
        if any(flags.values()) or "ui" in raw:
            raise ValueError(
                "forwardIdentity, storageAccess, memoryAccess and ui need an http or sse server"
            )
        _strings(raw.get("env"), env, f"{name}.env")
        return ExternalServer(type="stdio")  # Claude's only: never in the menu
    if kind not in ("http", "sse"):
        raise ValueError(f"unknown type {json.dumps(kind, ensure_ascii=False)}")
    url = raw.get("url")
    if not isinstance(url, str) or not re.match(r"https?://", url):
        raise ValueError("needs an http(s) url")
    headers = _strings(raw.get("headers"), env, f"{name}.headers") or {}
    for header in _AGENT_HEADERS:
        if any(h.lower() == header for h in headers):
            raise ValueError(
                f"{header} is set by the agent (forwardIdentity, storageAccess, memoryAccess)"
            )
    return ExternalServer(
        type=kind,
        url=url,
        headers=headers,
        forward_identity=flags["forwardIdentity"],
        storage_access=flags["storageAccess"],
        memory_access=flags["memoryAccess"],
        ui=None if "ui" not in raw else _parse_ui(raw["ui"]),
    )


def _js_key_order(names: list[str]) -> list[str]:
    """Object.entries order: integer-like keys first, ascending, then the rest as written."""
    index = [n for n in names if re.fullmatch(r"0|[1-9][0-9]*", n) and int(n) < 2**32 - 1]
    return sorted(index, key=int) + [n for n in names if n not in index]


def servers_from_env(env: Mapping[str, str]) -> dict[str, ExternalServer] | None:
    """MCP_SERVERS as externalServersFromEnv() reads it; None when it isn't set. Bad entries are logged and left out."""
    setting = js_trim(env.get("MCP_SERVERS") or "")
    if not setting:
        return None
    try:
        parsed = parse_json(
            setting if setting.startswith("{") else Path(setting).read_text(encoding="utf-8")
        )
    except (OSError, ValueError) as err:
        logger.error("[mcp] MCP_SERVERS isn't readable JSON; no outside MCP servers: %s", err)
        return {}
    servers_map = parsed.get("mcpServers") if isinstance(parsed, dict) else None
    entries = servers_map if isinstance(servers_map, dict) else parsed
    if not isinstance(entries, dict):
        logger.error("[mcp] MCP_SERVERS must be an object of servers; no outside MCP servers")
        return {}
    servers: dict[str, ExternalServer] = {}
    for name in _js_key_order(list(entries)):
        try:
            servers[name] = _parse_server(name, entries[name], env)
        except ValueError as err:
            logger.error(
                "[mcp] skipping MCP server %s: %s", json.dumps(name, ensure_ascii=False), err
            )
    return servers


def tool_menu(servers: Mapping[str, ExternalServer]) -> list[dict[str, Any]]:
    return [
        {
            "server": name,
            "label": s.ui.label,
            "chip": s.ui.chip,
            "description": s.ui.description,
            "icon": s.ui.icon,
            "mode": s.ui.mode,
            "callable": list(s.ui.tools),
        }
        for name, s in servers.items()
        if s.ui
    ]


def call_timeout_seconds(env: Mapping[str, str]) -> float:
    """TOOLS_CALL_TIMEOUT_MS, read as Number.parseInt reads it (milliseconds, default 120000)."""
    match = re.match(
        rf"[{JS_SPACE}]*([+-]?\d+)",
        env.get("TOOLS_CALL_TIMEOUT_MS") or str(DEFAULT_CALL_TIMEOUT_MS),
    )
    return max(int(match.group(1)), 0) / 1000 if match else 0.0


def storage_token_seconds(env: Mapping[str, str]) -> int:
    """STORAGE_TOKEN_SECONDS as storageTokenSeconds() in packages/contracts reads it."""
    value = js_trim(env.get("STORAGE_TOKEN_SECONDS") or "")
    if not value:
        return 3600
    seconds = js_to_number(value)
    if not seconds.is_integer() or not 60 <= seconds <= 24 * 3600:
        raise ValueError(
            f'STORAGE_TOKEN_SECONDS must be whole seconds from 60 to 86400, not "{value}"'
        )
    return int(seconds)


@dataclass(frozen=True)
class ToolsSettings:
    servers: dict[str, ExternalServer]
    timeout: float = DEFAULT_CALL_TIMEOUT_MS / 1000
    storage_token_seconds: int = 3600


# signs(server, kind) -> a token for that server, or None (no login).
Signer = Callable[[str, str], str | None]


def signer(claims: dict[str, Any] | None, secret: str | None, storage_seconds: int) -> Signer:
    """The signed-in user, signed for one server (identityForTools in server.ts, without memory)."""
    if not secret or claims is None:
        return lambda _server, _kind: None
    user = {k: claims[k] for k in ("sub", "email", "name") if k in claims}
    now = int(time.time())

    def sign(server: str, kind: str) -> str | None:
        via = f"mcp:{server}"
        if kind == "storage":
            return tokens.sign(
                {**user, "aud": tokens.STORAGE_AUDIENCE, "via": via, "exp": now + storage_seconds},
                secret,
            )
        if kind == "identity":
            return tokens.sign({**user, "aud": via, "exp": now + TOOL_IDENTITY_SECONDS}, secret)
        return None  # memory tokens come with a chat's run, not a button

    return sign


def headers_for(name: str, server: ExternalServer, sign: Signer) -> dict[str, str]:
    """The server's own headers, plus the user's tokens it asks for (serverConfigs in mcp.ts)."""
    added = {}
    for header, on, kind in (
        (tokens.IDENTITY_HEADER, server.forward_identity, "identity"),
        (tokens.STORAGE_HEADER, server.storage_access, "storage"),
    ):
        token = sign(name, kind) if on else None
        if token:
            added[header] = token
    return {**server.headers, **added}


@dataclass
class ToolAnswer:
    result: Any
    text: str
    is_error: bool


CallTool = Callable[
    [str, ExternalServer, str, dict[str, Any], dict[str, str], float], Awaitable[ToolAnswer]
]


async def mcp_call(
    name: str,
    server: ExternalServer,
    tool: str,
    args: dict[str, Any],
    headers: dict[str, str],
    timeout: float,
) -> ToolAnswer:
    """One tool call over MCP (streamable HTTP or SSE), on a connection of its own."""
    from mcp import ClientSession, types
    from mcp.client.sse import sse_client
    from mcp.client.streamable_http import streamable_http_client
    from mcp.shared._httpx_utils import create_mcp_http_client

    info = types.Implementation(name="knowledge-chatroom", version="1.0.0")

    async def over(read, write) -> types.CallToolResult:
        async with ClientSession(read, write, client_info=info) as session:
            await asyncio.wait_for(session.initialize(), timeout)
            answer = await session.call_tool(tool, args, read_timeout_seconds=timeout)
        if not isinstance(answer, types.CallToolResult):
            raise TypeError(
                f"{tool} answered {type(answer).__name__}"
            )  # e.g. asked the user for input
        return answer

    if server.type == "sse":
        async with sse_client(server.url, headers=headers, timeout=timeout) as (read, write):  # type: ignore[arg-type]
            answer = await over(read, write)
    else:
        async with (
            create_mcp_http_client(headers=headers) as http,
            streamable_http_client(server.url, http_client=http) as (read, write),  # type: ignore[arg-type]
        ):
            answer = await over(read, write)
    text = "\n".join(
        b.text for b in answer.content if getattr(b, "type", None) == "text" and b.text
    )
    result = answer.structured_content
    if result is None:
        try:
            result = parse_json(text)
        except ValueError:
            result = None
    return ToolAnswer(result=result, text=text, is_error=answer.is_error is True)


def _reason(err: BaseException) -> str:
    """The first real error inside the task groups the MCP client wraps errors in."""
    while isinstance(err, BaseExceptionGroup) and err.exceptions:
        err = err.exceptions[0]
    return str(err) or type(err).__name__


def _send(status: int, body: Any, cache: bool = True) -> Response:
    headers = {"Cache-Control": "no-store"} if cache else {}
    return Response(
        js_json(body), status_code=status, media_type="application/json", headers=headers
    )


def _signed_in(request: Request, secret: str | None) -> tuple[bool, dict[str, Any] | None]:
    """With login on, only requests the app signed for a user get through (signedIn in server.ts)."""
    if not secret:
        return True, None
    claims = tokens.verify(request.headers.get(tokens.IDENTITY_HEADER), secret)
    return claims is not None, claims


@router.api_route("/tools", methods=ALL_METHODS, include_in_schema=False)
@router.api_route("/tools/{rest:path}", methods=ALL_METHODS, include_in_schema=False)
async def tools_route(request: Request) -> Response:
    state = request.app.state
    tools_settings: ToolsSettings | None = state.settings.tools
    path = raw_path(request)
    if tools_settings is None or not _OWN_PATH.match(path):
        return await forward(request, state.http)
    servers = tools_settings.servers
    secret = state.settings.auth_secret
    try:
        parts = [decode_component(p) for p in path.split("/")[2:]]
    except _MalformedPath:
        return _send(400, {"error": "Bad path"})
    server, tool, extra = (parts + ["", ""])[0], (parts + ["", ""])[1], parts[2:]
    if not server:
        if request.method != "GET":
            return _send(405, {"error": "Method not allowed"})
        if not _signed_in(request, secret)[0]:
            return _send(401, {"error": "Sign in first"}, cache=False)
        return _send(200, {"tools": tool_menu(servers)})
    if not tool or extra:
        return _send(404, {"error": "Not found"})
    if request.method != "POST":
        return _send(405, {"error": "Method not allowed"})
    found = servers.get(server)
    ui = found.ui if found else None
    if found is None or ui is None:
        return _send(
            404, {"error": f"No tool server {json.dumps(server, ensure_ascii=False)} in the menu"}
        )
    if tool not in ui.tools:
        return _send(
            403, {"error": f"{tool} isn't one of {server}'s tools the app may call (ui.tools)"}
        )
    ok, claims = _signed_in(request, secret)
    if not ok:
        return _send(401, {"error": "Sign in first"}, cache=False)
    body = await read_body(request, MAX_BODY_BYTES)
    given: Any = None
    if body is not None:
        try:
            given = parse_json(body.decode("utf-8", errors="replace")) if body else {}
        except ValueError:
            given = None
    args = (
        (given.get("arguments") if given.get("arguments") is not None else {})
        if isinstance(given, dict)
        else None
    )
    if not isinstance(args, dict):
        return _send(400, {"error": "Expected {arguments: {...}}"})
    sign = signer(claims, secret, tools_settings.storage_token_seconds)
    call: CallTool = getattr(state, "call_tool", None) or mcp_call
    try:
        answer = await call(
            server, found, tool, args, headers_for(server, found, sign), tools_settings.timeout
        )
    except Exception as err:  # noqa: BLE001 - any failure to reach the server is the same answer
        logger.error("[tools] %s/%s: %s", server, tool, _reason(err))
        return _send(502, {"error": f"{ui.label} isn't reachable right now"})
    if answer.is_error:
        # Python MCP servers prefix their errors; the user only needs the reason.
        reason = _ERROR_PREFIX.sub("", answer.text, count=1)
        return _send(422, {"error": reason or f"{tool} failed"})
    return _send(200, {"result": answer.result, "text": answer.text})


def tools_settings_from_env(env: Mapping[str, str] = os.environ) -> ToolsSettings | None:
    servers = servers_from_env(env)
    if servers is None:
        return None
    return ToolsSettings(
        servers=servers,
        timeout=call_timeout_seconds(env),
        storage_token_seconds=storage_token_seconds(env),
    )
