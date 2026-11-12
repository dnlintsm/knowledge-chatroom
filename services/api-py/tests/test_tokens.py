"""Tokens are byte for byte the TypeScript ones (packages/contracts/src/identity-token.ts)."""

from __future__ import annotations

from api_py import tokens

SECRET = "0123456789abcdef0123456789abcdef"
# From signIdentityToken / identityPublicKey with SECRET, in TypeScript.
TS_PUBLIC_KEY = "Z1iN8KqPV0u2Dk95GsXXFlHQE05RT15l2-1TzD3XDI8"
TS_STORAGE = (
    "v2.eyJzdWIiOiJrY3xhbGljZSIsImVtYWlsIjoiYWxpY2VAZXhhbXBsZS5jb20iLCJuYW1lIjoiQWxpY2Ugw4VsdW5kIiwiYXVkIjoic3Rv"
    "cmFnZSIsInZpYSI6InJlbW90ZSIsImV4cCI6MTg5MzQ1NjAwMH0.ax1waymmkMxwGH8ouKxwiCDdtw4lmZ-5ZumjHCT7ixKc8Y3xdyVY503"
    "0CxnSMtTPYrl8csDaQt2ai9cB6QwwBA"
)
TS_USER = (
    "v2.eyJzdWIiOiJrY3xhbGljZSIsImVtYWlsIjoiYWxpY2VAZXhhbXBsZS5jb20iLCJuYW1lIjoiQWxpY2UiLCJleHAiOjE4OTM0NTYwMDB9.e2"
    "0pLKBLivYEia4aS_tLqXEgAfObsmeyUwqmH6QpE4u6cC2HmymsrML51K1J6wEJxWsmLjBSdSqvKf4ymoaQDQ"
)
STORAGE_CLAIMS = {
    "sub": "kc|alice",
    "email": "alice@example.com",
    "name": "Alice Ålund",
    "aud": "storage",
    "via": "remote",
    "exp": 1893456000,
}
NOW = 1893456000 - 60


def test_same_key_and_signatures_as_typescript():
    assert tokens.public_key(SECRET) == TS_PUBLIC_KEY
    assert tokens.sign(STORAGE_CLAIMS, SECRET) == TS_STORAGE


def test_reads_typescript_tokens_by_audience():
    assert tokens.verify(TS_STORAGE, SECRET, tokens.STORAGE_AUDIENCE, NOW) == STORAGE_CLAIMS
    # An X-Knowledge-User token has no audience; a storage token isn't one.
    assert tokens.verify(TS_USER, SECRET, None, NOW) == {
        "sub": "kc|alice",
        "email": "alice@example.com",
        "name": "Alice",
        "exp": 1893456000,
    }
    assert tokens.verify(TS_STORAGE, SECRET, None, NOW) is None
    assert tokens.verify(TS_USER, SECRET, tokens.STORAGE_AUDIENCE, NOW) is None


def test_refuses_expired_forged_and_other_secrets():
    assert tokens.verify(TS_USER, SECRET, None, 1893456000 + 1) is None
    assert tokens.verify(TS_USER, "another-secret-another-secret-another", None, NOW) is None
    head, body, signature = TS_USER.split(".")
    forged = tokens._b64(b'{"sub":"kc|mallory","exp":1893456000}')
    assert tokens.verify(f"{head}.{forged}.{signature}", SECRET, None, NOW) is None
    for bad in (None, "", "v1.a.b", "v2.only-two", f"{head}.{body}.short"):
        assert tokens.read(bad, SECRET, NOW) is None
    # Nobody signs in as "local", and a token needs a subject.
    assert (
        tokens.verify(tokens.sign({"sub": "local", "exp": 1893456000}, SECRET), SECRET, None, NOW)
        is None
    )
    assert tokens.verify(tokens.sign({"exp": 1893456000}, SECRET), SECRET, None, NOW) is None
    assert tokens.read(tokens.sign({"sub": "kc|a", "exp": True}, SECRET), SECRET, NOW) is None
