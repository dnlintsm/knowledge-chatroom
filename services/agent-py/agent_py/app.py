"""The FastAPI app: POST /agent/report, as docs/remote-agent.md describes.

    uv run python -m agent_py.app    # http://127.0.0.1:9300, then AGENT_URL=http://127.0.0.1:9300

Environment:
    CLAUDE_MODEL / ANTHROPIC_MODEL  the model (model.py), as for the TypeScript agent
    ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL, ...  read by Claude Code itself
    KNOWLEDGE_PUBLIC_KEY            the agent server's GET /identity/public-key; set it with login on
    AGENT_RUN_TIMEOUT_SECONDS       stop a run after this long (default 1800, 0 = never)
    AGENT_PY_WORKDIR                Claude Code's working folder (default: a new empty temp folder)
    AGENT_PY_HOST / AGENT_PY_PORT   where to listen (default 127.0.0.1:9300)
"""

from __future__ import annotations

import logging
import os
import tempfile
from collections.abc import AsyncIterator, Mapping
from contextlib import asynccontextmanager

from ag_ui.core import EventType, RunAgentInput, RunErrorEvent
from ag_ui.encoder import EventEncoder
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import StreamingResponse
from knowledge_chatroom.identity import User, caller, public_key

from .adapter import ChatroomAdapter
from .model import resolve_model
from .place import chatroom_props
from .prompt import SYSTEM_PROMPT

logger = logging.getLogger("agent_py")


def make_adapter(env: Mapping[str, str]) -> ChatroomAdapter:
    timeout = float(env.get("AGENT_RUN_TIMEOUT_SECONDS") or 1800)
    return ChatroomAdapter(
        name="report",
        description="The chatroom's chat agent",
        options={
            "model": resolve_model(dict(env)),
            # No built-in Claude Code tools: the browser's tools and this
            # agent's own MCP tools are the only ones (adapter.py).
            "tools": [],
            # Not this server's folder: Claude Code describes its working
            # folder (git status and all) to the model.
            "cwd": env.get("AGENT_PY_WORKDIR") or tempfile.mkdtemp(prefix="agent-py-"),
        },
        system_prompt=SYSTEM_PROMPT,
        query_timeout_seconds=timeout or None,
    )


def run_error(input_data: RunAgentInput, message: str) -> RunErrorEvent:
    return RunErrorEvent(
        type=EventType.RUN_ERROR, thread_id=input_data.thread_id, run_id=input_data.run_id, message=message
    )


def refusal(input_data: RunAgentInput, user: User) -> str | None:
    """Why this run can't go ahead for `user`; None when it can."""
    claimed = chatroom_props(input_data).get("user")
    if not isinstance(claimed, dict) or not claimed.get("id"):
        return "The chat couldn't tell who you are. Sign in again and retry."
    if claimed["id"] != user.sub:
        return "This run is for another user. Sign in again and retry."
    return None


def create_app(env: Mapping[str, str] | None = None, adapter: ChatroomAdapter | None = None) -> FastAPI:
    env = os.environ if env is None else env
    key = public_key(env["KNOWLEDGE_PUBLIC_KEY"]) if env.get("KNOWLEDGE_PUBLIC_KEY") else None
    adapter = adapter or make_adapter(env)

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        yield
        await adapter.shutdown()

    app = FastAPI(title="agent-py", lifespan=lifespan)

    @app.post("/agent/report")
    async def report(input_data: RunAgentInput, request: Request) -> StreamingResponse:
        # The app's X-Knowledge-User has no audience. Without login there is
        # no header and everyone is the local user.
        user = caller(dict(request.headers), key, audience=None)  # type: ignore[arg-type]
        if user is None:
            raise HTTPException(401, "Sign in first" if key else "Set KNOWLEDGE_PUBLIC_KEY: login is on")
        encoder = EventEncoder(accept=request.headers.get("accept"))
        reason = refusal(input_data, user)

        async def events():
            if reason:
                yield encoder.encode(run_error(input_data, reason))
                return
            async for event in adapter.run(input_data):
                yield encoder.encode(event)

        return StreamingResponse(events(), media_type=encoder.get_content_type())

    @app.get("/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    return app


def main() -> None:
    import uvicorn

    logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))
    uvicorn.run(
        create_app(),
        host=os.environ.get("AGENT_PY_HOST", "127.0.0.1"),
        port=int(os.environ.get("AGENT_PY_PORT", "9300")),
    )


if __name__ == "__main__":
    main()
