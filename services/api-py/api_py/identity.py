"""Who a request is from, as identify() in apps/agent/src/storage/identity.ts.

Without AUTH_SECRET there is no login: every request is the built-in local
user. With it, the app signs the user into X-Knowledge-User, and a request
without a valid one is refused. On the storage API a valid X-Knowledge-Storage
token wins: Claude acting for its user through the outside service it names
(`via`). The port must stay private either way; the header is only as
trustworthy as the network in front of it.
"""

from __future__ import annotations

from fastapi import Request

from . import tokens
from .access import AccessService, Principal


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
        return Principal(user_id=await _user_for(access, claims), actor="agent", via=via)
    header = request.headers.get(tokens.IDENTITY_HEADER)
    claims = tokens.verify(header, secret) if header is not None else None
    if not claims:
        return None
    return Principal(user_id=await _user_for(access, claims))


async def _user_for(access: AccessService, claims: dict) -> str:
    email = claims.get("email")
    name = claims.get("name")
    return await access.user_for_subject(
        claims["sub"], email if isinstance(email, str) else None, name if isinstance(name, str) else None
    )
