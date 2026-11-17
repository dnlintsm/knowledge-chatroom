"""Skills' scripts (issue #264, step 2).

The Python twin of the script half of apps/agent/src/skills/run.ts. With
SKILL_SCRIPTS=on, a run that has a skill shipping scripts (`needsExecution`
from GET /skills/run) also gets Bash, always inside Claude Code's sandbox
(bubblewrap on Linux; the run fails rather than run commands unsandboxed):

- no network;
- writes only in the run folder, not to its skills, its workspace copy or the
  files Claude Code reads as instructions there (CLAUDE.md, .mcp.json, ...);
- this server's own folder (code, .env, its virtualenv), its home, other users'
  run folders, the usual secret mounts and SKILL_SCRIPTS_DENY_READ unreadable;
- an environment holding nothing but what Claude Code needs, with a stand-in
  for the API key (keyproxy.py).

Claude Code's Bash inherits Claude Code's environment, which the Python SDK
builds from this server's own: ClaudeAgentOptions.env can only add to it, not
take away. So every variable not kept is passed as an empty string.
"""

from __future__ import annotations

import os
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .keyproxy import KeyRoute
from .skills import RunSkill

# This server's checkout (or /app in its image): code, .env and the virtualenv.
APP_ROOT = Path(__file__).resolve().parents[3]

# What a script run keeps of the server's environment: nothing secret, since its
# commands see all of it. The context-window settings keep auto-compact working
# the same in these runs. (Proxy settings can hold passwords, and the run only
# talks to the key proxy on 127.0.0.1.)
RUN_ENV = re.compile(
    r"^(PATH|HOME|USER|LOGNAME|SHELL|LANG|LANGUAGE|LC_[A-Z]+|TZ|TERM|TMPDIR"
    r"|ANTHROPIC_(MODEL|SMALL_FAST_MODEL|DEFAULT_[A-Z]+_MODEL)"
    r"|CLAUDE_CODE_AUTO_COMPACT_WINDOW|CLAUDE_CODE_MAX_CONTEXT_TOKENS"
    r"|CLAUDE_AUTOCOMPACT_PCT_OVERRIDE)$"
)
# Where containers usually mount credentials (Docker, Kubernetes, some hosts).
SECRET_MOUNTS = ("/run/secrets", "/var/run/secrets", "/etc/secrets")
# Files in the run folder that Claude Code reads as project instructions or settings.
PROJECT_FILES = ("CLAUDE.md", "CLAUDE.local.md", ".mcp.json")
# The workspace copy in the run folder (#264 step 3), as the TypeScript agent names it.
WORKSPACE_FILES = ("workspace", ".workspace-manifest.json")


@dataclass(frozen=True)
class Scripts:
    """SKILL_SCRIPTS=on, with the paths scripts can't read besides the usual ones."""

    app_root: Path = APP_ROOT
    deny_read: tuple[str, ...] = ()


def scripts_from_env(env: Mapping[str, str]) -> Scripts | None:
    """The script settings; None unless SKILL_SCRIPTS=on."""
    if env.get("SKILL_SCRIPTS") != "on":
        return None
    paths = (p.strip() for p in env.get("SKILL_SCRIPTS_DENY_READ", "").split(","))
    return Scripts(deny_read=tuple(p for p in paths if os.path.isabs(p)))


def needs_scripts(skills: Sequence[RunSkill]) -> bool:
    return any(s.needs_execution for s in skills)


def _inside(path: str, roots: Sequence[Path]) -> bool:
    try:
        resolved = Path(path).resolve()
    except (OSError, RuntimeError):
        return False
    return any(resolved == root or resolved.is_relative_to(root) for root in roots)


def run_env(
    route: KeyRoute, hidden: Sequence[Path], inherited: Mapping[str, str] | None = None
) -> dict[str, str]:
    """ClaudeAgentOptions.env for a run with scripts: `inherited` is what Claude Code would get."""
    inherited = os.environ if inherited is None else inherited
    env = {key: value if RUN_ENV.match(key) else "" for key, value in inherited.items()}
    if env.get("PATH"):
        # Folders scripts can't read anyway (this server's virtualenv): commands
        # are found elsewhere on PATH.
        env["PATH"] = os.pathsep.join(
            p for p in env["PATH"].split(os.pathsep) if p and not _inside(p, hidden)
        )
    env["ANTHROPIC_BASE_URL"] = route.base_url
    env["ANTHROPIC_API_KEY"] = route.api_key
    env["NO_PROXY"] = env["no_proxy"] = "127.0.0.1,localhost"
    return env


def script_options(
    scripts: Scripts | None,
    cwd: Path | None,
    skills: Sequence[RunSkill],
    route: KeyRoute | None,
    root: Path,
    inherited: Mapping[str, str] | None = None,
) -> dict[str, Any] | None:
    """ClaudeAgentOptions fields that let this run use Bash for its skills' scripts, sandboxed.

    None when scripts are off, none of the run's skills has any, or there is no
    key proxy (the run never holds the real key). `root` holds every user's run folder.
    """
    if scripts is None or cwd is None or route is None or not needs_scripts(skills):
        return None
    app_root, root = scripts.app_root.resolve(), root.resolve()
    home = Path.home().resolve()
    return {
        "env": run_env(route, (app_root, root, home), inherited),
        "sandbox": {
            "enabled": True,
            "failIfUnavailable": True,
            "autoAllowBashIfSandboxed": True,
            "allowUnsandboxedCommands": False,
            "network": {"allowedDomains": []},
            "filesystem": {
                # Its skills, files Claude Code reads as instructions in later
                # chats, and the workspace copy (changes go through the file tools).
                "denyWrite": [
                    str(cwd / name) for name in (".claude", *PROJECT_FILES, *WORKSPACE_FILES)
                ],
                # Other users' run folders, this server's files, its home and
                # mounted secrets stay out of reach.
                "denyRead": [
                    str(app_root),
                    str(root),
                    str(home),
                    *SECRET_MOUNTS,
                    *scripts.deny_read,
                ],
                "allowRead": [str(cwd)],
            },
        },
    }
