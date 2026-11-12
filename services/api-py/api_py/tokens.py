"""Identity tokens, signed and checked as packages/contracts/src/identity-token.ts does.

    v2.<base64url JSON claims>.<base64url Ed25519 signature of "v2.<claims>">

The key pair comes from AUTH_SECRET (HKDF-SHA256, salt "knowledge-chatroom",
info "x-knowledge-user v2"), so this server and the TypeScript one sign the
same tokens and accept each other's. Outside services check them with the
public key alone (knowledge_chatroom.identity).
"""

from __future__ import annotations

import base64
import json
import time
from functools import lru_cache
from typing import Any

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

IDENTITY_HEADER = "x-knowledge-user"
STORAGE_HEADER = "x-knowledge-storage"
STORAGE_AUDIENCE = "storage"
MEMORY_HEADER = "x-knowledge-memory"
MEMORY_AUDIENCE = "memory"
REMOTE_VIA = "remote"


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _unb64(data: str) -> bytes:
    return base64.urlsafe_b64decode(data + "=" * (-len(data) % 4))


@lru_cache(maxsize=4)
def _private_key(secret: str) -> Ed25519PrivateKey:
    seed = HKDF(
        algorithm=hashes.SHA256(),
        length=32,
        salt=b"knowledge-chatroom",
        info=b"x-knowledge-user v2",
    ).derive(secret.encode())
    return Ed25519PrivateKey.from_private_bytes(seed)


def public_key(secret: str) -> str:
    """The public key for AUTH_SECRET: the raw 32-byte Ed25519 key, base64url (GET /identity/public-key)."""
    raw = (
        _private_key(secret)
        .public_key()
        .public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
    )
    return _b64(raw)


def _claims_json(claims: dict[str, Any]) -> bytes:
    # JSON.stringify's bytes: no spaces, keys in the given order, non-ASCII as is.
    return json.dumps(claims, separators=(",", ":"), ensure_ascii=False).encode()


def sign(claims: dict[str, Any], secret: str) -> str:
    body = f"v2.{_b64(_claims_json(claims))}"
    return f"{body}.{_b64(_private_key(secret).sign(body.encode()))}"


def read(token: str | None, secret: str, now: float | None = None) -> dict[str, Any] | None:
    """The claims of a token signed for AUTH_SECRET; None when it is malformed, forged or expired.

    Callers check `sub` and `aud`, as with readIdentityToken.
    """
    parts = (token or "").split(".")
    if len(parts) != 3 or parts[0] != "v2":
        return None
    try:
        signature = _unb64(parts[2])
        if len(signature) != 64:
            return None
        _private_key(secret).public_key().verify(signature, f"v2.{parts[1]}".encode())
        claims = json.loads(_unb64(parts[1]))
    except (InvalidSignature, ValueError):
        return None
    if not isinstance(claims, dict):
        return None
    exp = claims.get("exp")
    if (
        not isinstance(exp, int | float)
        or isinstance(exp, bool)
        or exp < (time.time() if now is None else now)
    ):
        return None
    return claims


def verify(
    token: str | None, secret: str, audience: str | None = None, now: float | None = None
) -> dict[str, Any] | None:
    """A signed-in user's claims for `audience` (None: an X-Knowledge-User token), as verifyIdentity checks them."""
    claims = read(token, secret, now)
    if not claims:
        return None
    sub = claims.get("sub")
    if not isinstance(sub, str) or not sub or sub == "local":
        return None
    if claims.get("aud") != audience:
        return None
    return claims
