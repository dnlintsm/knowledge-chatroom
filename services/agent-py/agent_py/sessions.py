"""Which Claude Code session each chat continues, kept on disk.

Claude Code keeps a chat's turns in a session transcript under its own home
(`~/.claude/projects/<working folder>/<session id>.jsonl`). Each run sends the
engine only the newest message and resumes that session, so the link from a
chat to its session id is what makes Claude remember the chat. The adapter
keeps that link (a "binding") wherever it is told to; kept only in memory, a
restart or thirty idle minutes lost it, and the next run began a new session
that knew none of the earlier turns.

Here the links are files under `<AGENT_PY_WORKDIR>/.sessions/<run folder>/`,
one per chat, named by a hash of the chat's id. They are of use only together
with the transcripts, so a deployment keeps both across restarts: this folder
and Claude Code's home (docs/deployment.md).

A link whose transcript is gone (Claude Code removes old ones, or its home was
not kept) is dropped when it is read, and the chat starts a new session, as it
would have before: failing every later run of that chat would be worse.
"""

from __future__ import annotations

import contextlib
import hashlib
import json
import logging
import os
from collections import OrderedDict
from collections.abc import Callable
from dataclasses import asdict
from pathlib import Path
from typing import Any

from ag_ui_claude_sdk.recovery import SessionBinding

logger = logging.getLogger("agent_py")

# The folder under AGENT_PY_WORKDIR. Not a run folder's name, so removing idle
# run folders (workdir.remove_idle) leaves it alone.
SESSIONS = ".sessions"
# How many chats' places, and how many unwritten links, are remembered at once.
MAX_PLACES = 10_000


def session_exists(session_id: str, cwd: Path) -> bool:
    """Whether Claude Code still has the transcript of `session_id`, started in `cwd`."""
    from claude_agent_sdk import get_session_info

    return get_session_info(session_id, directory=str(cwd)) is not None


async def no_profile(_profile: str) -> dict[str, Any]:
    """The adapter's execution profiles are not used: every run gets the options build_options makes."""
    return {}


class SessionStore:
    """
    The adapter's session binding store (ag_ui_claude_sdk's SessionBindingStore).

    The adapter asks by chat id alone. Whose chat it is, and in which run
    folder its session works, is told with place() before each run: a link is
    kept per user and workspace, so a chat id sent by someone else finds none.
    """

    def __init__(self, root: Path, exists: Callable[[str, Path], bool] = session_exists) -> None:
        self.root = root / SESSIONS
        self._exists = exists
        # thread_id -> (run folder's name, run folder), of each chat's latest run.
        self._places: OrderedDict[str, tuple[str, Path]] = OrderedDict()
        # Link file -> the link that could not be written to it. Newer than
        # whatever the file holds, so it is read first, and the chat continues
        # until the server restarts. By file, so it is one user's in one
        # workspace, as the file is.
        self._unsaved: OrderedDict[Path, SessionBinding] = OrderedDict()

    def place(self, thread_id: str, folder: str, cwd: Path) -> None:
        """Says where `thread_id`'s runs work, before the adapter loads or saves its link."""
        self._places[thread_id] = (folder, cwd)
        self._places.move_to_end(thread_id)
        while len(self._places) > MAX_PLACES:
            self._places.popitem(last=False)

    def _file(self, thread_id: str) -> tuple[Path, Path] | None:
        place = self._places.get(thread_id)
        if place is None:
            return None
        folder, cwd = place
        name = hashlib.sha256(thread_id.encode("utf-8", "surrogatepass")).hexdigest()
        return self.root / folder / f"{name}.json", cwd

    def _read(self, thread_id: str) -> SessionBinding | None:
        """The chat's saved link, if its transcript is still there; a link without one is dropped."""
        found = self._file(thread_id)
        if found is None:
            return None
        file, cwd = found
        binding = self._unsaved.get(file)
        if binding is None:
            try:
                binding = SessionBinding(**json.loads(file.read_text(encoding="utf-8")))
            except FileNotFoundError:
                return None
            except (OSError, ValueError, TypeError) as err:
                logger.warning("[sessions] a chat's saved session can't be read: %s", err)
                with contextlib.suppress(OSError):
                    file.unlink()
                return None
        if not self._exists(binding.session_id, cwd):
            self._unsaved.pop(file, None)
            logger.warning(
                "[sessions] a chat's session transcript is gone (Claude Code's home was not kept, "
                "or it removed an old one); the chat starts a new session"
            )
            with contextlib.suppress(OSError):
                file.unlink()
            return None
        return binding

    def continues(self, thread_id: str) -> bool:
        """Whether the chat's next run resumes a session, which has its earlier turns."""
        return self._read(thread_id) is not None

    async def load(self, thread_id: str) -> SessionBinding | None:
        return self._read(thread_id)

    async def save(self, thread_id: str, binding: SessionBinding) -> None:
        found = self._file(thread_id)
        if found is None:
            return
        file, _cwd = found
        part = file.with_name(f"{file.name}.{os.getpid()}.part")
        try:
            # A pending tool call's input can hold a file's text: the owner's alone.
            file.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            with os.fdopen(os.open(part, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w") as out:
                json.dump(asdict(binding), out)
            # Whole or not at all: a reader never sees half a link.
            os.replace(part, file)
        except (OSError, TypeError, ValueError) as err:
            # The run goes on: the chat continues from memory until a restart.
            logger.warning(
                "[sessions] couldn't save a chat's session; it won't survive a restart: %s", err
            )
            with contextlib.suppress(OSError):
                part.unlink()
            self._unsaved[file] = binding
            self._unsaved.move_to_end(file)
            while len(self._unsaved) > MAX_PLACES:
                self._unsaved.popitem(last=False)
        else:
            self._unsaved.pop(file, None)
