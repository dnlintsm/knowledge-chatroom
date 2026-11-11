"""The route groups this server serves itself (issue #190), one router each.

Each step of #190 adds one here; every other request goes to the TypeScript
server (proxy.py). A router added here takes its paths from that server, so
it has to pass the conformance suite (packages/contracts/conformance) first.
"""

from __future__ import annotations

from fastapi import APIRouter

from . import storage_routes

# Steps 2 and 3: /access, /nodes and /files (storage_routes.py).
ROUTERS: list[APIRouter] = [storage_routes.router]
# The storage API's sections served here once the database is ready.
STORAGE_PREFIXES = ("/access", "/nodes", "/files")
