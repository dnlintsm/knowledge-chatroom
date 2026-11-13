"""The route groups this server serves itself (issue #190), one router each.

Each step of #190 adds one here; every other request goes to the TypeScript
server (proxy.py). A router added here takes its paths from that server, so
it has to pass the conformance suite (packages/contracts/conformance) first.
"""

from __future__ import annotations

from fastapi import APIRouter

from . import memory_routes, server_routes, skills_routes, storage_routes, tools, workspaces

# Steps 2 to 6: /access, /nodes, /files, /experiments, /proposals, /search and /chats (storage_routes.py);
# step 7: /skills and /hub (skills_routes.py), and /tools (tools.py; no storage needed);
# step 8: /memory (memory_routes.py, with MEMORY=on);
# step 9: /identity/public-key, /identity/mcp-tokens and /suggest (server_routes.py; no storage needed);
# /workspaces (workspaces.py, issue #226), served here only.
ROUTERS: list[APIRouter] = [
    workspaces.router,
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
)
