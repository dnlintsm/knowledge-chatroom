"""The model, chosen as apps/agent/src/model.ts does."""

from __future__ import annotations

import os
import re

DEFAULT_CLAUDE_MODEL = "claude-sonnet-5"


def resolve_model(env: dict[str, str] | None = None) -> str:
    """CLAUDE_MODEL, then ANTHROPIC_MODEL, then the default.

    A dotted Claude name ("claude-sonnet-4.6") becomes the API id
    ("claude-sonnet-4-6"). Any other name is left alone: gateways such as
    OpenRouter or LiteLLM use dots in theirs ("anthropic/claude-sonnet-4.6").
    """
    env = os.environ if env is None else env
    model = env.get("CLAUDE_MODEL") or env.get("ANTHROPIC_MODEL") or DEFAULT_CLAUDE_MODEL
    return model.replace(".", "-") if re.match(r"^claude-", model) else model
