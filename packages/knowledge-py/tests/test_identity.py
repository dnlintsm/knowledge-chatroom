"""knowledge_chatroom.identity against tokens the chatroom's agent signed."""

import base64
import json

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from knowledge_chatroom import identity

# The chatroom's public key for AUTH_SECRET "0123456789abcdef0123456789abcdef",
# and tokens its agent signed with it (packages/contracts/src/identity-token.ts, the same values
# as tests/unit/identity-token.spec.ts), so these tests break if the two sides
# stop agreeing on the format.
PUBLIC_KEY = identity.public_key("Z1iN8KqPV0u2Dk95GsXXFlHQE05RT15l2-1TzD3XDI8")
FOR_LAB = (
    "v2.eyJzdWIiOiJ0ZXN0fGFsaWNlIiwiZW1haWwiOiJhbGljZUBleGFtcGxlLmNvbSIsIm5hbWUiOiJBbGljZSIsImV4cCI6NDEwMjQ0NDgwMCwiYXVkIjoibWNwOmxhYiJ9"
    ".3PaC2ATVNb3697brWOY91ggVm8HHdIqlYHdGdcVL1N_sUN7V51VIjmgr5HzvZMfJU7jD9Qxn4QBYjl1VuGm0DA"
)
FOR_AGENT = (
    "v2.eyJzdWIiOiJ0ZXN0fGFsaWNlIiwiZW1haWwiOiJhbGljZUBleGFtcGxlLmNvbSIsIm5hbWUiOiJBbGljZSIsImV4cCI6NDEwMjQ0NDgwMH0"
    ".7dkRyzzd9sZobxDxM99PwMZrpPsmFb8DxJD5btxDSDmc-ZtF5U7EAFjxMvsVF780JIvdLpZ5f6KjMyplax6wDQ"
)
# Signs test tokens; the chatroom's own private key is never on this side.
TEST_KEY = Ed25519PrivateKey.generate()


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode().rstrip("=")


def sign(payload: dict, key: Ed25519PrivateKey = TEST_KEY) -> str:
    body = "v2." + _b64(json.dumps(payload).encode())
    return body + "." + _b64(key.sign(body.encode()))


def test_identity_accepts_the_agents_token_for_this_server_only():
    user = identity.verify(FOR_LAB, PUBLIC_KEY, "mcp:lab")
    assert user == identity.User(sub="test|alice", email="alice@example.com", name="Alice")
    assert identity.verify(FOR_LAB, PUBLIC_KEY, "mcp:other") is None
    # The agent's own credential (no audience) is not a tool server's.
    assert identity.verify(FOR_AGENT, PUBLIC_KEY, "mcp:lab") is None
    assert identity.verify(FOR_LAB, TEST_KEY.public_key(), "mcp:lab") is None


def test_identity_refuses_expired_tampered_and_local_tokens():
    key = TEST_KEY.public_key()
    assert (
        identity.verify(sign({"sub": "a", "exp": 4102444800, "aud": "mcp:lab"}), key, "mcp:lab").sub
        == "a"
    )
    assert identity.verify(sign({"sub": "a", "exp": 1, "aud": "mcp:lab"}), key, "mcp:lab") is None
    assert (
        identity.verify(sign({"sub": "local", "exp": 4102444800, "aud": "mcp:lab"}), key, "mcp:lab")
        is None
    )
    head, payload, signature = FOR_LAB.split(".")
    assert identity.verify(f"{head}.e30.{signature}", PUBLIC_KEY, "mcp:lab") is None
    # The old HMAC format isn't accepted here: it needs the shared secret.
    assert identity.verify(f"v1.{payload}.{signature}", PUBLIC_KEY, "mcp:lab") is None
    assert identity.verify("garbage", PUBLIC_KEY, "mcp:lab") is None


def test_caller_without_login_is_the_local_user():
    assert identity.caller(None, None, "mcp:lab") == identity.LOCAL_USER
    assert identity.caller({}, PUBLIC_KEY, "mcp:lab") is None
    assert identity.caller({identity.HEADER: FOR_LAB}, PUBLIC_KEY, "mcp:lab").sub == "test|alice"
    # Login is on but this server has no key: refused, not the local user.
    assert identity.caller({identity.HEADER: FOR_LAB}, None, "mcp:lab") is None


def test_login_comes_from_auth_mode_and_the_key_never_from_a_missing_setting():
    """Issue #283: no key used to mean "no login", so a forgotten key turned login off."""
    key = "Z1iN8KqPV0u2Dk95GsXXFlHQE05RT15l2-1TzD3XDI8"
    assert identity.login_from_env({"AUTH_MODE": "local"}) == identity.Login(required=False)
    assert identity.login_from_env({"AUTH_MODE": " Local ", "KNOWLEDGE_PUBLIC_KEY": " "}) == (
        identity.Login(required=False)
    )
    for env in ({"KNOWLEDGE_PUBLIC_KEY": key}, {"AUTH_MODE": "oidc", "KNOWLEDGE_PUBLIC_KEY": key}):
        login = identity.login_from_env(env)
        assert login.required and login.key is not None
    # Login without the key yet: on, and nobody passes.
    for env in ({"AUTH_MODE": "oidc"}, {"AUTH_SECRET": "0123456789abcdef0123456789abcdef"}):
        assert identity.login_from_env(env) == identity.Login(required=True, key=None)
    for env, message in (
        ({}, "Login is not configured"),
        ({"KNOWLEDGE_PUBLIC_KEY": ""}, "Login is not configured"),
        ({"AUTH_MODE": "local", "KNOWLEDGE_PUBLIC_KEY": key}, "must not be set"),
        ({"AUTH_MODE": "maybe"}, "must be"),
    ):
        with pytest.raises(identity.LoginConfigError, match=message):
            identity.login_from_env(env)


def test_caller_follows_the_login_setting():
    signed = {identity.HEADER: FOR_LAB}
    on = identity.Login(required=True, key=PUBLIC_KEY)
    assert identity.caller(signed, on, "mcp:lab").sub == "test|alice"
    assert identity.caller({}, on, "mcp:lab") is None
    assert identity.caller(signed, on, "mcp:other") is None
    # Login on, key missing: refused with or without a token.
    missing = identity.Login(required=True)
    assert identity.caller(signed, missing, "mcp:lab") is None
    assert identity.caller({}, missing, "mcp:lab") is None
    # No login: the local user, and a signed call is refused rather than ignored.
    off = identity.Login(required=False)
    assert identity.caller(None, off, "mcp:lab") == identity.LOCAL_USER
    assert identity.caller(signed, off, "mcp:lab") is None
    # A bare key or None, as servers written before login_from_env() pass.
    assert identity.caller(signed, PUBLIC_KEY, "mcp:lab").sub == "test|alice"
    assert identity.caller({}, None, "mcp:lab") == identity.LOCAL_USER
