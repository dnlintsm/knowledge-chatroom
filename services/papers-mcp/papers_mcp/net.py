"""Outgoing HTTP for the paper sources, in one place so tests can replace it."""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

USER_AGENT = "knowledge-chatroom-papers/0.1 (+https://github.com/dnlintsm/knowledge-chatroom)"
TIMEOUT = float(os.environ.get("PAPERS_HTTP_TIMEOUT", "30"))


# Query parameters that identify this deployment to a source (openalex.py adds
# them). They stay out of error messages, which Claude and the user read.
PRIVATE_PARAMS = frozenset({"api_key", "mailto"})


class SourceError(Exception):
    """A paper source refused or failed; the message is meant for Claude."""


def shown(url: str) -> str:
    """The URL as an error message may show it: without the query's private parameters."""
    parts = urllib.parse.urlsplit(url)
    query = urllib.parse.parse_qsl(parts.query, keep_blank_values=True)
    kept = [(name, value) for name, value in query if name not in PRIVATE_PARAMS]
    if len(kept) == len(query):
        return url
    return urllib.parse.urlunsplit(parts._replace(query=urllib.parse.urlencode(kept, safe=":|,*")))


def get(url: str, *, accept: str = "application/json", max_bytes: int | None = None) -> bytes:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": accept})
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT) as response:
            if max_bytes is None:
                return response.read()
            data = response.read(max_bytes + 1)
            if len(data) > max_bytes:
                raise SourceError(f"{shown(url)} is larger than {max_bytes // 1_000_000} MB")
            return data
    except urllib.error.HTTPError as err:
        if err.code == 404:
            raise SourceError(f"Not found: {shown(url)}") from err
        if err.code == 429:
            raise SourceError(
                "The paper source is rate limiting us; try again in a minute."
            ) from err
        raise SourceError(f"{shown(url)} answered {err.code}") from err
    except (urllib.error.URLError, TimeoutError) as err:
        raise SourceError(f"Couldn't reach {shown(url)}: {getattr(err, 'reason', err)}") from err


def get_json(url: str) -> Any:
    try:
        return json.loads(get(url))
    except json.JSONDecodeError as err:
        raise SourceError(f"{shown(url)} didn't answer JSON") from err
