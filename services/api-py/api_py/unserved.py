"""The answer to a request no route serves.

A router calls not_served() for a path under its prefix that isn't one of its
routes, or while what it needs isn't there (storage still starting, no object
store, memory off). The app's last route answers everything else with it.
"""

from __future__ import annotations

from fastapi import Request
from fastapi.responses import JSONResponse, Response


def _storage_path(request: Request, also: tuple[str, ...] = ()) -> bool:
    """Whether the request is for a route storage serves (routes.STORAGE_PREFIXES), or one under `also`."""
    from .routes import STORAGE_PREFIXES

    path = request.url.path
    return any(path == p or path.startswith(p + "/") for p in (*STORAGE_PREFIXES, *also))


def not_served(request: Request) -> Response:
    """404, or 503 while the storage the request is for isn't served."""
    state = request.app.state
    # /memory too: users' notes are in the same database, behind the same policies.
    if getattr(state, "row_security_refused", False) and _storage_path(request, ("/memory",)):
        # ROW_SECURITY=required, and Postgres can't enforce access.
        return JSONResponse(
            {"error": "Storage is not served: row-level security is required and off"},
            status_code=503,
        )
    # A configured database that is still starting must not look like missing content.
    if _storage_path(request) and state.settings.database_url and state.storage is None:
        return JSONResponse({"error": "Storage is not ready"}, status_code=503)
    return JSONResponse({"error": "Not found"}, status_code=404)
