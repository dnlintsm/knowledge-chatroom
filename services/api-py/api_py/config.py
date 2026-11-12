"""Settings from the environment, read as the TypeScript agent server reads them.

TS_AGENT_URL         the TypeScript agent server, which serves every route not
                     ported yet (default http://127.0.0.1:8100)
API_PY_HOST / API_PY_PORT
                     where this server listens (default 127.0.0.1:8000, the
                     address the app and agent-py know as LOCAL_AGENT_URL)
DATABASE_URL         the same Postgres as the TypeScript server; unset: no storage
AUTH_MODE, AUTH_SECRET
                     login, with the rules of packages/contracts/src/auth-mode.ts
MIGRATIONS_DIR       the SQL migrations to expect in the database
                     (default apps/agent/src/storage/migrations in this repository)
S3_*                 the blob store, as the TypeScript server reads them (blobs.py)
MAX_UPLOAD_BYTES     the largest file one upload may add (default 52428800, 50 MB)
EMBEDDING_MODEL, EMBEDDING_CACHE_DIR, EMBEDDING_BASE_URL, EMBEDDING_API_KEY,
EMBEDDING_DIMENSIONS, SEARCH_MIN_SIMILARITY
                     search by meaning, as the TypeScript server reads them
                     (semantic.py); this server runs the indexer
HUB_ADMINS           who moderates the skill hub: emails or login subjects
SKILL_SCRIPTS        on: skills' scripts run (on the TypeScript server, which
                     runs chats; /skills here says so)
BUILTIN_SKILLS_DIR   the built-in skills (default apps/agent/skills in this repository)
MEMORY               on: each user's memory (as on the TypeScript server); this
                     server serves the notes, settings, inbox and activity
MEMORY_LEARN, MEMORY_IDLE_MINUTES
                     with memory, learning from chats once they are quiet
                     (memory_learn.py; MEMORY_LEARN=off on the TypeScript server)
MCP_SERVERS, TOOLS_CALL_TIMEOUT_MS, STORAGE_TOKEN_SECONDS
                     the "+" menu's tool servers and their calls (tools.py); with
                     MCP_SERVERS unset, /tools stays with the TypeScript server
"""

from __future__ import annotations

import math
import re
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING

from .blobs import S3Settings
from .paths import JS_SPACE
from .semantic import EmbeddingSettings, embedding_settings

if TYPE_CHECKING:
    from .tools import ToolsSettings

DEFAULT_TS_AGENT_URL = "http://127.0.0.1:8100"
# services/api-py/api_py/config.py -> the repository root.
REPO_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_MIGRATIONS_DIR = REPO_ROOT / "apps" / "agent" / "src" / "storage" / "migrations"
DEFAULT_BUILTIN_SKILLS_DIR = REPO_ROOT / "apps" / "agent" / "skills"
DEFAULT_MAX_UPLOAD_BYTES = 50 * 1024 * 1024
_SECRET_HINT = "(at least 32 characters, e.g. openssl rand -hex 32)"


class ConfigError(ValueError):
    """A setting that would make this server act differently from the TypeScript one."""


def auth_secret(env: Mapping[str, str]) -> str | None:
    """AUTH_SECRET when login is on, None without login; refuses what auth-mode.ts refuses."""
    requested = (env.get("AUTH_MODE") or "").strip().lower() or None
    secret = env.get("AUTH_SECRET") or None
    if requested and requested not in ("oidc", "local"):
        raise ConfigError(f'AUTH_MODE must be "oidc" or "local", not "{env.get("AUTH_MODE")}"')
    if secret and len(secret) < 32:
        raise ConfigError(f"AUTH_SECRET is too short {_SECRET_HINT}")
    if requested == "local":
        if secret:
            raise ConfigError(
                "AUTH_MODE=local turns login off, so AUTH_SECRET must not be set; use AUTH_MODE=oidc for login"
            )
        return None
    if secret:
        return secret
    if requested == "oidc":
        raise ConfigError(f"AUTH_MODE=oidc needs AUTH_SECRET {_SECRET_HINT}")
    if env.get("NODE_ENV") == "production":
        raise ConfigError(
            "Login is not configured. Set AUTH_MODE=oidc with AUTH_SECRET and OIDC_* for sign-in, "
            "or AUTH_MODE=local to run without login (everyone is one user)"
        )
    return None


@dataclass(frozen=True)
class Settings:
    ts_agent_url: str
    database_url: str | None
    auth_secret: str | None
    migrations_dir: Path
    host: str = "127.0.0.1"
    port: int = 8000
    # The blob store; None leaves the file routes to the TypeScript server (tests that don't need them).
    s3: S3Settings | None = None
    max_upload_bytes: int = DEFAULT_MAX_UPLOAD_BYTES
    # Search by meaning; None leaves search to words (EMBEDDING_MODEL=off, and tests).
    embedding: EmbeddingSettings | None = None
    # The skill hub's admins (HUB_ADMINS, as given), whether skills' scripts run, and the built-in skills.
    hub_admins: str | None = None
    skill_scripts: bool = False
    builtin_skills_dir: Path = DEFAULT_BUILTIN_SKILLS_DIR
    # Personalized memory (MEMORY=on); off leaves /memory to the TypeScript server, which answers 404.
    memory: bool = False
    # With memory, learning from quiet chats (MEMORY_LEARN not off), and after how long (memory_learn.py).
    memory_learn: bool = True
    memory_idle_minutes: float = 10.0
    # The "+" menu's tool servers (MCP_SERVERS); None leaves /tools to the TypeScript server.
    tools: ToolsSettings | None = None


def settings_from_env(env: Mapping[str, str]) -> Settings:
    upstream = (env.get("TS_AGENT_URL") or DEFAULT_TS_AGENT_URL).strip().rstrip("/")
    port = env.get("API_PY_PORT") or "8000"
    if not port.isdigit() or not 0 < int(port) < 65536:
        raise ConfigError(f"API_PY_PORT must be a port number, not {port!r}")
    return Settings(
        ts_agent_url=upstream,
        database_url=(env.get("DATABASE_URL") or "").strip() or None,
        auth_secret=auth_secret(env),
        migrations_dir=Path(env.get("MIGRATIONS_DIR") or DEFAULT_MIGRATIONS_DIR),
        host=env.get("API_PY_HOST") or "127.0.0.1",
        port=int(port),
        s3=S3Settings.from_env(env),
        max_upload_bytes=max_upload_bytes(env),
        embedding=embedding_settings(env),
        hub_admins=env.get("HUB_ADMINS"),
        skill_scripts=env.get("SKILL_SCRIPTS") == "on",
        builtin_skills_dir=Path(env.get("BUILTIN_SKILLS_DIR") or DEFAULT_BUILTIN_SKILLS_DIR),
        tools=_tools(env),
        memory=bool(
            re.fullmatch(
                r"(on|1|true|yes)", (env.get("MEMORY") or "").strip(f"{JS_SPACE}"), re.IGNORECASE
            )
        ),
        memory_learn=not re.fullmatch(
            r"(off|0|false|no)", (env.get("MEMORY_LEARN") or "").strip(f"{JS_SPACE}"), re.IGNORECASE
        ),
        memory_idle_minutes=idle_minutes(env.get("MEMORY_IDLE_MINUTES")),
    )


def idle_minutes(value: str | None) -> float:
    """MEMORY_IDLE_MINUTES as learn.ts reads it: Number(value), finite and >= 0, else 10."""
    if value is None:
        return 10.0
    text = value.strip()
    if not text:
        return 0.0  # Number("") is 0
    try:
        n = float(text)
    except ValueError:
        return 10.0
    return n if math.isfinite(n) and n >= 0 else 10.0


def _tools(env: Mapping[str, str]) -> ToolsSettings | None:
    from .tools import tools_settings_from_env

    try:
        return tools_settings_from_env(env)
    except ValueError as err:  # STORAGE_TOKEN_SECONDS
        raise ConfigError(str(err)) from err


def max_upload_bytes(env: Mapping[str, str]) -> int:
    """MAX_UPLOAD_BYTES as config.ts reads it: a positive whole number of bytes."""
    raw = env.get("MAX_UPLOAD_BYTES") or str(DEFAULT_MAX_UPLOAD_BYTES)
    match = re.match(rf"[{JS_SPACE}]*([+-]?\d+)", raw)  # Number.parseInt
    if not match or int(match.group(1)) <= 0:
        raise ConfigError(f"MAX_UPLOAD_BYTES must be a number of bytes, not {raw!r}")
    return int(match.group(1))
