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


def carries_content(input_data: RunAgentInput) -> bool:
    """
    Whether the run's context holds text from the workspace: the open file, the
    user's selection, or an experiment's details and report. That text is in
    the prompt before any tool runs, and other people may have written it, so a
    run with it is one that has read outside content (issue #285): its memory
    changes wait for the user. Where the user is and the list of file names
    don't count. Context this can't read does: unknown is not known to be safe.
    """
    for item in input_data.context or []:
        try:
            value = json.loads(item.value)
        except (TypeError, ValueError):
            return True
        if not isinstance(value, dict):
            return True
        if (
            isinstance(value.get("openFile"), dict)
            or value.get("selection")
            or value.get("currentExperiment")
        ):
            return True
    return False


def _compact(value: str) -> str:
    """The app sends JSON; keep it on as few lines as the content allows."""
    try:
        return json.dumps(json.loads(value), ensure_ascii=False)
    except (TypeError, ValueError):
        return value
