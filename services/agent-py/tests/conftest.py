"""A fake Claude: the adapter's session worker talks to it instead of Claude Code."""

from __future__ import annotations

from typing import Any, ClassVar

import claude_agent_sdk
import pytest
from claude_agent_sdk import AssistantMessage, ResultMessage, SystemMessage, TextBlock


class FakeClaude:
    """Stands in for claude_agent_sdk.ClaudeSDKClient; answers every query with `reply`."""

    reply = "Hello from the fake model"
    created: ClassVar[list[FakeClaude]] = []

    def __init__(self, options: Any = None) -> None:
        self.options = options
        self.prompts: list[Any] = []
        FakeClaude.created.append(self)

    async def connect(self) -> None:
        pass

    async def disconnect(self) -> None:
        pass

    async def interrupt(self) -> None:
        pass

    async def query(self, prompt: Any, session_id: str = "default") -> None:
        if not isinstance(prompt, str):
            prompt = [message async for message in prompt]
        self.prompts.append(prompt)

    async def receive_response(self):
        yield SystemMessage(
            subtype="init", data={"session_id": "11111111-2222-3333-4444-555555555555"}
        )
        yield AssistantMessage(content=[TextBlock(text=self.reply)], model="fake")
        yield ResultMessage(
            subtype="success",
            duration_ms=1,
            duration_api_ms=1,
            is_error=False,
            num_turns=1,
            session_id="11111111-2222-3333-4444-555555555555",
            result=self.reply,
        )


@pytest.fixture
def claude(monkeypatch: pytest.MonkeyPatch) -> type[FakeClaude]:
    FakeClaude.created = []
    monkeypatch.setattr(claude_agent_sdk, "ClaudeSDKClient", FakeClaude)
    return FakeClaude
