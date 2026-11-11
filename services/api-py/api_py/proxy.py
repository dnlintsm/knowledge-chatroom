"""Every route not ported yet goes to the TypeScript agent server, untouched.

The request streams through as it came (method, path and query as sent,
headers, body) and the answer streams back (status, headers, body), so
uploads, downloads, the file watch (SSE) and chat runs work as before. Only
hop-by-hop headers are dropped, as any proxy does.
"""

from __future__ import annotations

import logging

import httpx
from fastapi import Request
from fastapi.responses import JSONResponse, Response, StreamingResponse
from starlette.background import BackgroundTask

logger = logging.getLogger("api_py")

# RFC 9110 §7.6.1, and Host, which httpx sets for the upstream.
HOP_BY_HOP = frozenset(
    {
        b"connection",
        b"keep-alive",
        b"proxy-authenticate",
        b"proxy-authorization",
        b"proxy-connection",
        b"te",
        b"trailer",
        b"transfer-encoding",
        b"upgrade",
        b"host",
    }
)


def client(upstream: str, transport: httpx.AsyncBaseTransport | None = None) -> httpx.AsyncClient:
    # No read timeout: watches and chat runs stay open as long as they need.
    return httpx.AsyncClient(
        base_url=upstream, transport=transport, timeout=httpx.Timeout(None, connect=10.0), follow_redirects=False
    )


def end_to_end(headers: list[tuple[bytes, bytes]]) -> list[tuple[bytes, bytes]]:
    """`headers` without hop-by-hop ones, including any that Connection names."""
    named = {
        token.strip().lower() for name, value in headers if name.lower() == b"connection" for token in value.split(b",")
    }
    return [(n, v) for n, v in headers if n.lower() not in HOP_BY_HOP and n.lower() not in named]


async def forward(request: Request, http: httpx.AsyncClient) -> Response:
    """Sends `request` to the TypeScript server and streams its answer back."""
    # The path as sent (percent-encoding kept, %2F included) and the query as is.
    target = (request.scope.get("raw_path") or request.scope["path"].encode()).decode("latin-1")
    if query := request.scope.get("query_string", b""):
        target += "?" + query.decode("latin-1")
    has_body = "content-length" in request.headers or "transfer-encoding" in request.headers
    upstream_request = http.build_request(
        request.method,
        target,
        headers=end_to_end(request.headers.raw),
        content=request.stream() if has_body else None,
    )
    try:
        upstream = await http.send(upstream_request, stream=True)
    except httpx.HTTPError as err:
        logger.warning("the TypeScript server didn't answer %s %s: %s", request.method, request.url.path, err)
        return JSONResponse({"error": "The agent server isn't reachable"}, status_code=502)
    response = StreamingResponse(
        upstream.aiter_raw(), status_code=upstream.status_code, background=BackgroundTask(upstream.aclose)
    )
    # The upstream's headers as they are (repeated ones, encodings), without hop-by-hop ones.
    response.raw_headers = end_to_end(list(upstream.headers.raw))
    return response
