"""The user's memory in the chat (issue #176, step 4).

The Python twin of apps/agent/src/memory/run.ts, over HTTP. For each run of a
remote backend the app signs an X-Knowledge-Memory token for that chat (`via`
"remote"). With it the agent server's /memory/agent gives this agent what the
TypeScript agent's runs get: the prompt's memory section (with the index of
the user's notes) and the memory_* and chats_* tools, which run there.

- Nothing when memory is off on the server (404), off for the user or the
  chat is incognito (403), or there's no token: the run goes on without it.
  The server checks again on every call, so turning memory off mid-run stops
  the next one.
- Claude's changes are made with Undo while memory is on, and wait in the
  user's inbox once the run has used any other tool (`tainted`): the server
  says when a call itself taints the run (a shared note, a past chat), this
  agent's PreToolUse hook marks every other tool, and a run that continues
  after a browser tool (its result last) starts marked.
- Each note a call reads or changes comes back as an event, which goes to the
  chat as a `memory` event for its "Used / Updated" line, as the TypeScript
  agent sends it.
"""

from __future__ import annotations

import logging
import urllib.parse
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from claude_agent_sdk import HookMatcher, SdkMcpTool, tool

from .workspace import Storage, ToolResult, WorkspaceError, error

logger = logging.getLogger("agent_py")

MEMORY_HEADER = "X-Knowledge-Memory"
MEMORY_TOOLS = ("memory_view", "memory_search", "memory_save", "memory_edit", "memory_delete")
# Finding (deferred) tools brings in no outside content.
NEUTRAL_TOOLS = {"ToolSearch"}
OFF = "Memory is off in this chat now (the user turned it off or made the chat incognito): don't read or save notes."


@dataclass
class RunMemory:
    """One run's memory: its token, the prompt section and tools the server gave, and whether changes wait."""

    token: str
    run_id: str
    prompt: str
    tools: list[dict[str, Any]] = field(default_factory=list)
    tainted: bool = False


def is_memory_tool(name: str) -> bool:
    return any(name == t or name.endswith(f"__{t}") for t in MEMORY_TOOLS)


async def fetch_memory(storage: Storage, token: str, run_id: str) -> RunMemory | None:
    """The run's memory, or None when it has none here (off, incognito, no memory on the server)."""
    try:
        data = await storage.json("GET", "/memory/agent", headers={MEMORY_HEADER: token})
    except WorkspaceError as err:
        if err.status in (401, 403, 404):
            logger.debug("no memory for this run: %s", err)
            return None
        raise
    tools = [
        t for t in data.get("tools", []) if isinstance(t, dict) and isinstance(t.get("name"), str)
    ]
    return RunMemory(token=token, run_id=run_id, prompt=str(data.get("prompt") or ""), tools=tools)


def memory_tools(
    spec: RunMemory,
    current: Callable[[], RunMemory | None],
    storage: Callable[[], Storage],
    on_event: Callable[[dict[str, Any]], None],
) -> list[SdkMcpTool[Any]]:
    """The tools `spec` lists, each run on the agent server with the thread's latest run's memory (`current`)."""

    def make(name: str):
        async def handler(args: dict[str, Any]) -> ToolResult:
            memory = current()
            if memory is None:
                return error(OFF)
            try:
                answer = await storage().json(
                    "POST",
                    f"/memory/agent/tools/{urllib.parse.quote(name, safe='')}",
                    params={
                        "tainted": "1" if memory.tainted else "0",
                        "run": memory.run_id or None,
                    },
                    json_body=args,
                    headers={MEMORY_HEADER: memory.token},
                )
            except WorkspaceError as err:
                if err.status == 403:
                    return error(OFF)
                if err.status == 400:
                    return error(str(err))
                logger.warning("memory tool %s failed: %s", name, err)
                return error("Memory is unavailable right now")
            memory.tainted = memory.tainted or bool(answer.get("tainted"))
            for event in answer.get("events") or []:
                if isinstance(event, dict):
                    on_event(event)
            result: ToolResult = {
                "content": [{"type": "text", "text": str(answer.get("text", ""))}]
            }
            if answer.get("isError"):
                result["is_error"] = True
            return result

        return handler

    return [
        tool(
            t["name"],
            str(t.get("description", "")),
            t.get("inputSchema") or {"type": "object", "properties": {}},
        )(make(t["name"]))
        for t in spec.tools
    ]


def taint_hook(current: Callable[[], RunMemory | None]) -> HookMatcher:
    """Marks the run once it starts any tool but memory's, so its later changes wait in the inbox.

    Before the tool runs, so a save in the same batch already counts.
    """

    async def mark(input_data: Any, _tool_use_id: str | None, _context: Any) -> dict[str, Any]:
        name = input_data.get("tool_name")
        memory = current()
        if (
            memory
            and isinstance(name, str)
            and not is_memory_tool(name)
            and name not in NEUTRAL_TOOLS
        ):
            memory.tainted = True
        return {}

    return HookMatcher(hooks=[mark])
