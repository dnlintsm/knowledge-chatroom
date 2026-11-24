"""Keeps this server's Anthropic credentials away from skills' scripts.

Claude Code's Bash
inherits Claude Code's environment, so a run with scripts gets a stand-in key
instead: it talks to Anthropic through this proxy on 127.0.0.1, which swaps the
stand-in for the real key (ANTHROPIC_API_KEY, else ANTHROPIC_AUTH_TOKEN). Scripts
run without network (scripts.py), so even the stand-in is no use to them.
"""

from __future__ import annotations

import asyncio
import hmac
import logging
import os
import re
import secrets
import socket
from collections.abc import AsyncIterator, Mapping
from dataclasses import dataclass
from typing import Any

import httpx
import uvicorn
from starlette.background import BackgroundTask
from starlette.requests import Request
from starlette.responses import JSONResponse, Response, StreamingResponse

logger = logging.getLogger("agent_py")

# Headers not passed on: per hop, recomputed when the body is sent again, or the key.
DROP = frozenset(
    {
        "host",
        "connection",
        "keep-alive",
        "transfer-encoding",
        "content-length",
        "x-api-key",
        "authorization",
        "proxy-authorization",
    }
)
_BEARER = re.compile(r"^Bearer\s+", re.IGNORECASE)


@dataclass(frozen=True)
class KeyRoute:
    """How a run with scripts reaches Anthropic."""

    base_url: str  # ANTHROPIC_BASE_URL for the run
    api_key: str  # ANTHROPIC_API_KEY for the run: only this proxy accepts it


def upstream_auth(env: Mapping[str, str]) -> dict[str, str]:
    """The real credentials, read when each request goes out."""
    if env.get("ANTHROPIC_API_KEY"):
        return {"x-api-key": env["ANTHROPIC_API_KEY"]}
    if env.get("ANTHROPIC_AUTH_TOKEN"):
        return {"authorization": f"Bearer {env['ANTHROPIC_AUTH_TOKEN']}"}
    return {}


def _error(status: int, kind: str, message: str) -> Response:
    return JSONResponse({"type": "error", "error": {"type": kind, "message": message}}, status)


class KeyProxy:
    """A proxy to `upstream` on 127.0.0.1 that accepts only its own stand-in key."""

    def __init__(
        self,
        upstream: str | None = None,
        env: Mapping[str, str] | None = None,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._env = os.environ if env is None else env
        base = upstream or self._env.get("ANTHROPIC_BASE_URL") or "https://api.anthropic.com"
        self._upstream = base.rstrip("/")
        self.api_key = f"sk-ant-run-{secrets.token_hex(24)}"
        # Long reads: a model can think a while between streamed chunks.
        self._client = httpx.AsyncClient(
            transport=transport, timeout=httpx.Timeout(600, connect=30)
        )
        self._server: uvicorn.Server | None = None
        self._task: asyncio.Task[None] | None = None
        self.base_url = ""

    @property
    def route(self) -> KeyRoute:
        return KeyRoute(self.base_url, self.api_key)

    async def start(self) -> KeyRoute:
        """Listens on a free port of 127.0.0.1; returns once it does."""
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
        config = uvicorn.Config(self, lifespan="off", log_level="warning", access_log=False)
        self._server = uvicorn.Server(config)
        self._task = asyncio.create_task(self._server.serve(sockets=[sock]))
        while not self._server.started:
            if self._task.done():
                sock.close()
                raise OSError(f"key proxy didn't start: {self._task.exception()!r}")
            await asyncio.sleep(0.01)
        self.base_url = f"http://127.0.0.1:{port}"
        return self.route

    async def close(self) -> None:
        if self._server and self._task:
            self._server.should_exit = True
            await self._task
        await self._client.aclose()

    async def __call__(self, scope: Any, receive: Any, send: Any) -> None:
        if scope["type"] != "http":
            return
        response = await self.handle(Request(scope, receive))
        await response(scope, receive, send)

    async def handle(self, request: Request) -> Response:
        given = request.headers.get("x-api-key") or _BEARER.sub(
            "", request.headers.get("authorization", "")
        )
        if not given or not hmac.compare_digest(given.encode(), self.api_key.encode()):
            return _error(401, "authentication_error", "unknown key")
        body = await request.body()
        headers = {k: v for k, v in request.headers.items() if k.lower() not in DROP}
        url = self._upstream + request.url.path
        if request.url.query:
            url += f"?{request.url.query}"
        has_body = request.method not in ("GET", "HEAD")
        try:
            answer = await self._client.send(
                self._client.build_request(
                    request.method,
                    url,
                    headers={**headers, **upstream_auth(self._env)},
                    content=body if has_body else None,
                ),
                stream=True,
            )
        except httpx.HTTPError as err:
            logger.error("[skills] key proxy: %s", err)
            return _error(502, "api_error", "upstream unreachable")
        # httpx decodes the body, so its content-encoding goes too.
        out = {
            k: v
            for k, v in answer.headers.items()
            if k.lower() not in DROP and k.lower() != "content-encoding"
        }
        return StreamingResponse(
            _chunks(answer),
            status_code=answer.status_code,
            headers=out,
            background=BackgroundTask(answer.aclose),
        )


async def _chunks(answer: httpx.Response) -> AsyncIterator[bytes]:
    # An upstream reset mid-stream ends this response; it doesn't crash the proxy.
    try:
        async for chunk in answer.aiter_bytes():
            yield chunk
    except httpx.HTTPError as err:
        logger.error("[skills] key proxy: upstream stream ended: %s", err)
