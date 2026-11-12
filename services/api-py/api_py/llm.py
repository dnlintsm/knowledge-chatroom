"""One call to the Messages API, as createMessage in apps/agent/src/suggest.ts makes it with the Anthropic SDK.

For the memory work that needs a small model (importing plain text now, the
background learner later). The SDK's settings are read the same way: the key
from ANTHROPIC_API_KEY (x-api-key) or ANTHROPIC_AUTH_TOKEN (a bearer token),
the endpoint from ANTHROPIC_BASE_URL, a 30 s timeout and one retry. The model
is chosen as the agent server chooses it (model.ts, suggest.ts, memory/learn.ts).
"""

from __future__ import annotations

import asyncio
import os
import re
from collections.abc import Awaitable, Callable, Mapping
from typing import Any

import httpx

# The same defaults as apps/agent/src/model.ts and suggest.ts.
DEFAULT_CLAUDE_MODEL = "claude-sonnet-5"
DEFAULT_SUGGESTIONS_MODEL = "claude-haiku-5-5"
API_VERSION = "2023-06-01"
TIMEOUT_SECONDS = 30.0
MAX_RETRIES = 1
_RETRY_STATUS = {408, 409, 429}

CreateMessage = Callable[[dict[str, Any]], Awaitable[dict[str, Any]]]


class ModelError(RuntimeError):
    """The call failed, or the model wasn't reachable."""


def _api_name(model: str) -> str:
    """A dotted Claude name ("claude-sonnet-4.6") becomes the API id; gateways' names stay as they are."""
    return model.replace(".", "-") if re.match(r"^claude-", model) else model


def resolve_model(env: Mapping[str, str] | None = None) -> str:
    env = os.environ if env is None else env
    return _api_name(env.get("CLAUDE_MODEL") or env.get("ANTHROPIC_MODEL") or DEFAULT_CLAUDE_MODEL)


def suggestions_model(env: Mapping[str, str] | None = None) -> str:
    env = os.environ if env is None else env
    configured = env.get("SUGGESTIONS_MODEL")
    if configured:
        return _api_name(configured)
    main = resolve_model(env)
    return DEFAULT_SUGGESTIONS_MODEL if re.match(r"^claude-", main) else main


def learn_model(env: Mapping[str, str] | None = None) -> str:
    """MEMORY_MODEL, else the suggestions model: what memory/learn.ts uses."""
    env = os.environ if env is None else env
    configured = (env.get("MEMORY_MODEL") or "").strip()
    return _api_name(configured) if configured else suggestions_model(env)


def _endpoint(env: Mapping[str, str]) -> str:
    base = (env.get("ANTHROPIC_BASE_URL") or "https://api.anthropic.com").rstrip("/")
    return f"{base}/v1/messages"


def _headers(env: Mapping[str, str]) -> dict[str, str]:
    headers = {"anthropic-version": API_VERSION, "content-type": "application/json"}
    key, token = env.get("ANTHROPIC_API_KEY"), env.get("ANTHROPIC_AUTH_TOKEN")
    if key:
        headers["x-api-key"] = key
    if token:
        headers["authorization"] = f"Bearer {token}"
    if not key and not token:
        raise ModelError("no ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN is set")
    return headers


def _retries(response: httpx.Response) -> bool:
    should = response.headers.get("x-should-retry")
    if should in ("true", "false"):
        return should == "true"
    return response.status_code in _RETRY_STATUS or response.status_code >= 500


def message_creator(
    env: Mapping[str, str] | None = None, transport: httpx.AsyncBaseTransport | None = None
) -> CreateMessage:
    """messages.create(params): the parsed response, or ModelError."""

    async def create(params: dict[str, Any]) -> dict[str, Any]:
        settings = os.environ if env is None else env
        headers = _headers(settings)
        async with httpx.AsyncClient(timeout=TIMEOUT_SECONDS, transport=transport) as client:
            for attempt in range(MAX_RETRIES + 1):
                last = attempt == MAX_RETRIES
                try:
                    response = await client.post(_endpoint(settings), json=params, headers=headers)
                except httpx.HTTPError as err:
                    if last:
                        raise ModelError(f"the model wasn't reachable: {err}") from err
                    await asyncio.sleep(0.5)
                    continue
                if response.is_success:
                    return response.json()
                if last or not _retries(response):
                    raise ModelError(
                        f"the model answered {response.status_code}: {response.text[:300]}"
                    )
                await asyncio.sleep(0.5)
        raise ModelError("the model wasn't reachable")  # not reached

    return create
