"""The sample agent's tools as an MCP server the chatroom's agent connects to.

Run it:

    python -m lab_tools.server            # http://127.0.0.1:9100/mcp

and point the chatroom at it (see ../README.md):

    MCP_SERVERS={"mcpServers":{"lab":{"url":"http://127.0.0.1:9100/mcp","forwardIdentity":true,"storageAccess":true,"memoryAccess":true}}}

Claude sees these tools as mcp__lab__<tool>. Each tool's docstring and type
hints become what Claude reads, so write them for Claude.
"""

from __future__ import annotations

import csv
import io
import os

from mcp.server.mcpserver import Context, MCPServer
from mcp.server.mcpserver.exceptions import ToolError

from . import identity, memory, stats, workspace

# Must match the server's name in MCP_SERVERS: forwarded users are signed for it.
SERVER_NAME = os.environ.get("LAB_TOOLS_NAME", "lab")
# The chatroom's public key (agent GET /identity/public-key) when login is on;
# unset = no login. Never give this server AUTH_SECRET.
PUBLIC_KEY = identity.public_key(os.environ["KNOWLEDGE_PUBLIC_KEY"]) if os.environ.get("KNOWLEDGE_PUBLIC_KEY") else None
# The chatroom's agent server (LOCAL_AGENT_URL): its storage API for workspace
# files, and /memory/agent for the user's memory.
STORAGE_URL = os.environ.get("KNOWLEDGE_STORAGE_URL", "http://127.0.0.1:8000")

mcp = MCPServer(
    SERVER_NAME,
    instructions="Statistics for experiment metrics: summarize one run, compare two runs.",
)


def require_user(ctx: Context) -> identity.User:
    """The signed-in user calling this tool; refuses calls that can't prove one."""
    user = identity.caller(ctx.headers, PUBLIC_KEY, f"mcp:{SERVER_NAME}")
    if user is None:
        raise ToolError(
            "Unknown caller: the chatroom must forward the user (forwardIdentity), "
            "and this server needs the chatroom's KNOWLEDGE_PUBLIC_KEY."
        )
    return user


@mcp.tool()
def describe_metric(values: list[float], ctx: Context) -> dict:
    """Summarize one metric's values from a run: count, mean, standard deviation, median, min and max."""
    require_user(ctx)
    try:
        return stats.as_dict(stats.describe_metric(values))
    except ValueError as err:
        raise ToolError(str(err)) from err


@mcp.tool()
def compare_runs(baseline: list[float], candidate: list[float], ctx: Context, higher_is_better: bool = True) -> dict:
    """Compare a metric between a baseline run and a candidate run.

    Returns both summaries, the difference of means, the percent change, Welch's t
    and a verdict ("better", "worse", "within noise", "no change", or too few repeats to tell).
    Set higher_is_better to false for metrics like loss or latency.
    """
    require_user(ctx)
    try:
        return stats.as_dict(stats.compare_runs(baseline, candidate, higher_is_better))
    except ValueError as err:
        raise ToolError(str(err)) from err


@mcp.tool()
def describe_column(
    path: str, column: str, ctx: Context, node: str | None = None, experiment: str | None = None
) -> dict:
    """Summarize one numeric column of a CSV file in the user's workspace (count, mean, std, median, min, max).

    `path` is the file's path in its place: the workspace root, a knowledge node (`node` id)
    or an experiment (`experiment` id). Reads only files the user may read.
    """
    require_user(ctx)
    token = (ctx.headers or {}).get(workspace.STORAGE_HEADER)
    if PUBLIC_KEY and not token:
        raise ToolError('Workspace files need "storageAccess": true for this server in the chatroom\'s MCP_SERVERS.')
    try:
        content = workspace.read_text(STORAGE_URL, path, token, node=node, experiment=experiment)
    except workspace.WorkspaceError as err:
        raise ToolError(str(err)) from err
    rows = list(csv.DictReader(io.StringIO(content)))
    if rows and column not in rows[0]:
        raise ToolError(f"{path} has no column {column!r}; it has {', '.join(rows[0])}")
    try:
        values = [float(row[column]) for row in rows if row.get(column, "").strip()]
        return {"path": path, "column": column, **stats.as_dict(stats.describe_metric(values))}
    except ValueError as err:
        raise ToolError(f"{column}: {err}") from err


@mcp.tool()
def recall_user_notes(query: str, ctx: Context) -> str:
    """Search what the chatroom remembers about the user (their notes and the shared ones) for `query`.

    Use it before an analysis to find how the user likes results reported, e.g. "significance"
    or "units". Returns matching notes, one per line; read one in full with memory_view in the chat.
    """
    require_user(ctx)
    token = (ctx.headers or {}).get(memory.MEMORY_HEADER)
    if not token:
        raise ToolError(
            'No memory in this chat: it is incognito, memory is off, or this server lacks "memoryAccess": true.'
        )
    try:
        return memory.call_tool(STORAGE_URL, token, "memory_search", {"query": query})
    except memory.MemoryError_ as err:
        raise ToolError(str(err)) from err


@mcp.tool()
def whoami(ctx: Context) -> dict:
    """Which chatroom user is calling these tools. Use when the user asks who the lab tools think they are."""
    user = require_user(ctx)
    return {"sub": user.sub, "name": user.name, "email": user.email}


def main() -> None:
    mcp.run(
        transport="streamable-http",
        host=os.environ.get("LAB_TOOLS_HOST", "127.0.0.1"),
        port=int(os.environ.get("LAB_TOOLS_PORT", "9100")),
    )


if __name__ == "__main__":
    main()
