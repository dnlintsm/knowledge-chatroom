"""The route groups this server serves, one router each.

Every other request goes to proxy.forward, which answers 404 unless
TS_AGENT_URL is set. A route added here is in the API's spec
(packages/contracts/openapi/storage.yaml) and its conformance suite
(packages/contracts/conformance).
"""

from __future__ import annotations

from fastapi import APIRouter

from . import (
    memory_routes,
    platform,
    server_routes,
    skills_routes,
    storage_routes,
    tools,
    workspaces,
)

# Steps 2 to 6: /access, /nodes, /files, /experiments, /proposals, /search and /chats (storage_routes.py);
# step 7: /skills and /hub (skills_routes.py), and /tools (tools.py; no storage needed);
# step 8: /memory (memory_routes.py, with MEMORY=on);
# step 9: /identity/public-key, /identity/mcp-tokens and /suggest (server_routes.py; no storage needed);
# /workspaces (workspaces.py) and /platform (platform.py), served here only.
ROUTERS: list[APIRouter] = [
    workspaces.router,
    platform.router,
    storage_routes.router,
    skills_routes.router,
    tools.router,
    memory_routes.router,
    server_routes.router,
]
# The storage API's sections served here once the database is ready.
STORAGE_PREFIXES = (
    "/access",
    "/nodes",
    "/files",
    "/experiments",
    "/proposals",
    "/search",
    "/chats",
    "/skills",
    "/hub",
    "/workspaces",
    "/platform",
)
