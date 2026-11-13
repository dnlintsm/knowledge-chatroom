"""Tokens for a remote backend's outside MCP servers, as apps/agent/src/mcp-tokens.ts makes them (#190, step 9).

A remote backend's chat agent (AGENT_URL, e.g. services/agent-py) connects to
the servers in its own MCP_SERVERS and forwards the user to them as the agent
server does: an identity token signed for "mcp:<name>" (forwardIdentity), a
storage token via "mcp:<name>" (storageAccess) and a memory token via
"mcp:<name>" for the chat (memoryAccess). It never holds AUTH_SECRET, so it
trades the run's own tokens for them here:

    POST /identity/mcp-tokens   {servers: {<name>: ["identity" | "storage" | "memory", ...]}}
      with the run's X-Knowledge-Storage (and X-Knowledge-Memory) tokens, both
      `via` "remote" as the app makes them, answers {tokens: {<name>: {<kind>: token}}}

Each token made reaches no further than the one it came from: the same user
(and chat), expiring no later. Tokens made for an outside service (`via`
"mcp:...") can't be traded. Without login there are no identity or storage
tokens, and memory tokens are the unsigned local form.
"""

from __future__ import annotations

import base64
import json
import math
import re
import time
from collections.abc import Mapping
from typing import Any

from . import tokens
from .run_report import js_order

KINDS = ("identity", "storage", "memory")
_NAME = re.compile(r"[A-Za-z0-9_-]{1,64}")
MAX_SERVERS = 32
MAX_BODY_BYTES = 16 * 1024
# As long as the agent server's own identity tokens for MCP servers last.
IDENTITY_SECONDS = 60 * 60
BAD_REQUEST = 'Send {servers: {<name>: ["identity" | "storage" | "memory"]}}'
NEEDS_STORAGE = (
    "This needs the run's X-Knowledge-Storage token, as the app sends it to a remote backend"
)


def parse_request(body: Any) -> dict[str, set[str]] | None:
    """The servers and kinds asked for; None when the body isn't that shape."""
    servers = body.get("servers") if isinstance(body, dict) else None
    if not isinstance(servers, dict) or len(servers) > MAX_SERVERS:
        return None
    wanted: dict[str, set[str]] = {}
    for name, kinds in js_order(servers).items():
        if (
            not _NAME.fullmatch(name)
            or not isinstance(kinds, list)
            or not all(isinstance(k, str) and k in KINDS for k in kinds)
        ):
            return None
        wanted[name] = set(kinds)
    return wanted


def local_memory_token(via: str, thread: Any, node: Any) -> str:
    """localMemoryToken in identity-token.ts: `local.` and the claims' JSON, base64url."""
    claims = json.dumps(
        {"via": via, "thread": thread, "node": node}, separators=(",", ":"), ensure_ascii=False
    )
    return "local." + base64.urlsafe_b64encode(claims.encode()).rstrip(b"=").decode()


def _local_memory(token: str | None) -> dict[str, Any] | None:
    """A local memory token's chat, when it is one made for the remote chat agent."""
    if not token or not token.startswith("local."):
        return None
    data = token[len("local.") :]
    try:
        raw = base64.urlsafe_b64decode(data + "=" * (-len(data) % 4))
        claims = json.loads(raw.decode("utf-8", errors="replace"))
    except ValueError:
        return None
    if not isinstance(claims, dict) or claims.get("via") != tokens.REMOTE_VIA:
        return None
    thread, node = claims.get("thread"), claims.get("node")
    if not isinstance(thread, str) or not thread:
        return None
    return {"thread": thread, "node": node if isinstance(node, str) else None}


def _seconds(value: Any) -> Any:
    """A whole number of seconds as JSON.stringify writes it: without ".0"."""
    return int(value) if isinstance(value, float) and value.is_integer() else value


def _truthy(value: Any) -> bool:
    if isinstance(value, float) and math.isnan(value):
        return False
    return value not in (None, False, 0, "")


def mcp_tokens(
    headers: Mapping[str, str], body: Any, secret: str | None, now: float | None = None
) -> tuple[int, dict[str, Any]]:
    """The status and body answering POST /identity/mcp-tokens; `secret` is AUTH_SECRET (None without login)."""
    wanted = parse_request(body)
    if wanted is None:
        return 400, {"error": BAD_REQUEST}
    clock = time.time() if now is None else now
    seconds = math.floor(clock)
    made: dict[str, dict[str, str]] = {}

    if not secret:
        # No login: everyone is the local user, and only memory has a token.
        memory = _local_memory(headers.get(tokens.MEMORY_HEADER))
        for name, kinds in wanted.items():
            made[name] = (
                {"memory": local_memory_token(f"mcp:{name}", memory["thread"], memory["node"])}
                if memory and "memory" in kinds
                else {}
            )
        return 200, {"tokens": made}

    storage_header = headers.get(tokens.STORAGE_HEADER)
    storage = (
        tokens.verify(storage_header, secret, tokens.STORAGE_AUDIENCE, clock)
        if storage_header
        else None
    )
    if not storage or storage.get("via") != tokens.REMOTE_VIA:
        return 401, {"error": NEEDS_STORAGE}
    memory_header = headers.get(tokens.MEMORY_HEADER)
    memory = (
        tokens.verify(memory_header, secret, tokens.MEMORY_AUDIENCE, clock)
        if memory_header
        else None
    )
    chat = (
        memory
        if memory
        and memory.get("via") == tokens.REMOTE_VIA
        and memory.get("sub") == storage["sub"]
        and _truthy(memory.get("thread"))
        else None
    )
    # { sub, email, name } from the storage token: missing ones are left out, as undefined is.
    user = {k: storage[k] for k in ("sub", "email", "name") if k in storage}

    for name, kinds in wanted.items():
        via = f"mcp:{name}"
        these: dict[str, str] = {}
        if "identity" in kinds:
            exp = min(storage["exp"], seconds + IDENTITY_SECONDS)
            these["identity"] = tokens.sign({**user, "aud": via, "exp": _seconds(exp)}, secret)
        if "storage" in kinds:
            claims = {**user, "aud": tokens.STORAGE_AUDIENCE, "via": via}
            these["storage"] = tokens.sign({**claims, "exp": _seconds(storage["exp"])}, secret)
        if "memory" in kinds and chat:
            node = chat.get("node")
            claims = {
                **user,
                "aud": tokens.MEMORY_AUDIENCE,
                "via": via,
                "thread": chat["thread"],
                "node": node,
                "exp": _seconds(min(chat["exp"], storage["exp"])),
            }
            these["memory"] = tokens.sign(claims, secret)
        made[name] = these
    return 200, {"tokens": made}
