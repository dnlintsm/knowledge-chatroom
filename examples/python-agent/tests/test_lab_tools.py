import base64
import json
from types import SimpleNamespace

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from lab_tools import identity, server, stats

# The chatroom's public key for AUTH_SECRET "0123456789abcdef0123456789abcdef",
# and tokens its agent signed with it (shared/identity-token.ts, the same values
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


def test_describe_metric():
    summary = stats.describe_metric([1, 2, 3, 4])
    assert (summary.n, summary.mean, summary.median, summary.min, summary.max) == (4, 2.5, 2.5, 1, 4)
    assert summary.std == pytest.approx(1.2910, abs=1e-4)
    assert stats.describe_metric([5]).std == 0.0
    with pytest.raises(ValueError):
        stats.describe_metric([])


def test_compare_runs_verdicts():
    baseline = [0.71, 0.73, 0.72]
    assert stats.compare_runs(baseline, [0.78, 0.80, 0.79]).verdict == "better"
    assert stats.compare_runs(baseline, [0.78, 0.80, 0.79], higher_is_better=False).verdict == "worse"
    assert stats.compare_runs(baseline, [0.70, 0.74, 0.72]).verdict == "within noise"
    assert stats.compare_runs([1.0], [2.0]).verdict == "not enough repeats to tell noise from change"
    # Constant repeats: no noise, so any difference counts.
    assert stats.compare_runs([1, 1, 1], [2, 2, 2]).verdict == "better"
    assert stats.compare_runs([1, 1, 1], [1, 1, 1]).verdict == "no change"
    result = stats.as_dict(stats.compare_runs(baseline, [0.78, 0.80, 0.79]))
    assert result["percent_change"] == pytest.approx(9.72, abs=0.01)
    json.dumps(result)


def test_identity_accepts_the_agents_token_for_this_server_only():
    user = identity.verify(FOR_LAB, PUBLIC_KEY, "mcp:lab")
    assert user == identity.User(sub="test|alice", email="alice@example.com", name="Alice")
    assert identity.verify(FOR_LAB, PUBLIC_KEY, "mcp:other") is None
    # The agent's own credential (no audience) is not a tool server's.
    assert identity.verify(FOR_AGENT, PUBLIC_KEY, "mcp:lab") is None
    assert identity.verify(FOR_LAB, TEST_KEY.public_key(), "mcp:lab") is None


def test_identity_refuses_expired_tampered_and_local_tokens():
    key = TEST_KEY.public_key()
    assert identity.verify(sign({"sub": "a", "exp": 4102444800, "aud": "mcp:lab"}), key, "mcp:lab").sub == "a"
    assert identity.verify(sign({"sub": "a", "exp": 1, "aud": "mcp:lab"}), key, "mcp:lab") is None
    assert identity.verify(sign({"sub": "local", "exp": 4102444800, "aud": "mcp:lab"}), key, "mcp:lab") is None
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


def test_tools_need_a_known_caller_when_login_is_on(monkeypatch):
    monkeypatch.setattr(server, "PUBLIC_KEY", PUBLIC_KEY)
    monkeypatch.setattr(server, "SERVER_NAME", "lab")
    assert server.whoami(SimpleNamespace(headers={identity.HEADER: FOR_LAB}))["sub"] == "test|alice"
    with pytest.raises(server.ToolError):
        server.describe_metric([1.0, 2.0], SimpleNamespace(headers={}))
    with pytest.raises(server.ToolError):
        server.describe_metric([], SimpleNamespace(headers={identity.HEADER: FOR_LAB}))
    assert server.compare_runs([1, 1.1, 0.9], [2, 2.1, 1.9], SimpleNamespace(headers={identity.HEADER: FOR_LAB}))["verdict"] == "better"
