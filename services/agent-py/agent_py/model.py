"""The model a run uses: CLAUDE_MODEL, else ANTHROPIC_MODEL, else the default."""

from __future__ import annotations

import os
import re
from collections.abc import Mapping

DEFAULT_CLAUDE_MODEL = "claude-sonnet-5"


def normalize_model(model: str) -> str:
    return model.replace(".", "-") if re.match(r"^claude-", model) else model


def resolve_model(env: Mapping[str, str] | None = None) -> str:
    """CLAUDE_MODEL, then ANTHROPIC_MODEL, then the default.

    A dotted Claude name ("claude-sonnet-4.6") becomes the API id
    ("claude-sonnet-4-6"). Any other name is left alone: gateways such as
    OpenRouter or LiteLLM use dots in theirs ("anthropic/claude-sonnet-4.6").
    """
    env = os.environ if env is None else env
    model = env.get("CLAUDE_MODEL") or env.get("ANTHROPIC_MODEL") or DEFAULT_CLAUDE_MODEL
    return normalize_model(model)


def chat_models(env: Mapping[str, str]) -> tuple[str, ...]:
    """Default first, then the deployment's additional choices in display order."""
    additional = (
        normalize_model(model.strip())
        for model in env.get("CHAT_MODELS", "").split(",")
        if model.strip()
    )
    return tuple(dict.fromkeys([resolve_model(env), *additional]))
