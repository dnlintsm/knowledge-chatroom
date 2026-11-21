"""Who is calling: the chatroom's signed X-Knowledge-User header.

With login on, the agent sends each run's user to servers configured with
"forwardIdentity": true, as a token signed for this server only
(aud "mcp:<server name>"). Python twin of packages/contracts/src/identity-token.ts:

    v2.<base64url JSON payload>.<base64url Ed25519 signature of "v2.<payload>">

It is checked with the chatroom's public key (KNOWLEDGE_PUBLIC_KEY, from the
agent's GET /identity/public-key), not AUTH_SECRET: with only the public key,
this server can check who is calling but can't sign for anyone (issue #88).

Without login there is no header: everyone is the local user. Whether login
is on is never guessed from a missing key: login_from_env() reads AUTH_MODE too,
and refuses to choose when neither says (issue #283).
"""

from __future__ import annotations

import base64
import json
import time
from collections.abc import Mapping
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


class LoginConfigError(ValueError):
    """AUTH_MODE and KNOWLEDGE_PUBLIC_KEY don't say whether callers must sign in."""


@dataclass(frozen=True)
class Login:
    """Whether callers must prove who they are, and the key that checks them.

    `required` without a `key` is login that is on but not set up here: every
    call is refused until this server gets KNOWLEDGE_PUBLIC_KEY.
    """

    required: bool
    key: Ed25519PublicKey | None = None


def _b64decode(data: str) -> bytes:
    return base64.urlsafe_b64decode(data + "=" * (-len(data) % 4))


def public_key(value: str) -> Ed25519PublicKey:
    """The key from KNOWLEDGE_PUBLIC_KEY: 32 raw bytes, base64url."""
    return Ed25519PublicKey.from_public_bytes(_b64decode(value.strip()))


def login_from_env(env: Mapping[str, str]) -> Login:
    """Whether login is on for this server, from AUTH_MODE and KNOWLEDGE_PUBLIC_KEY.

    - AUTH_MODE=local: no login, everyone is the local user. A key must not be set.
    - KNOWLEDGE_PUBLIC_KEY set: login, checked with that key.
    - AUTH_MODE=oidc (or AUTH_SECRET in the environment) without a key: login is
      on, so every call is refused until the key is set.
    - None of them: an error. A setting left out must not turn login off.
    """
    mode = (env.get("AUTH_MODE") or "").strip().lower() or None
    raw = (env.get("KNOWLEDGE_PUBLIC_KEY") or "").strip()
    if mode not in (None, "oidc", "local"):
        raise LoginConfigError(f'AUTH_MODE must be "oidc" or "local", not "{env.get("AUTH_MODE")}"')
    if mode == "local":
        if raw:
            raise LoginConfigError(
                "AUTH_MODE=local turns login off, so KNOWLEDGE_PUBLIC_KEY must not be set; "
                "use AUTH_MODE=oidc for login"
            )
        return Login(required=False)
    if raw:
        return Login(required=True, key=public_key(raw))
    if mode == "oidc" or env.get("AUTH_SECRET"):
        return Login(required=True)
    raise LoginConfigError(
        "Login is not configured. Set AUTH_MODE=oidc and KNOWLEDGE_PUBLIC_KEY (the API server's "
        "GET /identity/public-key) for sign-in, or AUTH_MODE=local to run without login "
        "(everyone is one user)"
    )


def verify(
    token: str, key: Ed25519PublicKey, audience: str | None, now: float | None = None
) -> User | None:
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


def caller(
    headers: Mapping[str, str] | None,
    login: Login | Ed25519PublicKey | None,
    audience: str | None,
) -> User | None:
    """The calling user: the local user without login, None when the call can't prove one.

    `login` is login_from_env()'s answer. A bare key (or None for "no login")
    is still accepted from servers written before it.

    A header without login is refused, not ignored: it means the chatroom has
    login on and this server does not know it.
    """
    if not isinstance(login, Login):
        login = Login(required=login is not None, key=login)
    token = (headers or {}).get(HEADER)
    if not login.required:
        return None if token else LOCAL_USER
    if login.key is None or not token:
        return None
    return verify(token, login.key, audience)
