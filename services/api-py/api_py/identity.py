"""Who a request is from, as identify() in apps/agent/src/storage/identity.ts.

Without AUTH_SECRET there is no login: every request is the built-in local
user. With it, the app signs the user into X-Knowledge-User, and a request
without a valid one is refused. On the storage API a valid X-Knowledge-Storage
token wins: Claude acting for its user through the outside service it names
(`via`). The port must stay private either way; the header is only as
trustworthy as the network in front of it.
"""

from __future__ import annotations

import base64
import json
import re
from dataclasses import dataclass
from typing import Any

from fastapi import Request

from . import tokens
from .access import LEGACY_TOKEN, AccessService, Principal

_UUID = re.compile(r"[0-9a-fA-F-]{36}")


async def identify(
    request: Request, access: AccessService, secret: str | None, *, storage_tokens: bool = False
) -> Principal | None:
    """The principal for a request, or None when login is on and it carries no valid identity."""
    if not secret:
        return Principal(user_id=await access.local_user_id())
    storage_header = request.headers.get(tokens.STORAGE_HEADER) if storage_tokens else None
    if storage_header is not None:
        claims = tokens.verify(storage_header, secret, tokens.STORAGE_AUDIENCE)
        via = claims.get("via") if claims else None
        if not claims or not isinstance(via, str) or not via:
            return None
        return Principal(
            user_id=await _user_for(access, claims),
            actor="agent",
            via=via,
            bound_ws=token_ws(claims),
        )
    header = request.headers.get(tokens.IDENTITY_HEADER)
    claims = tokens.verify(header, secret) if header is not None else None
    if not claims:
        return None
    return Principal(user_id=await _user_for(access, claims))


def token_ws(claims: dict[str, Any]) -> str:
    """The workspace a token is bound to: its `ws` claim, or the default one for a legacy token."""
    ws = claims.get("ws")
    return ws if isinstance(ws, str) else LEGACY_TOKEN


async def _user_for(access: AccessService, claims: dict) -> str:
    email = claims.get("email")
    name = claims.get("name")
    return await access.user_for_subject(
        claims["sub"],
        email if isinstance(email, str) else None,
        name if isinstance(name, str) else None,
    )


def memory_claims(request: Request, secret: str | None) -> dict[str, Any] | None:
    """
    The claims of the X-Knowledge-Memory token (a run's: `via` and `thread`
    set), or None. Without login, the app's unsigned local.<base64url JSON>.
    """
    header = request.headers.get(tokens.MEMORY_HEADER)
    if header is None:
        return None
    claims: Any = None
    if secret:
        claims = tokens.verify(header, secret, tokens.MEMORY_AUDIENCE)
    elif header.startswith("local."):
        data = header[len("local.") :]
        try:
            raw = base64.urlsafe_b64decode(data + "=" * (-len(data) % 4))
            claims = json.loads(raw.decode("utf-8", errors="replace"))
        except ValueError:
            return None
    if not isinstance(claims, dict):
        return None
    via, thread = claims.get("via"), claims.get("thread")
    if not isinstance(via, str) or not via or not isinstance(thread, str) or not thread:
        return None
    return claims


@dataclass
class MemoryGrant:
    """What an X-Knowledge-Memory token lets its holder do: the user's memory in one chat."""

    user_id: str
    via: str
    thread: str
    node: str | None
    # As Principal.bound_ws: the token's workspace (LEGACY_TOKEN without a `ws` claim).
    bound_ws: str = LEGACY_TOKEN


async def memory_grant(
    access: AccessService, secret: str | None, claims: dict[str, Any]
) -> MemoryGrant:
    """The grant for claims memory_claims read (identifyMemory in identity.ts)."""
    node = claims.get("node")
    user = await _user_for(access, claims) if secret else await access.local_user_id()
    return MemoryGrant(
        user_id=user,
        via=claims["via"],
        thread=claims["thread"],
        node=node if isinstance(node, str) and _UUID.fullmatch(node) else None,
        bound_ws=token_ws(claims),
    )
