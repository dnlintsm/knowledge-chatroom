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
  could pass arbitrary SDK settings. They are dropped. The app reads the
  namespaced model choice separately and checks it against the deployment's models.
- No built-in Claude Code tools (Bash, Read, Write, ...): the model works on
  the workspace through the browser's tools and this agent's workspace tools
  (workspace.py), which call the storage API with the run's storage token.
- Skills (skills.py): each run asks api-py for the user's skills in
  this chat, starts in the user's own folder holding them, and only /name for
  one of them stays a command. Each skill used goes to the chat as a
  `skill_used` event after RUN_STARTED.
  With SKILL_SCRIPTS=on, a run with a skill that ships scripts also gets Bash,
  sandboxed, with a stand-in API key (scripts.py, keyproxy.py).
- Working folder (workdir.py): the user's folder holds a read-only copy of the
  workspace files they can read, synced at the start of each run, which Claude
  searches with Read, Glob and Grep (confined to the folder); save_file stores
  a file from the folder in the workspace. AGENT_WORKDIR=off turns it off.
- Memory (memory.py): with the run's memory token, the system prompt gets the
  memory section and Claude the memory_* and chats_* tools, run by the agent
  server's /memory/agent. Each note they read or change goes to the chat as a
  `memory` event.
- Outside MCP servers (mcp.py): the servers in MCP_SERVERS, each run with the
  user's tokens for them, and the chat's tool chips in the prompt.
- Revocation (revocation.py): a run whose user is removed from its workspace,
  or sees it archived, stops at the next tool boundary.
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import json
import logging
import time
from collections import Counter, OrderedDict
from collections.abc import AsyncGenerator, AsyncIterator, Mapping, Sequence
from contextlib import aclosing, asynccontextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, cast
from weakref import WeakValueDictionary

import httpx
from ag_ui.core import (
    BaseEvent,
    CustomEvent,
    EventType,
    RunAgentInput,
    RunErrorEvent,
    TextInputContent,
    ToolMessage,
    UserMessage,
)
from ag_ui_claude_sdk import ClaudeAgentAdapter

from .keyproxy import KeyProxy, KeyRoute
from .mcp import McpServer, RunServers, chips_from, run_servers, trade_tokens
from .memory import RunMemory, fetch_memory, memory_tools, taint_hook
from .place import carries_content, chatroom_props, workspace_note
from .revocation import membership_hooks
from .scripts import Scripts, needs_scripts, script_options
from .skills import (
    RunSkill,
    Trigger,
    fetch_skills,
    materialize,
    run_folder,
    skill_options,
    slash_command,
)
from .workdir import (
    CONFINED_TOOLS,
    Limits,
    Summary,
    clear_workdir,
    confine_hook,
    mark_used,
    remove_idle,
    sync_workdir,
    workdir_prompt,
)
from .workspace import (
    STORAGE_TIMEOUT,
    Storage,
    WorkspaceError,
    file_tools,
    server,
    tool_names,
)

logger = logging.getLogger("agent_py")


@dataclass
class Run:
    """What a thread's latest run has: its folder, skills and memory, and events not yet sent."""

    cwd: Path | None = None
    model: str | None = None
    skills: Sequence[RunSkill] = ()
    memory: RunMemory | None = None
    servers: RunServers | None = None
    # How a run with scripts reaches Anthropic (keyproxy.py); None: no scripts.
    keys: KeyRoute | None = None
    # The workspace copy in `cwd` (workdir.py); None: the run has none.
    workdir: Summary | None = None
    # (name, value) of CUSTOM events for the chat: skill_used, memory.
    pending: list[tuple[str, Any]] = field(default_factory=list)


# How often, at most, a starting run looks for idle run folders to remove.
SWEEP_EVERY_SECONDS = 3600.0


class _StillBusy(Exception):
    """The run folder stayed taken for as long as a run could wait for it."""


def token_expiry(token: str | None) -> float | None:
    """
    When one of the app's tokens expires (its `exp`), or None when it doesn't
    say. Read without checking the signature: api-py checks the token on every
    call, and here the time only bounds a wait.
    """
    try:
        payload = (token or "").split(".")[1]
        claims = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
        exp = claims["exp"]
    except (IndexError, ValueError, KeyError, TypeError):
        return None
    return float(exp) if isinstance(exp, int | float) and not isinstance(exp, bool) else None


def patience(*tokens: str | None, now: float | None = None) -> float | None:
    """
    How many seconds a run may wait before it starts: half of what is left of
    its shortest-lived token, so the other half is there for the run. None
    without tokens (no login): it waits as long as it takes.
    """
    expiries = [exp for exp in map(token_expiry, tokens) if exp is not None]
    if not expiries:
        return None
    return max(0.0, (min(expiries) - (time.time() if now is None else now)) / 2)


def _folder_name(user: str, workspace: str | None) -> str:
    """What a run folder is named after: one per user and workspace, since skills and the copy differ by workspace."""
    return f"{user}@{workspace}" if workspace else user


class ChatroomAdapter(ClaudeAgentAdapter):
    def __init__(
        self,
        *args: Any,
        system_prompt: str = "",
        models: tuple[str, ...] = (),
        storage_url: str | None = None,
        skills_root: Path | None = None,
        transport: httpx.AsyncBaseTransport | None = None,
        mcp_servers: Mapping[str, McpServer] | None = None,
        scripts: Scripts | None = None,
        workdir: Limits | None = None,
        idle_seconds: float | None = None,
        **kwargs: Any,
    ) -> None:
        super().__init__(*args, **kwargs)
        self._system_prompt = system_prompt
        self._models = models
        # Serialize preparation with the SDK query so a model change can't race a run on this thread.
        self._admissions: WeakValueDictionary[str, asyncio.Lock] = WeakValueDictionary()
        # The outside MCP servers in MCP_SERVERS (mcp.py).
        self._servers = dict(mcp_servers or {})
        self._storage_url = storage_url
        self._transport = transport  # for tests
        self._http: httpx.AsyncClient | None = None
        # Each user's run folder (with their skills) is a folder in here.
        self._skills_root = skills_root
        # SKILL_SCRIPTS=on (scripts.py), and the key proxy its runs share, once started.
        self._scripts = scripts
        self._key_proxy: KeyProxy | None = None
        self._key_lock = asyncio.Lock()
        # The working folder's size limits; None: AGENT_WORKDIR=off (workdir.py).
        self._workdir = workdir
        # Run folders unused this long are removed (None: never), looked for at
        # most once every SWEEP_EVERY_SECONDS, never one a run is in.
        self._idle_seconds = idle_seconds
        self._in_use: Counter[Path] = Counter()
        self._swept_at: float | None = None
        # One run at a time in a run folder: a run rewrites its skills, its
        # workspace copy and run-inputs/, which another chat's run of the same
        # user and workspace would be reading.
        self._folders: WeakValueDictionary[Path, asyncio.Lock] = WeakValueDictionary()
        # thread_id -> its latest run.
        self._runs: OrderedDict[str, Run] = OrderedDict()
        # Usage records on their way to api-py.
        self._recording: set[asyncio.Task[Any]] = set()
        # thread_id -> the last <workspace> note the thread's session was given.
        self._notes: OrderedDict[str, str] = OrderedDict()
        # thread_id -> the storage token of the thread's latest run.
        self._tokens: OrderedDict[str, str | None] = OrderedDict()
        # Each thread's workspace, as the app named it with the latest run.
        self._workspaces: OrderedDict[str, str | None] = OrderedDict()

    def build_options(
        self,
        input_data: RunAgentInput | None = None,
        thread_id: str | None = None,
        *args: Any,
        **kwargs: Any,
    ):
        options = super().build_options(input_data, thread_id, *args, **kwargs)
        run = self._runs.get(thread_id or "")
        if run and run.model:
            options.model = run.model
        memory = run.memory if run else None
        servers = run.servers if run else None
        scripts = (
            script_options(self._scripts, run.cwd, run.skills, run.keys, self._skills_root)
            if run and self._skills_root is not None
            else None
        )
        workdir = run.cwd if run and run.cwd and run.workdir else None
        folder = workdir_prompt(run.workdir, bool(scripts)) if run and run.workdir else None
        options.system_prompt = "\n".join(
            part
            for part in (
                self._system_prompt,
                folder,
                memory and memory.prompt,
                servers and servers.prompt,
            )
            if part
        )
        if servers and servers.configs:
            options.mcp_servers = {**(options.mcp_servers or {}), **servers.configs}
            options.allowed_tools = [
                *(options.allowed_tools or []),
                *(f"mcp__{name}" for name in servers.configs),
            ]
        if self._storage_url and thread_id:
            tools = file_tools(
                lambda: self._storage(thread_id or ""),
                {"chat": thread_id, "model": options.model},
                workdir,
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
            # Removed from the workspace, or it was archived, mid-run: no further
            # tool call of any kind, and no further turn, also after a call that
            # was already running. Ahead of every other hook.
            revoked = membership_hooks(lambda: self._storage(thread_id or ""))
            ordered: dict[str, list[Any]] = dict(cast(Any, options.hooks) or {})
            for event, matcher in revoked.items():
                ordered[event] = [matcher, *ordered.get(event, [])]
            options.hooks = cast(Any, ordered)
        if memory:
            hooks = dict(options.hooks or {})
            hooks["PreToolUse"] = [
                *hooks.get("PreToolUse", []),
                taint_hook(lambda: self._memory(thread_id or "")),
            ]
            options.hooks = hooks
        if run and run.cwd:
            options.cwd = str(run.cwd)
        if run and run.skills:
            extra = skill_options(
                run.skills, lambda name, trigger: self._used(thread_id or "", name, trigger)
            )
            hook = extra.pop("pre_tool_use")
            for key, value in extra.items():
                setattr(options, key, value)
            options.tools = [*(options.tools or []), "Skill"]
            hooks = dict(options.hooks or {})
            hooks["PreToolUse"] = [*hooks.get("PreToolUse", []), hook]
            options.hooks = hooks
        if workdir:
            # Read, Glob and Grep run outside the sandbox: confined to the run folder.
            options.tools = [*(options.tools or []), *CONFINED_TOOLS]
            options.allowed_tools = [*(options.allowed_tools or []), *CONFINED_TOOLS]
            hooks = dict(options.hooks or {})
            hooks["PreToolUse"] = [*hooks.get("PreToolUse", []), confine_hook(workdir)]
            options.hooks = hooks
        if scripts:
            options.tools = [*(options.tools or []), "Bash"]
            options.allowed_tools = [*(options.allowed_tools or []), "Bash"]
            options.env = {**(options.env or {}), **scripts["env"]}
            options.sandbox = scripts["sandbox"]
        return options

    async def run(
        self,
        input_data: RunAgentInput,
        storage_token: str | None = None,
        user: str = "local",
        memory_token: str | None = None,
        workspace: str | None = None,
    ) -> AsyncIterator[BaseEvent]:
        """Runs `input_data` for `user` (their id).

        `storage_token` is its X-Knowledge-Storage header (with login), `memory_token` its
        X-Knowledge-Memory, `workspace` its X-Knowledge-Workspace (None: the default workspace).
        """
        requested = chatroom_props(input_data).get("model")
        if (
            self._models
            and requested is not None
            and (not isinstance(requested, str) or requested not in self._models)
        ):
            yield RunErrorEvent(
                type=EventType.RUN_ERROR,
                thread_id=input_data.thread_id,
                run_id=input_data.run_id,
                message="The selected chat model isn't available in this deployment.",
            )
            return
        model = (requested or self._models[0]) if self._models else None
        lock = self._admissions.setdefault(input_data.thread_id, asyncio.Lock())
        async with (
            lock,
            aclosing(
                self._run(input_data, storage_token, user, memory_token, workspace, model)
            ) as stream,
        ):
            async for event in stream:
                yield event

    async def _run(
        self,
        input_data: RunAgentInput,
        storage_token: str | None,
        user: str,
        memory_token: str | None,
        workspace: str | None,
        model: str | None,
    ) -> AsyncGenerator[BaseEvent, None]:
        """
        The run, alone in its run folder for as long as it lasts. A user's run in
        another chat of the same workspace waits for it to end (Stop ends the
        wait). The folder is not removed as idle meanwhile, waiting included.

        The run's tokens were signed when it was sent and are not renewed, so
        it waits for at most half of the life they have left: the rest is for
        the run itself. Past that it ends with an error asking to send again,
        which comes with new tokens.
        """
        cwd = (
            run_folder(self._skills_root, _folder_name(user, workspace))
            if self._skills_root is not None
            else None
        )
        if cwd is not None:
            self._in_use[cwd] += 1
        try:
            async with (
                self._alone_in(cwd, patience(storage_token, memory_token)),
                aclosing(
                    self._run_in_folder(
                        input_data, storage_token, user, memory_token, workspace, model
                    )
                ) as stream,
            ):
                async for event in stream:
                    yield event
        except _StillBusy:
            yield RunErrorEvent(
                type=EventType.RUN_ERROR,
                thread_id=input_data.thread_id,
                run_id=input_data.run_id,
                message=(
                    "Your other chat is still working, and this message waited for it as "
                    "long as it could. Send it again when the other chat is done."
                ),
            )
        finally:
            if cwd is not None:
                self._in_use[cwd] -= 1
                if self._in_use[cwd] <= 0:
                    del self._in_use[cwd]
                    # Idle is counted from the end of the last run in the folder, not
                    # from its start: a long run must not leave it due for removal the
                    # moment it finishes, while its Claude Code session is still kept.
                    with contextlib.suppress(OSError):
                        mark_used(cwd)

    @asynccontextmanager
    async def _alone_in(self, cwd: Path | None, wait: float | None = None) -> AsyncIterator[None]:
        """
        Holds the run folder's lock (none without run folders), then looks for
        idle folders. Waits for the lock at most `wait` seconds (None: as long
        as it takes), then raises _StillBusy.
        """
        if cwd is None:
            yield
            return
        lock = self._folders.setdefault(cwd, asyncio.Lock())
        if lock.locked():
            logger.info("a run waits for the user's run in another chat to finish")
        try:
            async with asyncio.timeout(wait):
                await lock.acquire()
        except TimeoutError:
            raise _StillBusy from None
        try:
            await self._remove_idle_folders()
            yield
        finally:
            lock.release()

    async def _remove_idle_folders(self) -> None:
        if self._skills_root is None or self._idle_seconds is None:
            return
        now = time.monotonic()
        if self._swept_at is not None and now - self._swept_at < SWEEP_EVERY_SECONDS:
            return
        self._swept_at = now
        try:
            removed = await remove_idle(self._skills_root, self._idle_seconds, set(self._in_use))
        except Exception:  # never a reason to fail a run
            logger.exception("[workdir] couldn't look for idle run folders")
            return
        if removed:
            logger.info("[workdir] removed %d idle run folder(s)", removed)

    async def _run_in_folder(
        self,
        input_data: RunAgentInput,
        storage_token: str | None,
        user: str,
        memory_token: str | None,
        workspace: str | None,
        model: str | None,
    ) -> AsyncGenerator[BaseEvent, None]:
        thread_id = input_data.thread_id
        remember(self._tokens, thread_id, storage_token, self._max_workers)
        remember(self._workspaces, thread_id, workspace, self._max_workers)
        try:
            run = await self._prepare(input_data, user, memory_token, workspace, model)
        except Exception:
            # What each step expects to go wrong it handles itself, and the run goes
            # on without that part. Anything else used to break the stream with no
            # answer at all; the chat gets an error it can show instead.
            logger.exception("couldn't get the run ready")
            yield RunErrorEvent(
                type=EventType.RUN_ERROR,
                thread_id=thread_id,
                run_id=input_data.run_id,
                message="Couldn't start the run. Please try again.",
            )
            return
        remember(self._runs, thread_id, run, self._max_workers)
        try:
            if model and len(self._models) > 1:
                await self._switch_cached_model(input_data, model)
        except Exception as error:
            logger.warning("couldn't switch chat model: %s", error)
            yield RunErrorEvent(
                type=EventType.RUN_ERROR,
                thread_id=thread_id,
                run_id=input_data.run_id,
                message="Couldn't switch the chat model. Please try again.",
            )
            return
        prepared, slash = self.prepare(input_data, run.skills)
        if slash:
            self._used(thread_id, slash.name, "slash")
        started = False
        async with aclosing(cast(AsyncGenerator[BaseEvent, None], super().run(prepared))) as stream:
            async for event in stream:
                yield event
                started = started or event.type == EventType.RUN_STARTED
                while started and run.pending:
                    name, value = run.pending.pop(0)
                    yield CustomEvent(type=EventType.CUSTOM, name=name, value=value)

    async def _prepare(
        self,
        input_data: RunAgentInput,
        user: str,
        memory_token: str | None,
        workspace: str | None,
        model: str | None,
    ) -> Run:
        """What the run needs before the model is asked: its skills, working folder, memory and MCP servers."""
        thread_id = input_data.thread_id
        run = Run(model=model)
        if self._skills_root is not None:
            folder = _folder_name(user, workspace)
            mark_used(run_folder(self._skills_root, folder))
            run.skills = await self._skills_for(thread_id)
            try:
                run.cwd = materialize(self._skills_root, folder, run.skills)
            except OSError as err:
                logger.warning("couldn't write the run's skills; running without them: %s", err)
                run.skills = ()
                run.cwd = materialize(self._skills_root, folder, ())
            if self._scripts and needs_scripts(run.skills):
                run.keys = await self._keys()
            if self._workdir and self._storage_url:
                try:
                    run.workdir = await sync_workdir(
                        self._storage(thread_id), run.cwd, self._workdir
                    )
                except (WorkspaceError, OSError, KeyError, ValueError) as err:
                    logger.warning(
                        "[workdir] couldn't copy the workspace; running without it: %s", err
                    )
            # Without a fresh copy, no old one either: scripts can read the run folder.
            if not run.workdir:
                await clear_workdir(run.cwd)
        if memory_token and self._storage_url:
            try:
                run.memory = await fetch_memory(
                    self._storage(thread_id), memory_token, input_data.run_id
                )
            except (WorkspaceError, ValueError) as err:
                logger.warning("couldn't load memory; running without it: %s", err)
            # After a browser tool (its result is the last message) the turn has
            # used another tool already: changes wait in the inbox from the start.
            # The same when the run's context already holds workspace text (the
            # open file, a selection, an experiment's report). What earlier runs
            # of the chat read is the API server's to check (/memory/agent).
            if run.memory and (
                (input_data.messages and isinstance(input_data.messages[-1], ToolMessage))
                or carries_content(input_data)
            ):
                run.memory.tainted = True
        if self._servers:
            # Memory tokens only for runs with memory.
            tokens = (
                await trade_tokens(
                    self._storage(thread_id), memory_token if run.memory else None, self._servers
                )
                if self._storage_url
                else {}
            )
            run.servers = run_servers(self._servers, chips_from(input_data, self._servers), tokens)
        return run

    async def _switch_cached_model(self, input_data: RunAgentInput, model: str) -> None:
        # The pinned adapter rebuilds the worker for recovery and frontend tools.
        # A plain chat can reuse a worker; its SDK client switches in place.
        thread = input_data.thread_id
        entry = self._workers.get(thread)
        if (
            not entry
            or input_data.tools
            or thread in self._memory_bindings
            or self._session_binding_store is not None
            or self._defer_tools
            or getattr(input_data, "resume", None)
            or (input_data.messages and isinstance(input_data.messages[-1], ToolMessage))
        ):
            return
        worker = entry["worker"]
        client = worker._client
        if (
            worker.is_alive()
            and client
            and entry.get("chatroom_model", worker._options.model) != model
        ):
            await client.set_model(model)
            entry["chatroom_model"] = model

    async def _keys(self) -> KeyRoute | None:
        """The key proxy for runs with scripts, started on first use; None if it can't start."""
        async with self._key_lock:
            if self._key_proxy is None:
                proxy = KeyProxy()
                try:
                    await proxy.start()
                except OSError as err:
                    logger.error("key proxy didn't start; scripts are off for this run: %s", err)
                    await proxy.close()
                    return None
                self._key_proxy = proxy
            return self._key_proxy.route

    async def shutdown(self) -> None:
        await super().shutdown()
        if self._key_proxy:
            await self._key_proxy.close()
            self._key_proxy = None
        if self._http:
            await self._http.aclose()
            self._http = None

    def _client(self) -> httpx.AsyncClient | None:
        """The one HTTP client for the storage API, made on first use and kept until shutdown."""
        if self._http is None and self._storage_url:
            self._http = httpx.AsyncClient(
                base_url=self._storage_url, timeout=STORAGE_TIMEOUT, transport=self._transport
            )
        return self._http

    def _storage(self, thread_id: str) -> Storage:
        """The storage API with the thread's latest token and workspace: tools read them when called, not when the chat began."""
        return Storage(
            self._storage_url or "",
            self._tokens.get(thread_id),
            self._transport,
            self._workspaces.get(thread_id),
            self._client(),
        )

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
        run.pending.append(
            ("skill_used", {"skill": skill.name, "source": skill.source, "trigger": trigger})
        )
        if self._storage_url:
            storage = self._storage(thread_id)
            body = {"thread": thread_id, "skill": skill.name, "trigger": trigger}
            task = asyncio.ensure_future(_record(storage, body))
            self._recording.add(task)
            task.add_done_callback(self._recording.discard)

    def prepare(
        self, input_data: RunAgentInput, skills: Sequence[RunSkill] = ()
    ) -> tuple[RunAgentInput, RunSkill | None]:
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
            isinstance(last, ToolMessage)
            and not (len(messages) > 1 and isinstance(messages[-2], ToolMessage))
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


def guard_slash(
    message: UserMessage, skills: Sequence[RunSkill]
) -> tuple[UserMessage, RunSkill | None]:
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


def with_note(
    message: UserMessage | ToolMessage, note: str, after: bool = False
) -> UserMessage | ToolMessage:
    """The user's message with `note` in front of it (or after it), or a tool's result with `note` after it."""
    content = message.content
    after = after or isinstance(message, ToolMessage)
    if isinstance(content, str):
        text = f"{content}\n\n{note}" if after else f"{note}\n\n{content}"
        return message.model_copy(update={"content": text})
    part = TextInputContent(text=note)
    return message.model_copy(update={"content": [*content, part] if after else [part, *content]})
