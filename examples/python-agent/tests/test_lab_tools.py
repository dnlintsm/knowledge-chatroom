import base64
import hashlib
import hmac
import json
from types import SimpleNamespace

import pytest

from lab_tools import identity, server, stats

SECRET = "test-secret-xxxxxxxxxxxxxxxxxxxx"
# Signed by the chatroom's agent (agent/src/storage/identity.ts signIdentity),
# so these tests break if the two sides stop agreeing on the format.
FOR_LAB = (
    "v1.eyJzdWIiOiJ0ZXN0fGFsaWNlIiwiZW1haWwiOiJhbGljZUBleGFtcGxlLmNvbSIsIm5hbWUiOiJBbGljZSIsImV4cCI6NDEwMjQ0NDgwMCwiYXVkIjoibWNwOmxhYiJ9"
    ".YK4QjA3Lh4lqZjLri_qNk0SIGJqWPIQFJ1lRomEdL88"
)
FOR_AGENT = "v1.eyJzdWIiOiJ0ZXN0fGFsaWNlIiwiZXhwIjo0MTAyNDQ0ODAwfQ._Ga7Vo6n-I4vYGARXLRPb5tcKg8MHbH0-ZARnZnH0zg"


def sign(payload: dict, secret: str = SECRET) -> str:
    body = "v1." + base64.urlsafe_b64encode(json.dumps(payload).encode()).decode().rstrip("=")
    mac = hmac.new(secret.encode(), body.encode(), hashlib.sha256).digest()
    return body + "." + base64.urlsafe_b64encode(mac).decode().rstrip("=")


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
    assert stats.compare_runs([1.0], [2.0]).welch_t is None
    result = stats.as_dict(stats.compare_runs(baseline, [0.78, 0.80, 0.79]))
    assert result["percent_change"] == pytest.approx(9.72, abs=0.01)
    json.dumps(result)


def test_identity_accepts_the_agents_token_for_this_server_only():
    user = identity.verify(FOR_LAB, SECRET, "mcp:lab")
    assert user == identity.User(sub="test|alice", email="alice@example.com", name="Alice")
    assert identity.verify(FOR_LAB, SECRET, "mcp:other") is None
    # The agent's own credential (no audience) is not a tool server's.
    assert identity.verify(FOR_AGENT, SECRET, "mcp:lab") is None
    assert identity.verify(FOR_LAB, "wrong-secret-xxxxxxxxxxxxxxxxxxx", "mcp:lab") is None


def test_identity_refuses_expired_tampered_and_local_tokens():
    assert identity.verify(sign({"sub": "a", "exp": 1, "aud": "mcp:lab"}), SECRET, "mcp:lab") is None
    assert identity.verify(sign({"sub": "local", "exp": 4102444800, "aud": "mcp:lab"}), SECRET, "mcp:lab") is None
    head, payload, mac = FOR_LAB.split(".")
    assert identity.verify(f"{head}.e30.{mac}", SECRET, "mcp:lab") is None
    assert identity.verify("garbage", SECRET, "mcp:lab") is None


def test_caller_without_login_is_the_local_user():
    assert identity.caller(None, None, "mcp:lab") == identity.LOCAL_USER
    assert identity.caller({}, SECRET, "mcp:lab") is None
    assert identity.caller({identity.HEADER: FOR_LAB}, SECRET, "mcp:lab").sub == "test|alice"


def test_tools_need_a_known_caller_when_login_is_on(monkeypatch):
    monkeypatch.setattr(server, "AUTH_SECRET", SECRET)
    monkeypatch.setattr(server, "SERVER_NAME", "lab")
    assert server.whoami(SimpleNamespace(headers={identity.HEADER: FOR_LAB}))["sub"] == "test|alice"
    with pytest.raises(server.ToolError):
        server.describe_metric([1.0, 2.0], SimpleNamespace(headers={}))
    with pytest.raises(server.ToolError):
        server.describe_metric([], SimpleNamespace(headers={identity.HEADER: FOR_LAB}))
    assert server.compare_runs([1, 1.1, 0.9], [2, 2.1, 1.9], SimpleNamespace(headers={identity.HEADER: FOR_LAB}))["verdict"] == "better"
