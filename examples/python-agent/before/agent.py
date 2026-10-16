"""BEFORE: the sample as a standalone Python Claude Agent SDK agent.

This is the shape an existing agent usually has: a system prompt, some @tool
functions in an in-process MCP server, and a query() loop. It is here only to
show where each part goes in the chatroom (see ../README.md); the chatroom does
not run this file.

    pip install claude-agent-sdk
    python before/agent.py "Compare baseline [0.71, 0.73, 0.72] with candidate [0.78, 0.80, 0.79]"
"""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

from claude_agent_sdk import (
    AssistantMessage,
    ClaudeAgentOptions,
    TextBlock,
    create_sdk_mcp_server,
    query,
    tool,
)

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from lab_tools import stats  # noqa: E402  (the same logic the MCP server uses)

# 1. The system prompt → becomes skills/lab-analyst/SKILL.md in the chatroom.
SYSTEM_PROMPT = """You are a lab analyst. When the user gives metric values from experiment runs,
use describe_metric for one run and compare_runs for two. Report the verdict first, then the
numbers that support it, and say when there are too few repeats to tell."""


def _json(result: object) -> dict:
    return {"content": [{"type": "text", "text": json.dumps(stats.as_dict(result))}]}


# 2. The @tool functions → become MCP tools in lab_tools/server.py (same logic).
@tool("describe_metric", "Summarize one metric's values from a run.", {"values": list[float]})
async def describe_metric(args: dict) -> dict:
    return _json(stats.describe_metric(args["values"]))


@tool(
    "compare_runs",
    "Compare a metric between a baseline run and a candidate run.",
    {"baseline": list[float], "candidate": list[float], "higher_is_better": bool},
)
async def compare_runs(args: dict) -> dict:
    return _json(stats.compare_runs(args["baseline"], args["candidate"], args.get("higher_is_better", True)))


# 3. The in-process server and allowed tools → become MCP_SERVERS in the chatroom.
lab = create_sdk_mcp_server("lab", tools=[describe_metric, compare_runs])
OPTIONS = ClaudeAgentOptions(
    system_prompt=SYSTEM_PROMPT,
    mcp_servers={"lab": lab},
    allowed_tools=["mcp__lab__describe_metric", "mcp__lab__compare_runs"],
)


async def main(prompt: str) -> None:
    async for message in query(prompt=prompt, options=OPTIONS):
        if isinstance(message, AssistantMessage):
            for block in message.content:
                if isinstance(block, TextBlock):
                    print(block.text)


if __name__ == "__main__":
    asyncio.run(main(" ".join(sys.argv[1:]) or "Summarize [1, 2, 3, 4]"))
