"""Who is calling: the chatroom's signed X-Knowledge-User header.

With login on, the agent sends each run's user to servers configured with
"forwardIdentity": true, as a token signed with AUTH_SECRET for this server only
(aud "mcp:<server name>"). Python twin of agent/src/storage/identity.ts:

    v1.<base64url JSON payload>.<base64url HMAC-SHA256 of "v1.<payload>">

Without login (no AUTH_SECRET) there is no header: everyone is the local user.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time
from dataclasses import dataclass

HEADER = "x-knowledge-user"


@dataclass
class User:
    sub: str
    email: str | None = None
    name: str | None = None


LOCAL_USER = User(sub="local", name="Local user")


def _b64decode(data: str) -> bytes:
    return base64.urlsafe_b64decode(data + "=" * (-len(data) % 4))


def verify(token: str, secret: str, audience: str, now: float | None = None) -> User | None:
    """The user in a token signed for `audience`; None if it is forged, expired or for someone else."""
    parts = token.split(".")
    if len(parts) != 3 or parts[0] != "v1":
        return None
    expected = hmac.new(secret.encode(), f"v1.{parts[1]}".encode(), hashlib.sha256).digest()
    try:
        given = _b64decode(parts[2])
        payload = json.loads(_b64decode(parts[1]))
    except (ValueError, json.JSONDecodeError):
        return None
    if not hmac.compare_digest(given, expected) or not isinstance(payload, dict):
        return None
    sub = payload.get("sub")
    exp = payload.get("exp")
    if not isinstance(sub, str) or not sub or sub == "local":
        return None
    if not isinstance(exp, (int, float)) or exp < (time.time() if now is None else now):
        return None
    if payload.get("aud") != audience:
        return None
    return User(sub=sub, email=payload.get("email"), name=payload.get("name"))


def caller(headers: dict[str, str] | None, secret: str | None, audience: str) -> User | None:
    """The calling user: the local user without login, None when login is on and the header is bad."""
    if not secret:
        return LOCAL_USER
    token = (headers or {}).get(HEADER)
    return verify(token, secret, audience) if token else None
