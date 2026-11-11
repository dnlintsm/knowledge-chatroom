"""Outside MCP servers and the chat's tool chips (issue #176, step 5).

The Python twin of apps/agent/src/mcp.ts. MCP_SERVERS is the same setting, in
the same shape (Claude's .mcp.json: {"mcpServers": {"<name>": {...}}}, or the
bare map; JSON or a path to a JSON file), so give this agent the agent server's
value: the chat's "+" menu comes from the agent server's GET /tools, and the
chips it shows name these servers.

- type "http" (default), "sse" or "stdio"; ${VAR} in headers and env comes
  from this agent's environment.
- forwardIdentity, storageAccess, memoryAccess (http/sse): each run sends the
  server the user's identity signed for "mcp:<name>", a storage token and a
  memory token for the chat, as the TypeScript agent does. This agent holds no
  AUTH_SECRET, so it trades the run's own tokens for them at the agent server
  (POST /identity/mcp-tokens, apps/agent/src/mcp-tokens.ts).
- ui (http/sse): the server's chip. While it is on in this chat
  (knowledge_chatroom.tools), the prompt tells Claude to use its tools; a
  "manual" server is only in runs with its chip on.

Every tool of a configured server is allowed. A bad entry is logged and left
out; a server that is down leaves its tools out of the run.
"""

from __future__ import annotations

import json
import logging
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

from ag_ui.core import RunAgentInput

from .place import chatroom_props
from .workspace import SERVER_NAME, STORAGE_HEADER, Storage, WorkspaceError

logger = logging.getLogger("agent_py")

IDENTITY_HEADER = "X-Knowledge-User"
MEMORY_HEADER = "X-Knowledge-Memory"
Kind = Literal["identity", "storage", "memory"]
# Which header each kind of token goes in.
HEADERS: dict[Kind, str] = {
    "identity": IDENTITY_HEADER,
    "storage": STORAGE_HEADER,
    "memory": MEMORY_HEADER,
}
_NAME = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
_VAR = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}")


@dataclass(frozen=True)
class ToolUi:
    """How a server shows in the chat's "+" menu."""

    label: str
    chip: str
    mode: Literal["auto", "manual"] = "auto"


@dataclass(frozen=True)
class McpServer:
    config: dict[str, Any]
    kinds: tuple[Kind, ...] = ()
    ui: ToolUi | None = None


@dataclass
class RunServers:
    """One run's outside servers: their SDK configs and the chips on."""

    configs: dict[str, dict[str, Any]] = field(default_factory=dict)
    chips: list[str] = field(default_factory=list)
    prompt: str = ""


def _expand(value: str, env: Mapping[str, str], where: str) -> str:
    def var(match: re.Match[str]) -> str:
        found = env.get(match[1])
        if found is None:
            logger.warning("%s uses ${%s}, which isn't set", where, match[1])
        return found or ""

    return _VAR.sub(var, value)


def _strings(value: Any, env: Mapping[str, str], where: str) -> dict[str, str] | None:
    if value is None:
        return None
    if not isinstance(value, dict) or not all(isinstance(v, str) for v in value.values()):
        raise ValueError(f"{where} must map names to strings")
    return {k: _expand(v, env, f"{where}.{k}") for k, v in value.items()}


def _ui(raw: Any) -> ToolUi:
    if not isinstance(raw, dict):
        raise ValueError("ui must be an object")

    def text(key: str, most: int) -> str | None:
        value = raw.get(key)
        if value is None:
            return None
        if not isinstance(value, str) or not value.strip() or len(value) > most:
            raise ValueError(f"ui.{key} must be a string of at most {most} characters")
        return value.strip()

    label = text("label", 40)
    if not label:
        raise ValueError("ui needs a label")
    mode = raw.get("mode", "auto")
    if mode not in ("auto", "manual"):
        raise ValueError('ui.mode must be "auto" or "manual"')
    return ToolUi(label=label, chip=text("chip", 24) or label, mode=mode)


def _server(name: str, raw: Any, env: Mapping[str, str]) -> McpServer:
    if not _NAME.match(name):
        raise ValueError("names may use letters, digits, _ and - only")
    if name == SERVER_NAME:
        raise ValueError("that name is the agent's own tool server")
    if not isinstance(raw, dict):
        raise ValueError("must be an object")
    kinds: tuple[Kind, ...] = tuple(
        kind
        for kind, key in (
            ("identity", "forwardIdentity"),
            ("storage", "storageAccess"),
            ("memory", "memoryAccess"),
        )
        if raw.get(key) is True
    )
    kind = raw.get("type", "http")
    if kind == "stdio":
        command, args = raw.get("command"), raw.get("args")
        if not isinstance(command, str) or not command:
            raise ValueError("stdio needs a command")
        if args is not None and not (
            isinstance(args, list) and all(isinstance(a, str) for a in args)
        ):
            raise ValueError("args must be a list of strings")
        if kinds or raw.get("ui") is not None:
            raise ValueError(
                "forwardIdentity, storageAccess, memoryAccess and ui need an http or sse server"
            )
        config: dict[str, Any] = {"type": "stdio", "command": command}
        if args:
            config["args"] = args
        if (env_vars := _strings(raw.get("env"), env, f"{name}.env")) is not None:
            config["env"] = env_vars
        return McpServer(config)
    if kind not in ("http", "sse"):
        raise ValueError(f"unknown type {json.dumps(kind)}")
    url = raw.get("url")
    if not isinstance(url, str) or not re.match(r"^https?://", url):
        raise ValueError("needs an http(s) url")
    headers = _strings(raw.get("headers"), env, f"{name}.headers")
    for header in HEADERS.values():
        if headers and any(h.lower() == header.lower() for h in headers):
            raise ValueError(
                f"{header} is set by the agent (forwardIdentity, storageAccess, memoryAccess)"
            )
    # alwaysLoad: the run has no tool search, so tools must not be deferred.
    config = {"type": kind, "url": url, "alwaysLoad": True}
    if headers:
        config["headers"] = headers
    return McpServer(config, kinds, _ui(raw["ui"]) if raw.get("ui") is not None else None)


def servers_from_env(env: Mapping[str, str]) -> dict[str, McpServer]:
    """The configured servers; bad entries are logged and left out."""
    setting = (env.get("MCP_SERVERS") or "").strip()
    if not setting:
        return {}
    try:
        parsed = json.loads(setting if setting.startswith("{") else Path(setting).read_text())
    except (OSError, ValueError) as err:
        logger.error("MCP_SERVERS isn't readable JSON; no outside MCP servers: %s", err)
        return {}
    servers_map = parsed.get("mcpServers", parsed) if isinstance(parsed, dict) else None
    if not isinstance(servers_map, dict):
        logger.error("MCP_SERVERS must be an object of servers; no outside MCP servers")
        return {}
    servers: dict[str, McpServer] = {}
    for name, raw in servers_map.items():
        try:
            servers[name] = _server(name, raw, env)
        except ValueError as err:
            logger.error("skipping MCP server %s: %s", json.dumps(name), err)
    return servers


def chips_from(input_data: RunAgentInput, servers: Mapping[str, McpServer]) -> list[str]:
    """The chips on in this chat, kept to servers in the "+" menu."""
    tools = chatroom_props(input_data).get("tools")
    if not isinstance(tools, list):
        return []
    return list(
        dict.fromkeys(t for t in tools if isinstance(t, str) and t in servers and servers[t].ui)
    )


def chip_prompt(chips: Sequence[str], servers: Mapping[str, McpServer]) -> str:
    """The prompt's line for each chip on, as the TypeScript agent words it."""
    lines = []
    for name in chips:
        ui = servers[name].ui
        assert ui is not None
        lines.append(
            f'- The user turned on "{ui.chip}" ({ui.label}) for this chat: answer with the '
            f"mcp__{name}__ tools, and say so if they find nothing."
        )
    return "\n".join(lines)


async def trade_tokens(
    storage: Storage, memory_token: str | None, servers: Mapping[str, McpServer]
) -> dict[str, dict[str, str]]:
    """The servers' tokens from the agent server, for the run's tokens; {} when it gives none."""
    wanted = {name: list(s.kinds) for name, s in servers.items() if s.kinds}
    if not wanted or not (storage.token or memory_token):
        return {}
    headers = {
        k: v for k, v in ((STORAGE_HEADER, storage.token), (MEMORY_HEADER, memory_token)) if v
    }
    try:
        data = await storage.json(
            "POST", "/identity/mcp-tokens", json_body={"servers": wanted}, headers=headers
        )
    except (WorkspaceError, ValueError) as err:
        logger.warning("couldn't get the MCP servers' tokens; they get no user: %s", err)
        return {}
    tokens = data.get("tokens") if isinstance(data, dict) else None
    return tokens if isinstance(tokens, dict) else {}


def run_servers(
    servers: Mapping[str, McpServer], chips: Sequence[str], tokens: Mapping[str, Mapping[str, str]]
) -> RunServers:
    """The run's configs (manual servers only with their chip on, each with its tokens) and chip prompt."""
    configs: dict[str, dict[str, Any]] = {}
    for name, server in servers.items():
        if server.ui and server.ui.mode == "manual" and name not in chips:
            continue
        config = dict(server.config)
        given = tokens.get(name) or {}
        added = {
            HEADERS[kind]: given[kind] for kind in server.kinds if isinstance(given.get(kind), str)
        }
        if added:
            config["headers"] = {**config.get("headers", {}), **added}
        configs[name] = config
    return RunServers(configs=configs, chips=list(chips), prompt=chip_prompt(chips, servers))
