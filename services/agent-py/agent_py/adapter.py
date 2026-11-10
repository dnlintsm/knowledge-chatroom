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
- Skills (skills.py): each run asks the agent server for the user's skills in
  this chat, starts in the user's own folder holding them, and only /name for
  one of them stays a command. Each skill used goes to the chat as a
  `skill_used` event after RUN_STARTED, as the TypeScript agent sends it.
- Memory (memory.py): with the run's memory token, the system prompt gets the
  memory section and Claude the memory_* and chats_* tools, run by the agent
  server's /memory/agent. Each note they read or change goes to the chat as a
  `memory` event.
"""

from __future__ import annotations

import asyncio
import logging
from collections import OrderedDict
from collections.abc import AsyncIterator, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import httpx
from ag_ui.core import (
    BaseEvent,
    CustomEvent,
    EventType,
    RunAgentInput,
    TextInputContent,
    ToolMessage,
    UserMessage,
)
from ag_ui_claude_sdk import ClaudeAgentAdapter

from .memory import RunMemory, fetch_memory, memory_tools, taint_hook
from .place import workspace_note
from .skills import (
    RunSkill,
    Trigger,
    fetch_skills,
    materialize,
    skill_options,
    slash_command,
)
from .workspace import Storage, WorkspaceError, file_tools, server, tool_names

logger = logging.getLogger("agent_py")


@dataclass
class Run:
    """What a thread's latest run has: its folder, skills and memory, and events not yet sent."""

    cwd: Path | None = None
    skills: Sequence[RunSkill] = ()
    memory: RunMemory | None = None
    # (name, value) of CUSTOM events for the chat: skill_used, memory.
    pending: list[tuple[str, Any]] = field(default_factory=list)


class ChatroomAdapter(ClaudeAgentAdapter):
    def __init__(
        self,
        *args: Any,
        system_prompt: str = "",
        storage_url: str | None = None,
        skills_root: Path | None = None,
        transport: httpx.AsyncBaseTransport | None = None,
        **kwargs: Any,
    ) -> None:
        super().__init__(*args, **kwargs)
        self._system_prompt = system_prompt
        self._storage_url = storage_url
        self._transport = transport  # for tests
        # Each user's run folder (with their skills) is a folder in here.
        self._skills_root = skills_root
        # thread_id -> its latest run.
        self._runs: OrderedDict[str, Run] = OrderedDict()
        # Usage records on their way to the agent server.
        self._recording: set[asyncio.Task[Any]] = set()
        # thread_id -> the last <workspace> note the thread's session was given.
        self._notes: OrderedDict[str, str] = OrderedDict()
        # thread_id -> the storage token of the thread's latest run.
        self._tokens: OrderedDict[str, str | None] = OrderedDict()

    def build_options(
        self, input_data: RunAgentInput | None = None, thread_id: str | None = None, *args: Any, **kwargs: Any
    ):
        options = super().build_options(input_data, thread_id, *args, **kwargs)
        run = self._runs.get(thread_id or "")
        memory = run.memory if run else None
        options.system_prompt = f"{self._system_prompt}\n{memory.prompt}" if memory else self._system_prompt
        if self._storage_url and thread_id:
            tools = file_tools(
                lambda: self._storage(thread_id or ""),
                {"chat": thread_id, "model": options.model},
            )
            if memory:
                tools += memory_tools(
                    memory,
                    lambda: self._memory(thread_id or ""),
                    lambda: self._storage(thread_id or ""),
                    lambda event: self._event(thread_id or "", "memory", event),
                )
            options.mcp_servers = {**(options.mcp_servers or {}), "copilotkit": server(tools)}
            options.allowed_tools = [*(options.allowed_tools or []), *tool_names(tools)]
        if memory:
            hooks = dict(options.hooks or {})
            hooks["PreToolUse"] = [*hooks.get("PreToolUse", []), taint_hook(lambda: self._memory(thread_id or ""))]
            options.hooks = hooks
        if run and run.cwd:
            options.cwd = str(run.cwd)
        if run and run.skills:
            extra = skill_options(run.skills, lambda name, trigger: self._used(thread_id or "", name, trigger))
            hook = extra.pop("pre_tool_use")
            for key, value in extra.items():
                setattr(options, key, value)
            options.tools = [*(options.tools or []), "Skill"]
            hooks = dict(options.hooks or {})
            hooks["PreToolUse"] = [*hooks.get("PreToolUse", []), hook]
            options.hooks = hooks
        return options

    async def run(
        self,
        input_data: RunAgentInput,
        storage_token: str | None = None,
        user: str = "local",
        memory_token: str | None = None,
    ) -> AsyncIterator[BaseEvent]:
        """Runs `input_data` for `user` (their id).

        `storage_token` is its X-Knowledge-Storage header (with login), `memory_token` its X-Knowledge-Memory.
        """
        thread_id = input_data.thread_id
        remember(self._tokens, thread_id, storage_token, self._max_workers)
        run = Run()
        if self._skills_root is not None:
            run.skills = await self._skills_for(thread_id)
            try:
                run.cwd = materialize(self._skills_root, user, run.skills)
            except OSError as err:
                logger.warning("couldn't write the run's skills; running without them: %s", err)
                run.skills = ()
                run.cwd = materialize(self._skills_root, user, ())
        if memory_token and self._storage_url:
            try:
                run.memory = await fetch_memory(self._storage(thread_id), memory_token, input_data.run_id)
            except (WorkspaceError, ValueError) as err:
                logger.warning("couldn't load memory; running without it: %s", err)
            # After a browser tool (its result is the last message) the turn has
            # used another tool already: changes wait in the inbox from the start.
            if run.memory and input_data.messages and isinstance(input_data.messages[-1], ToolMessage):
                run.memory.tainted = True
        remember(self._runs, thread_id, run, self._max_workers)
        prepared, slash = self.prepare(input_data, run.skills)
        if slash:
            self._used(thread_id, slash.name, "slash")
        started = False
        async for event in super().run(prepared):
            yield event
            started = started or event.type == EventType.RUN_STARTED
            while started and run.pending:
                name, value = run.pending.pop(0)
                yield CustomEvent(type=EventType.CUSTOM, name=name, value=value)

    def _storage(self, thread_id: str) -> Storage:
        """The storage API with the thread's latest token: tools read it when called, not when the chat began."""
        return Storage(self._storage_url or "", self._tokens.get(thread_id), self._transport)

    def _memory(self, thread_id: str) -> RunMemory | None:
        """The memory of the thread's latest run: its tools use that run's token and state."""
        run = self._runs.get(thread_id)
        return run.memory if run else None

    def _event(self, thread_id: str, name: str, value: Any) -> None:
        """Queues a CUSTOM event for the thread's run, sent after the adapter's next event."""
        run = self._runs.get(thread_id)
        if run:
            run.pending.append((name, value))

    async def _skills_for(self, thread_id: str) -> list[RunSkill]:
        if not self._storage_url:
            return []
        try:
            return await fetch_skills(self._storage(thread_id), thread_id)
        except (WorkspaceError, KeyError, ValueError) as err:
            logger.warning("couldn't load skills; running without them: %s", err)
            return []

    def _used(self, thread_id: str, name: str, trigger: Trigger) -> None:
        """Notes that the thread's run used skill `name`: for the chat, and the usage history."""
        run = self._runs.get(thread_id)
        skill = next((s for s in run.skills if s.name == name), None) if run else None
        if not run or not skill:
            return
        run.pending.append(("skill_used", {"skill": skill.name, "source": skill.source, "trigger": trigger}))
        if self._storage_url:
            storage = self._storage(thread_id)
            body = {"thread": thread_id, "skill": skill.name, "trigger": trigger}
            task = asyncio.ensure_future(_record(storage, body))
            self._recording.add(task)
            task.add_done_callback(self._recording.discard)

    def prepare(self, input_data: RunAgentInput, skills: Sequence[RunSkill] = ()) -> tuple[RunAgentInput, RunSkill | None]:
        """This run's input as the session should see it, and the skill its /name runs, if any."""
        messages = list(input_data.messages or [])
        thread_id = input_data.thread_id
        note = workspace_note(input_data)
        last = messages[-1] if messages else None
        slash = None
        if isinstance(last, UserMessage):
            last, slash = guard_slash(last, skills)
            messages[-1] = last
        # A session that's new (first run, evicted or restarted) has seen no note.
        fresh = thread_id not in self._workers
        # After a browser tool, only the result it answers with: earlier ones
        # are history the adapter checks against the session's transcript.
        carrier = isinstance(last, UserMessage) or (
            isinstance(last, ToolMessage) and not (len(messages) > 1 and isinstance(messages[-2], ToolMessage))
        )
        if note and carrier and (fresh or self._notes.get(thread_id) != note):
            # A /name command must stay at the start of the prompt: its note goes after it.
            messages[-1] = with_note(last, note, after=slash is not None)
            remember(self._notes, thread_id, note, self._max_workers)
        return input_data.model_copy(update={"messages": messages, "forwarded_props": {}}), slash


async def _record(storage: Storage, body: dict[str, str]) -> None:
    """Best effort: a usage record never fails a run."""
    try:
        await storage.call("POST", "/skills/used", json_body=body)
    except WorkspaceError as err:
        logger.warning("couldn't record a skill use: %s", err)


def guard_slash(message: UserMessage, skills: Sequence[RunSkill]) -> tuple[UserMessage, RunSkill | None]:
    """The message with its first text guarded (skills.slash_command), and the skill it runs."""
    content = message.content
    if isinstance(content, str):
        text, skill = slash_command(content, skills)
        return (message if text == content else message.model_copy(update={"content": text})), skill
    for i, part in enumerate(content):
        if isinstance(part, TextInputContent):
            text, skill = slash_command(part.text, skills)
            if text == part.text:
                return message, skill
            parts = [*content[:i], part.model_copy(update={"text": text}), *content[i + 1 :]]
            return message.model_copy(update={"content": parts}), skill
    return message, None



def remember(cache: OrderedDict[str, Any], key: str, value: Any, size: int) -> None:
    """Sets `key`, keeping only the `size` most recent keys."""
    cache[key] = value
    cache.move_to_end(key)
    while len(cache) > size:
        cache.popitem(last=False)


def with_note(message: UserMessage | ToolMessage, note: str, after: bool = False) -> UserMessage | ToolMessage:
    """The user's message with `note` in front of it (or after it), or a tool's result with `note` after it."""
    content = message.content
    after = after or isinstance(message, ToolMessage)
    if isinstance(content, str):
        text = f"{content}\n\n{note}" if after else f"{note}\n\n{content}"
        return message.model_copy(update={"content": text})
    part = TextInputContent(text=note)
    return message.model_copy(update={"content": [*content, part] if after else [part, *content]})
