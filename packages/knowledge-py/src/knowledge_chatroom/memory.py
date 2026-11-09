"""Using the user's memory in the chat that calls this server (issue #93).

With "memoryAccess": true in MCP_SERVERS, runs where memory is on send this
server an X-Knowledge-Memory token for that chat. Passed on unchanged to the
chatroom's /memory/agent API (on the agent server, KNOWLEDGE_STORAGE_URL),
it reads the user's notes and proposes changes to them, as Claude does in
that chat: the same memory_* tools, and every change waits in the user's
Memory inbox. Incognito chats and memory turned off send no token.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request

MEMORY_HEADER = "x-knowledge-memory"


class MemoryError_(Exception):
    """The memory API refused or failed; the message is meant for Claude."""


def call_tool(base_url: str, token: str, tool: str, arguments: dict, timeout: float = 30) -> str:
    """Runs one memory_* tool (memory_view, memory_search, memory_save, ...) and returns its text."""
    url = f"{base_url.rstrip('/')}/memory/agent/tools/{urllib.parse.quote(tool)}"
    request = urllib.request.Request(
        url,
        data=json.dumps(arguments).encode("utf-8"),
        headers={MEMORY_HEADER: token, "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            result = json.loads(response.read())
    except urllib.error.HTTPError as err:
        raise MemoryError_(f"Memory isn't available ({err.code}): {_reason(err)}") from err
    except (urllib.error.URLError, TimeoutError) as err:
        raise MemoryError_(f"The chatroom's memory API at {base_url} isn't reachable: {err}") from err
    if result.get("isError"):
        raise MemoryError_(result.get("text") or "The memory tool failed")
    return result.get("text", "")


def _reason(err: urllib.error.HTTPError) -> str:
    try:
        return json.loads(err.read()).get("error") or err.reason
    except (ValueError, AttributeError):
        return str(err.reason)
