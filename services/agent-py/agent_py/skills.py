"""The run's skills (issue #176, step 3).

The Python twin of apps/agent/src/skills/run.ts. The agent server decides
which skills a run gets: built-in, hub and workspace skills that aren't off for
the user in this chat (GET /skills/run, with the run's storage token). Claude
Code loads skills from <cwd>/.claude/skills/, so each user gets a folder of
their own holding exactly those (written again only when the set changes), and
the run starts there with:

  skills          the ones it may use; any other skill is hidden and refused
  skillOverrides  auto -> "on", manual -> "user-invocable-only" (/name only)
  no shell        `!` commands in a SKILL.md never run, and the run has no
                  shell tool. Skills' scripts (SKILL_SCRIPTS=on on the agent
                  server) don't run here.

The folder stays the same per user, so resumed sessions (stored by Claude Code
per working folder) still find their history. Each skill the run uses is
reported to the chat (a `skill_used` event) and to the usage history
(POST /skills/used).
"""

from __future__ import annotations

import base64
import hashlib
import json
import re
import shutil
import uuid
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

from claude_agent_sdk import HookMatcher

from .workspace import Storage

Trigger = Literal["slash", "model"]
# A skill's name is its folder: one path segment (the SDK refuses others too).
_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]*$")
_SLASH = re.compile(r"^/([^\s/]+)")


@dataclass(frozen=True)
class RunSkill:
    name: str
    mode: Literal["auto", "manual"]
    source: str
    user_invocable: bool = True
    files: tuple[tuple[str, bytes], ...] = field(default=(), repr=False)


async def fetch_skills(storage: Storage, thread: str) -> list[RunSkill]:
    """The skills the agent server gives a run for this user in this chat."""
    data = await storage.json("GET", "/skills/run", params={"thread": thread})
    skills = []
    for s in data.get("skills", []):
        if not _NAME.match(s.get("name", "")) or s.get("mode") not in ("auto", "manual"):
            continue
        files = tuple((f["path"], base64.b64decode(f["content"])) for f in s.get("files", []))
        skills.append(
            RunSkill(
                s["name"],
                s["mode"],
                s.get("source", "builtin"),
                bool(s.get("userInvocable", True)),
                files,
            )
        )
    return skills


def materialize(root: Path, user: str, skills: Sequence[RunSkill]) -> Path:
    """Writes the user's skills to their run folder under `root` (if they changed) and returns it."""
    cwd = root / hashlib.sha256(user.encode()).hexdigest()[:16]
    claude = cwd / ".claude"
    target = claude / "skills"
    digest = hashlib.sha256()
    for skill in skills:
        digest.update(f"{skill.name}\0".encode())
        for path, data in skill.files:
            digest.update(f"{path}\0".encode())
            digest.update(hashlib.sha256(data).digest())
    fingerprint = digest.hexdigest()
    marker = target / ".fingerprint"
    if marker.is_file() and marker.read_text() == fingerprint:
        return cwd

    # Build the new set beside the old one, then swap it in.
    staged = claude / f"skills.{uuid.uuid4().hex}"
    for skill in skills:
        folder = (staged / skill.name).resolve()
        for path, data in skill.files:
            file = (folder / path).resolve()
            # Paths come from storage, which refuses "..", but stay inside regardless.
            if not file.is_relative_to(folder) or file == folder:
                continue
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_bytes(data)
    staged.mkdir(parents=True, exist_ok=True)
    (staged / ".fingerprint").write_text(fingerprint)
    old = claude / f"skills.old.{uuid.uuid4().hex}"
    if target.exists():
        target.rename(old)
    staged.rename(target)
    shutil.rmtree(old, ignore_errors=True)
    return cwd


def slash_command(text: str, skills: Sequence[RunSkill]) -> tuple[str, RunSkill | None]:
    """`text` as the session should get it, and the skill it runs as /name, if any.

    Claude Code treats a prompt starting with "/" as a command: one of the run's
    skills, but also its own (/clear, /compact, bundled skills...). Only /name for
    a skill this run has stays a command; anything else goes as plain text (a
    leading space keeps it from being read as a command).
    """
    match = _SLASH.match(text)
    if not match:
        return text, None
    skill = next((s for s in skills if s.name == match[1] and s.user_invocable), None)
    return (text, skill) if skill else (f" {text}", None)


def skill_options(
    skills: Sequence[RunSkill], on_use: Callable[[str, Trigger], None]
) -> dict[str, Any]:
    """ClaudeAgentOptions fields for a run with these skills; `on_use` hears each one Claude picks."""

    async def picked(input_data: Any, _tool_use_id: str | None, _context: Any) -> dict[str, Any]:
        name = (input_data.get("tool_input") or {}).get("skill")
        if isinstance(name, str):
            on_use(name, "model")
        return {}

    return {
        # Only the run folder's .claude/: never this server's ~/.claude settings or skills.
        "setting_sources": ["project"],
        "skills": [s.name for s in skills],
        "settings": json.dumps(
            {
                "skillOverrides": {
                    s.name: "on" if s.mode == "auto" else "user-invocable-only" for s in skills
                },
                "disableSkillShellExecution": True,
            }
        ),
        "pre_tool_use": HookMatcher(matcher="Skill", hooks=[picked]),
    }
