"""ClaudeAgentAdapter with the chatroom's per-run handling.

The adapter keeps one Claude session per thread and builds its options once, on
the thread's first run. Three things change that for this app:

- The system prompt stays the same for the whole chat. The adapter would append
  the first run's `context` and `state` to it, and they go out of date as the
  user moves around; each run brings them in a <workspace> note instead
  (place.py), in front of the user's message, whenever the note changed.
- `forwardedProps` come from the browser. The adapter turns whitelisted keys
  (`model`, `resume`, `max_budget_usd`, ...) into SDK options, so a browser
  could pick the model or resume another chat's session. They are dropped; the
  app's own `knowledge_chatroom` is read by place.py.
- No built-in Claude Code tools (Bash, Read, Write, ...): the model works on
  the workspace through the app's tools, not on this server's disk.
"""

from __future__ import annotations

from collections import OrderedDict
from collections.abc import AsyncIterator
from typing import Any

from ag_ui.core import BaseEvent, RunAgentInput, TextInputContent, UserMessage
from ag_ui_claude_sdk import ClaudeAgentAdapter

from .place import workspace_note


class ChatroomAdapter(ClaudeAgentAdapter):
    def __init__(self, *args: Any, system_prompt: str = "", **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self._system_prompt = system_prompt
        # thread_id -> the last <workspace> note the thread's session was given.
        self._notes: OrderedDict[str, str] = OrderedDict()

    def build_options(self, input_data: RunAgentInput | None = None, *args: Any, **kwargs: Any):
        options = super().build_options(input_data, *args, **kwargs)
        options.system_prompt = self._system_prompt
        return options

    async def run(self, input_data: RunAgentInput) -> AsyncIterator[BaseEvent]:
        async for event in super().run(self.prepare(input_data)):
            yield event

    def prepare(self, input_data: RunAgentInput) -> RunAgentInput:
        """This run's input as the session should see it."""
        messages = list(input_data.messages or [])
        thread_id = input_data.thread_id
        note = workspace_note(input_data)
        last = messages[-1] if messages else None
        # A session that's new (first run, evicted or restarted) has seen no note.
        fresh = thread_id not in self._workers
        if note and isinstance(last, UserMessage) and (fresh or self._notes.get(thread_id) != note):
            messages[-1] = with_note(last, note)
            self._remember(thread_id, note)
        return input_data.model_copy(update={"messages": messages, "forwarded_props": {}})

    def _remember(self, thread_id: str, note: str) -> None:
        self._notes[thread_id] = note
        self._notes.move_to_end(thread_id)
        while len(self._notes) > self._max_workers:
            self._notes.popitem(last=False)


def with_note(message: UserMessage, note: str) -> UserMessage:
    """The user's message with `note` in front of it."""
    content = message.content
    if isinstance(content, str):
        return message.model_copy(update={"content": f"{note}\n\n{content}"})
    return message.model_copy(update={"content": [TextInputContent(text=note), *content]})
