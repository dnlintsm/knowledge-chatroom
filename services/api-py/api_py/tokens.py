"""Identity tokens, signed and checked as packages/contracts/src/identity-token.ts does.

    v2.<base64url JSON claims>.<base64url Ed25519 signature of "v2.<claims>">

The key pair comes from AUTH_SECRET (HKDF-SHA256, salt "knowledge-chatroom",
info "x-knowledge-user v2"), so this server and the web app sign the same
tokens and accept each other's. Signing is here. Checking a signature and its
expiry is knowledge_chatroom.identity's, which outside services use with the
public key alone, so there is one implementation of that check.
"""

from __future__ import annotations

import base64
import json
from functools import lru_cache
from typing import Any

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

from knowledge_chatroom import identity as shared_identity
from knowledge_chatroom import memory as shared_memory
from knowledge_chatroom import storage as shared_storage

# The headers' names, from the package outside services read them with.
IDENTITY_HEADER = shared_identity.HEADER
STORAGE_HEADER = shared_storage.STORAGE_HEADER
MEMORY_HEADER = shared_memory.MEMORY_HEADER
STORAGE_AUDIENCE = "storage"
MEMORY_AUDIENCE = "memory"
REMOTE_VIA = "remote"


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


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

    Callers check `sub` and `aud` (verify() below does).
    """
    return shared_identity.claims(token, _private_key(secret).public_key(), now)


def verify(
    token: str | None, secret: str, audience: str | None = None, now: float | None = None
) -> dict[str, Any] | None:
    """A signed-in user's claims for `audience` (None: an X-Knowledge-User token)."""
    return shared_identity.signed_in(read(token, secret, now), audience)
