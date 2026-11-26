"""The FastAPI app: POST /agent/report, as docs/remote-agent.md describes.

    uv run python -m agent_py.app    # http://127.0.0.1:9300, then AGENT_URL=http://127.0.0.1:9300

Environment:
    CLAUDE_MODEL / ANTHROPIC_MODEL  the model (model.py)
    CHAT_MODELS                    comma-separated additional models users can select
    ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL, ...  read by Claude Code itself
    KNOWLEDGE_PUBLIC_KEY            api-py's GET /identity/public-key; set it with login on
    AGENT_RUN_TIMEOUT_SECONDS       stop a run after this long (default 1800, 0 = never)
    LOCAL_AGENT_URL                 api-py, which serves the storage API (default http://localhost:8000)
    MCP_SERVERS                     outside MCP servers and tool chips, the same value as api-py's (mcp.py)
    AGENT_PY_WORKDIR                where each user's working folder (with their skills) goes
                                    (default: a new empty temp folder)
    AGENT_WORKDIR                   off: no copy of the workspace in the working folder (workdir.py)
    AGENT_WORKDIR_MAX_MB, AGENT_WORKDIR_MAX_FILE_MB
                                    its size limits (default 500 and 25)
    AGENT_WORKDIR_IDLE_HOURS        remove a user's working folder after this long without a run
                                    (default 24, at least 1; 0: never)
    SKILL_SCRIPTS                   on: skills' scripts run, in Claude Code's sandbox (scripts.py)
    SKILL_SCRIPTS_DENY_READ         more absolute paths scripts can't read (comma-separated)
    AGENT_PY_HOST / AGENT_PY_PORT   where to listen (default 127.0.0.1:9300)
"""

from __future__ import annotations

import logging
import os
import tempfile
from collections.abc import AsyncIterator, Mapping
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
from ag_ui.core import EventType, RunAgentInput, RunErrorEvent
from ag_ui.encoder import EventEncoder
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import StreamingResponse

from knowledge_chatroom.identity import LoginConfigError, User, caller, login_from_env

from .adapter import ChatroomAdapter
from .mcp import servers_from_env
from .memory import MEMORY_HEADER
from .model import chat_models
from .place import chatroom_props
from .prompt import SYSTEM_PROMPT
from .scripts import scripts_from_env
from .sessions import SessionStore
from .workdir import idle_seconds_from_env, limits_from_env, workdir_enabled
from .workspace import STORAGE_HEADER, WORKSPACE_HEADER, storage_url

logger = logging.getLogger("agent_py")


def make_adapter(
    env: Mapping[str, str], transport: httpx.AsyncBaseTransport | None = None
) -> ChatroomAdapter:
    timeout = float(env.get("AGENT_RUN_TIMEOUT_SECONDS") or 1800)
    # Not this server's folder: Claude Code describes its working folder (git
    # status and all) to the model. Each user works in a folder in here.
    # Absolute: run folders, the sandbox's paths and the working folder's
    # checks all build on it.
    root = str(Path(env.get("AGENT_PY_WORKDIR") or tempfile.mkdtemp(prefix="agent-py-")).resolve())
    models = chat_models(env)
    return ChatroomAdapter(
        name="report",
        description="The chatroom's chat agent",
        options={
            "model": models[0],
            # No built-in Claude Code tools: the browser's tools and this
            # agent's own MCP tools are the only ones (adapter.py), plus Skill,
            # Read/Glob/Grep for the working folder (workdir.py) and Bash for
            # skills' scripts when they are on (scripts.py).
            "tools": [],
            "cwd": root,
        },
        system_prompt=SYSTEM_PROMPT,
        models=models,
        storage_url=storage_url(env),
        skills_root=Path(root),
        transport=transport,
        mcp_servers=servers_from_env(env),
        scripts=scripts_from_env(env),
        workdir=limits_from_env(env) if workdir_enabled(env) else None,
        idle_seconds=idle_seconds_from_env(env),
        sessions=SessionStore(Path(root)),
        query_timeout_seconds=timeout or None,
    )


def run_error(input_data: RunAgentInput, message: str) -> RunErrorEvent:
    return RunErrorEvent(
        type=EventType.RUN_ERROR,
        thread_id=input_data.thread_id,
        run_id=input_data.run_id,
        message=message,
    )


def refusal(input_data: RunAgentInput, user: User) -> str | None:
    """Why this run can't go ahead for `user`; None when it can."""
    claimed = chatroom_props(input_data).get("user")
    if not isinstance(claimed, dict) or not claimed.get("id"):
        return "The chat couldn't tell who you are. Sign in again and retry."
    if claimed["id"] != user.sub:
        return "This run is for another user. Sign in again and retry."
    return None


def create_app(
    env: Mapping[str, str] | None = None, adapter: ChatroomAdapter | None = None
) -> FastAPI:
    env = os.environ if env is None else env
    # Whether runs must be signed: AUTH_MODE says, and a missing key
    # never means "no login". Unconfigured, this raises and the server won't start.
    login = login_from_env(env)
    if login.required and login.key is None:
        logger.warning(
            "Login is on but KNOWLEDGE_PUBLIC_KEY is not set: every run is refused until it is "
            "(the API server's GET /identity/public-key)."
        )
    adapter = adapter or make_adapter(env)

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        yield
        await adapter.shutdown()

    # What a caller who can't be identified is told.
    if not login.required:
        refused = (
            "This agent runs without login (AUTH_MODE=local) but the request is signed, so the "
            "app has login on. Set AUTH_MODE=oidc and KNOWLEDGE_PUBLIC_KEY here"
        )
    elif login.key is None:
        refused = "Set KNOWLEDGE_PUBLIC_KEY: login is on"
    else:
        refused = "Sign in first"

    app = FastAPI(title="agent-py", lifespan=lifespan)
    app.state.adapter = adapter

    @app.get("/agent/models")
    async def models(request: Request) -> dict[str, str | tuple[str, ...]]:
        if caller(dict(request.headers), login, audience=None) is None:
            raise HTTPException(401, refused)
        available = chat_models(env)
        return {"default": available[0], "models": available}

    @app.post("/agent/report")
    async def report(input_data: RunAgentInput, request: Request) -> StreamingResponse:
        # The app's X-Knowledge-User has no audience. Without login there is
        # no header and everyone is the local user.
        user = caller(dict(request.headers), login, audience=None)
        if user is None:
            raise HTTPException(401, refused)
        encoder = EventEncoder(accept=request.headers.get("accept"))
        reason = refusal(input_data, user)

        async def events():
            if reason:
                yield encoder.encode(run_error(input_data, reason))
                return
            async for event in adapter.run(
                input_data,
                storage_token=request.headers.get(STORAGE_HEADER),
                user=user.sub,
                memory_token=request.headers.get(MEMORY_HEADER),
                # The page's workspace: storage, skills and memory calls name it.
                workspace=request.headers.get(WORKSPACE_HEADER) or None,
            ):
                yield encoder.encode(event)

        return StreamingResponse(events(), media_type=encoder.get_content_type())

    @app.get("/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    return app


def main() -> None:
    import uvicorn

    logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))
    try:
        app = create_app()
    except LoginConfigError as err:
        raise SystemExit(f"[agent-py] {err}") from None
    uvicorn.run(
        app,
        host=os.environ.get("AGENT_PY_HOST", "127.0.0.1"),
        port=int(os.environ.get("AGENT_PY_PORT", "9300")),
    )


if __name__ == "__main__":
    main()
