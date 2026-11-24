"""The storage client the MCP servers share: what it sends, and to whom."""

from __future__ import annotations

import threading
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from knowledge_chatroom import storage


class _Server(ThreadingHTTPServer):
    """A local server that records each request's path and headers and answers as told."""

    def __init__(self, answer) -> None:
        self.seen: list[tuple[str, str, dict[str, str]]] = []
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def _serve(self) -> None:
                length = int(self.headers.get("content-length") or 0)
                self.rfile.read(length)
                headers = {k.lower(): v for k, v in self.headers.items()}
                outer.seen.append((self.command, self.path, headers))
                status, extra, body = answer(self.path)
                self.send_response(status)
                for name, value in extra.items():
                    self.send_header(name, value)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            do_GET = do_PUT = _serve

            def log_message(self, *args) -> None:
                pass

        super().__init__(("127.0.0.1", 0), Handler)

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.server_address[1]}"


@pytest.fixture
def serve() -> Iterator:
    servers: list[_Server] = []

    def start(answer) -> _Server:
        server = _Server(answer)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        servers.append(server)
        return server

    yield start
    for server in servers:
        server.shutdown()
        server.server_close()


def test_reads_and_writes_carry_the_token_to_the_storage_api(serve):
    api = serve(lambda path: (200, {"Content-Type": "text/markdown"}, b"# Notes"))
    assert storage.read_text(api.url, "notes/a.md", "tok", node="n1") == "# Notes"
    assert storage.write(api.url, "notes/a.md", b"x", "text/markdown", "tok", node="n1") is True
    assert storage.write(api.url, "notes/a.md", b"x", "text/markdown", None) is False
    (get, put, plain) = api.seen
    assert (get[0], get[1], get[2]["x-knowledge-storage"]) == ("GET", "/files/notes/a.md?node=n1", "tok")
    assert (put[0], put[1], put[2]["x-knowledge-storage"]) == (
        "PUT",
        "/files/notes/a.md?node=n1&propose=",
        "tok",
    )
    assert "x-knowledge-storage" not in plain[2]


@pytest.mark.parametrize("status", [301, 302, 303, 307, 308])
def test_the_token_is_never_sent_on_to_where_the_api_redirects(serve, status):
    """A binary file is answered with a link to the object store, which must not get the user's token."""
    store = serve(lambda path: (200, {}, b"\x89PNG"))
    api = serve(lambda path: (status, {"Location": f"{store.url}/bucket/blob?signature=s"}, b""))
    with pytest.raises(storage.WorkspaceError, match="uploads/pic.png isn't a text file"):
        storage.read_text(api.url, "uploads/pic.png", "tok")
    assert len(api.seen) == 1
    assert store.seen == []


def test_refusals_carry_the_apis_reason(serve):
    api = serve(lambda path: (403, {"Content-Type": "application/json"}, b'{"error": "You can only view here"}'))
    with pytest.raises(storage.WorkspaceError, match=r"Couldn't read a.md \(403\): You can only view here"):
        storage.read_text(api.url, "a.md", "tok")
    with pytest.raises(storage.WorkspaceError, match=r"Couldn't save a.md \(403\): You can only view here"):
        storage.write(api.url, "a.md", b"x", "text/markdown", "tok")
