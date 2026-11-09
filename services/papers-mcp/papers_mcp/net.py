"""Outgoing HTTP for the paper sources, in one place so tests can replace it."""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from typing import Any

USER_AGENT = "knowledge-chatroom-papers/0.1 (+https://github.com/dnlintsm/knowledge-chatroom)"
TIMEOUT = float(os.environ.get("PAPERS_HTTP_TIMEOUT", "30"))


class SourceError(Exception):
    """A paper source refused or failed; the message is meant for Claude."""


def get(url: str, *, accept: str = "application/json", max_bytes: int | None = None) -> bytes:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": accept})
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT) as response:
            if max_bytes is None:
                return response.read()
            data = response.read(max_bytes + 1)
            if len(data) > max_bytes:
                raise SourceError(f"{url} is larger than {max_bytes // 1_000_000} MB")
            return data
    except urllib.error.HTTPError as err:
        if err.code == 404:
            raise SourceError(f"Not found: {url}") from err
        if err.code == 429:
            raise SourceError("The paper source is rate limiting us; try again in a minute.") from err
        raise SourceError(f"{url} answered {err.code}") from err
    except (urllib.error.URLError, TimeoutError) as err:
        raise SourceError(f"Couldn't reach {url}: {getattr(err, 'reason', err)}") from err


def get_json(url: str) -> Any:
    try:
        return json.loads(get(url))
    except json.JSONDecodeError as err:
        raise SourceError(f"{url} didn't answer JSON") from err
