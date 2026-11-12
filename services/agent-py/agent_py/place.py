"""Where the user is, for each run.

The adapter builds a thread's Claude options, and with them the system prompt,
once: on the chat's first run. The app's `context` (the open file, the
selection, the current node and experiment) and `forwardedProps.knowledge_chatroom`
change between runs, so each run carries them in a <workspace> note in front of
the user's message instead (docs/remote-agent.md, "Options ... are built once per
thread").
"""

from __future__ import annotations

import json
from typing import Any

from ag_ui.core import RunAgentInput

PROPS = "knowledge_chatroom"


def chatroom_props(input_data: RunAgentInput) -> dict[str, Any]:
    """The app's run payload (apps/web/src/lib/chatroom-props.ts); {} when absent."""
    props = (input_data.forwarded_props or {}).get(PROPS)
    return props if isinstance(props, dict) else {}


def workspace_note(input_data: RunAgentInput) -> str:
    """This run's <workspace> note; "" when the app sent nothing to put in it."""
    parts: list[str] = []
    for item in input_data.context or []:
        parts.append(f"{item.description}\n{_compact(item.value)}")
    storage = chatroom_props(input_data).get("storage")
    if storage == "local":
        parts.append(
            "Files live only in the user's browser: use the browser's workspace file tools."
        )
    if input_data.state:
        parts.append(f"Shared state (current):\n{json.dumps(input_data.state, ensure_ascii=False)}")
    if not parts:
        return ""
    return "<workspace>\n" + "\n\n".join(parts) + "\n</workspace>"


def _compact(value: str) -> str:
    """The app sends JSON; keep it on as few lines as the content allows."""
    try:
        return json.dumps(json.loads(value), ensure_ascii=False)
    except (TypeError, ValueError):
        return value
