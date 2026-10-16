"""The sample agent's tools as an MCP server the chatroom's agent connects to.

Run it:

    python -m lab_tools.server            # http://127.0.0.1:9100/mcp

and point the chatroom at it (see ../README.md):

    MCP_SERVERS={"mcpServers":{"lab":{"url":"http://127.0.0.1:9100/mcp","forwardIdentity":true}}}

Claude sees these tools as mcp__lab__<tool>. Each tool's docstring and type
hints become what Claude reads, so write them for Claude.
"""

from __future__ import annotations

import os

from mcp.server.mcpserver import Context, MCPServer
from mcp.server.mcpserver.exceptions import ToolError

from . import identity, stats

# Must match the server's name in MCP_SERVERS: forwarded users are signed for it.
SERVER_NAME = os.environ.get("LAB_TOOLS_NAME", "lab")
# The chatroom's AUTH_SECRET when login is on; unset = no login.
AUTH_SECRET = os.environ.get("AUTH_SECRET") or None

mcp = MCPServer(
    SERVER_NAME,
    instructions="Statistics for experiment metrics: summarize one run, compare two runs.",
)


def require_user(ctx: Context) -> identity.User:
    """The signed-in user calling this tool; refuses calls that can't prove one."""
    user = identity.caller(ctx.headers, AUTH_SECRET, f"mcp:{SERVER_NAME}")
    if user is None:
        raise ToolError("Unknown caller: the chatroom must forward the user (forwardIdentity) with this AUTH_SECRET.")
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
    and a verdict ("better", "worse", "within noise", or too few repeats to tell).
    Set higher_is_better to false for metrics like loss or latency.
    """
    require_user(ctx)
    try:
        return stats.as_dict(stats.compare_runs(baseline, candidate, higher_is_better))
    except ValueError as err:
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
