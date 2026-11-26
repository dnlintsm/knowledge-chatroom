"""Each chat's link to its Claude Code session, kept on disk (sessions.py)."""

from __future__ import annotations

import asyncio
import stat
from pathlib import Path

from ag_ui_claude_sdk.recovery import SessionBinding

from agent_py.sessions import SESSIONS, SessionStore

SESSION = "11111111-2222-3333-4444-555555555555"


def store(root: Path, there: bool = True) -> SessionStore:
    return SessionStore(root, exists=lambda session_id, cwd: there)


def test_a_link_outlives_the_process_that_saved_it(tmp_path: Path):
    cwd = tmp_path / "0123456789abcdef"
    pending = {"id": "toolu_1", "name": "mcp__ag_ui__writeWorkspaceFile", "input": {"path": "a.md"}}
    binding = SessionBinding(SESSION, "default", pending=pending, frontend_tools=[{"name": "x"}])
    first = store(tmp_path)
    first.place("chat-1", cwd.name, cwd)
    asyncio.run(first.save("chat-1", binding))

    # A new process: nothing in memory, only the folder.
    again = store(tmp_path)
    again.place("chat-1", cwd.name, cwd)
    assert asyncio.run(again.load("chat-1")) == binding
    assert again.continues("chat-1")
    (file,) = (tmp_path / SESSIONS / cwd.name).iterdir()
    # A pending tool call's input can hold a file's text.
    assert stat.S_IMODE(file.stat().st_mode) == 0o600
    assert "chat-1" not in file.name


def test_a_link_is_one_users_in_one_workspace(tmp_path: Path):
    mine, theirs = tmp_path / "0123456789abcdef", tmp_path / "fedcba9876543210"
    saved = store(tmp_path)
    saved.place("chat-1", mine.name, mine)
    asyncio.run(saved.save("chat-1", SessionBinding(SESSION, "default")))

    # The same chat id sent for someone else, or from another workspace, finds none.
    other = store(tmp_path)
    other.place("chat-1", theirs.name, theirs)
    assert asyncio.run(other.load("chat-1")) is None
    assert not other.continues("chat-1")
    # A chat nobody placed has no link, and saving one does nothing.
    nowhere = store(tmp_path)
    asyncio.run(nowhere.save("chat-2", SessionBinding(SESSION, "default")))
    assert asyncio.run(nowhere.load("chat-2")) is None


def test_a_link_whose_transcript_is_gone_is_dropped(tmp_path: Path):
    """Failing every later run of the chat would be worse than a new session."""
    cwd = tmp_path / "0123456789abcdef"
    saved = store(tmp_path)
    saved.place("chat-1", cwd.name, cwd)
    asyncio.run(saved.save("chat-1", SessionBinding(SESSION, "default")))

    asked: list[tuple[str, Path]] = []
    gone = SessionStore(tmp_path, exists=lambda sid, where: asked.append((sid, where)) or False)
    gone.place("chat-1", cwd.name, cwd)
    assert asyncio.run(gone.load("chat-1")) is None
    # Asked for in the run folder the session worked in.
    assert asked == [(SESSION, cwd)]
    assert list((tmp_path / SESSIONS / cwd.name).iterdir()) == []
    # In the process that saved it too: its copy in memory is no use either.
    saved._exists = lambda sid, where: False
    assert not saved.continues("chat-1")


def test_a_file_that_cant_be_read_starts_the_chat_anew(tmp_path: Path):
    cwd = tmp_path / "0123456789abcdef"
    saved = store(tmp_path)
    saved.place("chat-1", cwd.name, cwd)
    asyncio.run(saved.save("chat-1", SessionBinding(SESSION, "default")))
    (file,) = (tmp_path / SESSIONS / cwd.name).iterdir()
    file.write_text('{"session_id": ')

    again = store(tmp_path)
    again.place("chat-1", cwd.name, cwd)
    assert asyncio.run(again.load("chat-1")) is None
    assert not file.exists()


def test_a_disk_that_cant_be_written_doesnt_fail_the_run(tmp_path: Path, caplog):
    cwd = tmp_path / "0123456789abcdef"
    (tmp_path / SESSIONS).write_text("not a folder")
    stuck = store(tmp_path)
    stuck.place("chat-1", cwd.name, cwd)
    binding = SessionBinding(SESSION, "default")
    asyncio.run(stuck.save("chat-1", binding))  # no error
    assert "won't survive a restart" in caplog.text
    # The chat goes on in this process: a browser tool's result still finds its call.
    assert asyncio.run(stuck.load("chat-1")) == binding


def test_a_link_that_could_not_be_written_is_the_one_read(tmp_path: Path, monkeypatch):
    """The file still holds the link before it, which lacks the run's pending tool call."""
    cwd, theirs = tmp_path / "0123456789abcdef", tmp_path / "fedcba9876543210"
    saved = store(tmp_path)
    saved.place("chat-1", cwd.name, cwd)
    before = SessionBinding(SESSION, "default")
    asyncio.run(saved.save("chat-1", before))

    def full(src, dst):
        raise OSError(28, "No space left on device")

    pending = {"id": "toolu_1", "name": "mcp__ag_ui__writeWorkspaceFile", "input": {"path": "a.md"}}
    latest = SessionBinding(SESSION, "default", pending=pending)
    with monkeypatch.context() as patch:
        patch.setattr("agent_py.sessions.os.replace", full)
        asyncio.run(saved.save("chat-1", latest))
    assert asyncio.run(saved.load("chat-1")) == latest

    # It is the chat's in that run folder only: the same chat id elsewhere finds none.
    saved.place("chat-1", theirs.name, theirs)
    assert asyncio.run(saved.load("chat-1")) is None

    # Once a write gets through, the file is the one read again.
    saved.place("chat-1", cwd.name, cwd)
    asyncio.run(saved.save("chat-1", before))
    assert asyncio.run(saved.load("chat-1")) == before
    again = store(tmp_path)
    again.place("chat-1", cwd.name, cwd)
    assert asyncio.run(again.load("chat-1")) == before
