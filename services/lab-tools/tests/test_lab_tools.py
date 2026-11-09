import json
from types import SimpleNamespace

import pytest
from knowledge_chatroom import identity, memory, storage
from lab_tools import server, stats

# The chatroom's public key for AUTH_SECRET "0123456789abcdef0123456789abcdef",
# and tokens its agent signed with it (packages/contracts/src/identity-token.ts, the same values
# as tests/unit/identity-token.spec.ts), so these tests break if the two sides
# stop agreeing on the format.
PUBLIC_KEY = identity.public_key("Z1iN8KqPV0u2Dk95GsXXFlHQE05RT15l2-1TzD3XDI8")
FOR_LAB = (
    "v2.eyJzdWIiOiJ0ZXN0fGFsaWNlIiwiZW1haWwiOiJhbGljZUBleGFtcGxlLmNvbSIsIm5hbWUiOiJBbGljZSIsImV4cCI6NDEwMjQ0NDgwMCwiYXVkIjoibWNwOmxhYiJ9"
    ".3PaC2ATVNb3697brWOY91ggVm8HHdIqlYHdGdcVL1N_sUN7V51VIjmgr5HzvZMfJU7jD9Qxn4QBYjl1VuGm0DA"
)


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


def test_tools_need_a_known_caller_when_login_is_on(monkeypatch):
    monkeypatch.setattr(server, "PUBLIC_KEY", PUBLIC_KEY)
    monkeypatch.setattr(server, "SERVER_NAME", "lab")
    assert server.whoami(SimpleNamespace(headers={identity.HEADER: FOR_LAB}))["sub"] == "test|alice"
    with pytest.raises(server.ToolError):
        server.describe_metric([1.0, 2.0], SimpleNamespace(headers={}))
    with pytest.raises(server.ToolError):
        server.describe_metric([], SimpleNamespace(headers={identity.HEADER: FOR_LAB}))
    assert server.compare_runs([1, 1.1, 0.9], [2, 2.1, 1.9], SimpleNamespace(headers={identity.HEADER: FOR_LAB}))["verdict"] == "better"


@pytest.fixture
def storage_api(monkeypatch):
    """A stand-in for the chatroom's storage API: alice's token may read data/run.csv, nothing else."""
    from http.server import BaseHTTPRequestHandler, HTTPServer
    import threading

    seen = []

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802
            seen.append((self.path, self.headers.get(storage.STORAGE_HEADER)))
            if self.headers.get(storage.STORAGE_HEADER) != "alice-storage-token":
                self._send(401, b'{"error": "Sign in to use the workspace"}')
            elif self.path.startswith("/files/data/run.csv"):
                self._send(200, b"step,loss\n1,0.9\n2,0.7\n3,0.5\n")
            else:
                self._send(404, b'{"error": "Not found"}')

        def _send(self, status, body):
            self.send_response(status)
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args):
            pass

    httpd = HTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    monkeypatch.setattr(server, "STORAGE_URL", f"http://127.0.0.1:{httpd.server_port}")
    monkeypatch.setattr(server, "PUBLIC_KEY", PUBLIC_KEY)
    monkeypatch.setattr(server, "SERVER_NAME", "lab")
    yield seen
    httpd.shutdown()


def test_workspace_files_are_read_with_the_runs_storage_token(storage_api):
    ctx = SimpleNamespace(headers={identity.HEADER: FOR_LAB, storage.STORAGE_HEADER: "alice-storage-token"})
    result = server.describe_column("data/run.csv", "loss", ctx, node="n1")
    assert (result["n"], result["mean"], result["min"]) == (3, pytest.approx(0.7), 0.5)
    # Passed on unchanged, with the place.
    assert storage_api[-1] == ("/files/data/run.csv?node=n1", "alice-storage-token")
    with pytest.raises(server.ToolError, match="no column 'acc'"):
        server.describe_column("data/run.csv", "acc", ctx)
    with pytest.raises(server.ToolError, match=r"\(404\): Not found"):
        server.describe_column("data/other.csv", "loss", ctx)


def test_workspace_files_need_the_storage_token(storage_api):
    ctx = SimpleNamespace(headers={identity.HEADER: FOR_LAB})
    with pytest.raises(server.ToolError, match="storageAccess"):
        server.describe_column("data/run.csv", "loss", ctx)
    ctx.headers[storage.STORAGE_HEADER] = "someone-elses-token"
    with pytest.raises(server.ToolError, match=r"\(401\)"):
        server.describe_column("data/run.csv", "loss", ctx)


@pytest.fixture
def memory_api(monkeypatch):
    """A stand-in for the chatroom's /memory/agent: alice's memory token finds one note."""
    from http.server import BaseHTTPRequestHandler, HTTPServer
    import json
    import threading

    seen = []

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):  # noqa: N802
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            seen.append((self.path, self.headers.get(memory.MEMORY_HEADER), body))
            if self.headers.get(memory.MEMORY_HEADER) != "alice-memory-token":
                self._send(401, {"error": "This needs the X-Knowledge-Memory token of a run (memoryAccess)"})
            else:
                self._send(200, {"text": "- reporting (preference): p < 0.01 for significance", "isError": False})

        def _send(self, status, body):
            data = json.dumps(body).encode()
            self.send_response(status)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def log_message(self, *args):
            pass

    httpd = HTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    monkeypatch.setattr(server, "STORAGE_URL", f"http://127.0.0.1:{httpd.server_port}")
    monkeypatch.setattr(server, "PUBLIC_KEY", PUBLIC_KEY)
    monkeypatch.setattr(server, "SERVER_NAME", "lab")
    yield seen
    httpd.shutdown()


def test_user_notes_are_searched_with_the_runs_memory_token(memory_api):
    ctx = SimpleNamespace(headers={identity.HEADER: FOR_LAB, memory.MEMORY_HEADER: "alice-memory-token"})
    assert "p < 0.01" in server.recall_user_notes("significance", ctx)
    assert memory_api[-1] == ("/memory/agent/tools/memory_search", "alice-memory-token", {"query": "significance"})
    ctx.headers[memory.MEMORY_HEADER] = "stale-token"
    with pytest.raises(server.ToolError, match=r"\(401\)"):
        server.recall_user_notes("significance", ctx)
    del ctx.headers[memory.MEMORY_HEADER]
    with pytest.raises(server.ToolError, match="memoryAccess"):
        server.recall_user_notes("significance", ctx)
