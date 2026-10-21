"""Who is calling: the chatroom's signed X-Knowledge-User header.

With login on, the agent sends each run's user to servers configured with
"forwardIdentity": true, as a token signed for this server only
(aud "mcp:<server name>"). Python twin of shared/identity-token.ts:

    v2.<base64url JSON payload>.<base64url Ed25519 signature of "v2.<payload>">

It is checked with the chatroom's public key (KNOWLEDGE_PUBLIC_KEY, from the
agent's GET /identity/public-key), not AUTH_SECRET: with only the public key,
this server can check who is calling but can't sign for anyone (issue #88).

Without login there is no header: everyone is the local user.
"""

from __future__ import annotations

import base64
import json
import time
from dataclasses import dataclass

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

HEADER = "x-knowledge-user"


@dataclass
class User:
    sub: str
    email: str | None = None
    name: str | None = None


LOCAL_USER = User(sub="local", name="Local user")


def _b64decode(data: str) -> bytes:
    return base64.urlsafe_b64decode(data + "=" * (-len(data) % 4))


def public_key(value: str) -> Ed25519PublicKey:
    """The key from KNOWLEDGE_PUBLIC_KEY: 32 raw bytes, base64url."""
    return Ed25519PublicKey.from_public_bytes(_b64decode(value.strip()))


def verify(token: str, key: Ed25519PublicKey, audience: str | None, now: float | None = None) -> User | None:
    """The user in a token signed for `audience`; None if it is forged, expired or for someone else."""
    parts = token.split(".")
    if len(parts) != 3 or parts[0] != "v2":
        return None
    try:
        key.verify(_b64decode(parts[2]), f"v2.{parts[1]}".encode())
        payload = json.loads(_b64decode(parts[1]))
    except (InvalidSignature, ValueError, json.JSONDecodeError):
        return None
    if not isinstance(payload, dict):
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


def caller(headers: dict[str, str] | None, key: Ed25519PublicKey | None, audience: str) -> User | None:
    """The calling user: the local user without login, None when the call can't prove one.

    A header without a configured key is refused, not ignored: it means login is
    on and this server is missing KNOWLEDGE_PUBLIC_KEY.
    """
    token = (headers or {}).get(HEADER)
    if key is None:
        return None if token else LOCAL_USER
    return verify(token, key, audience) if token else None
