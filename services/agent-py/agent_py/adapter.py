"""ClaudeAgentAdapter with the chatroom's per-run handling.

The adapter keeps one Claude session per thread and builds its options once, on
the thread's first run. Three things change that for this app:

- The system prompt stays the same for the whole chat. The adapter would append
  the first run's `context` and `state` to it, and they go out of date as the
  user moves around; each run brings them in a <workspace> note instead
  (place.py), in front of the user's message, whenever the note changed. A run
  that continues after a browser tool (openRun, openWorkspaceFile, ...) has no
  user message, so its note goes after that tool's result.
- `forwardedProps` come from the browser. The adapter turns whitelisted keys
  (`model`, `resume`, `max_budget_usd`, ...) into SDK options, so a browser
  could pick the model or resume another chat's session. They are dropped; the
  app's own `knowledge_chatroom` is read by place.py.
- No built-in Claude Code tools (Bash, Read, Write, ...): the model works on
  the workspace through the browser's tools and this agent's workspace tools
  (workspace.py), which call the storage API with the run's storage token.
"""

from __future__ import annotations

from collections import OrderedDict
from collections.abc import AsyncIterator
from typing import Any

from ag_ui.core import (
    BaseEvent,
    RunAgentInput,
    TextInputContent,
    ToolMessage,
    UserMessage,
)
from ag_ui_claude_sdk import ClaudeAgentAdapter

from .place import workspace_note
from .workspace import Storage, file_tools, server, tool_names


class ChatroomAdapter(ClaudeAgentAdapter):
    def __init__(
        self, *args: Any, system_prompt: str = "", storage_url: str | None = None, **kwargs: Any
    ) -> None:
        super().__init__(*args, **kwargs)
        self._system_prompt = system_prompt
        self._storage_url = storage_url
        # thread_id -> the last <workspace> note the thread's session was given.
        self._notes: OrderedDict[str, str] = OrderedDict()
        # thread_id -> the storage token of the thread's latest run.
        self._tokens: OrderedDict[str, str | None] = OrderedDict()

    def build_options(
        self, input_data: RunAgentInput | None = None, thread_id: str | None = None, *args: Any, **kwargs: Any
    ):
        options = super().build_options(input_data, thread_id, *args, **kwargs)
        options.system_prompt = self._system_prompt
        if self._storage_url and thread_id:
            # The tools ask for the storage API when called, so they use the
            # token of the run they're called in, not the chat's first.
            tools = file_tools(
                lambda: Storage(self._storage_url or "", self._tokens.get(thread_id)),
                {"chat": thread_id, "model": options.model},
            )
            options.mcp_servers = {**(options.mcp_servers or {}), "copilotkit": server(tools)}
            options.allowed_tools = [*(options.allowed_tools or []), *tool_names(tools)]
        return options

    async def run(
        self, input_data: RunAgentInput, storage_token: str | None = None
    ) -> AsyncIterator[BaseEvent]:
        """Runs `input_data`; `storage_token` is its X-Knowledge-Storage header (with login)."""
        remember(self._tokens, input_data.thread_id, storage_token, self._max_workers)
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
        # After a browser tool, only the result it answers with: earlier ones
        # are history the adapter checks against the session's transcript.
        carrier = isinstance(last, UserMessage) or (
            isinstance(last, ToolMessage) and not (len(messages) > 1 and isinstance(messages[-2], ToolMessage))
        )
        if note and carrier and (fresh or self._notes.get(thread_id) != note):
            messages[-1] = with_note(last, note)
            remember(self._notes, thread_id, note, self._max_workers)
        return input_data.model_copy(update={"messages": messages, "forwarded_props": {}})



def remember(cache: OrderedDict[str, Any], key: str, value: Any, size: int) -> None:
    """Sets `key`, keeping only the `size` most recent keys."""
    cache[key] = value
    cache.move_to_end(key)
    while len(cache) > size:
        cache.popitem(last=False)


def with_note(message: UserMessage | ToolMessage, note: str) -> UserMessage | ToolMessage:
    """The user's message with `note` in front of it, or a tool's result with `note` after it."""
    content = message.content
    after = isinstance(message, ToolMessage)
    if isinstance(content, str):
        text = f"{content}\n\n{note}" if after else f"{note}\n\n{content}"
        return message.model_copy(update={"content": text})
    part = TextInputContent(text=note)
    return message.model_copy(update={"content": [*content, part] if after else [part, *content]})
