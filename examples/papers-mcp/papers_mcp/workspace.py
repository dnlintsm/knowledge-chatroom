"""Writing saved papers into the chatroom's workspace as the calling user.

With "storageAccess": true in MCP_SERVERS, each call carries an
X-Knowledge-Storage token. Passed on unchanged to the chatroom's storage API
(the agent server's /files, KNOWLEDGE_STORAGE_URL), it writes as Claude acting
for the signed-in user: only where that user may, and in a knowledge node only
as a proposal (issue #88). Without login there is no token, and the storage API
answers as the local user.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request

STORAGE_HEADER = "x-knowledge-storage"


class WorkspaceError(Exception):
    """The storage API refused or failed; the message is meant for Claude."""


def write(
    base_url: str,
    path: str,
    data: bytes,
    mime: str,
    token: str | None,
    *,
    node: str | None = None,
    experiment: str | None = None,
    note: str | None = None,
    timeout: float = 60,
) -> bool:
    """Write a file; True when it became a proposal (in a knowledge node), False when written."""
    propose = bool(node) and not experiment
    query: dict[str, str] = {k: v for k, v in (("node", node), ("experiment", experiment)) if v}
    if propose:
        query["propose"] = ""
        if note:
            query["note"] = note
    url = f"{base_url.rstrip('/')}/files/{urllib.parse.quote(path.lstrip('/'))}"
    if query:
        url += "?" + urllib.parse.urlencode(query)
    headers = {"Content-Type": mime}
    if token:
        headers[STORAGE_HEADER] = token
    request = urllib.request.Request(url, data=data, method="PUT", headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=timeout):
            return propose
    except urllib.error.HTTPError as err:
        if err.code == 413:
            raise WorkspaceError(f"{path} is larger than the workspace accepts (MAX_UPLOAD_BYTES)") from err
        raise WorkspaceError(f"Couldn't save {path} ({err.code}): {_reason(err)}") from err
    except (urllib.error.URLError, TimeoutError) as err:
        raise WorkspaceError(f"The chatroom's storage API at {base_url} isn't reachable: {err}") from err


def _reason(err: urllib.error.HTTPError) -> str:
    try:
        return json.loads(err.read()).get("error") or err.reason
    except (ValueError, AttributeError):
        return str(err.reason)
