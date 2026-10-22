"""Reading the chatroom's workspace files as the calling user.

With "storageAccess": true in MCP_SERVERS, each run sends this server an
X-Knowledge-Storage token. Passed on unchanged to the chatroom's storage API
(the agent server's /files, KNOWLEDGE_STORAGE_URL), it reads and writes
files as Claude acting for the signed-in user: only what that user can
reach, with writes in a knowledge node as proposals (issue #88). This server
never connects to the chatroom's database or object store itself.

Without login there is no token, and the storage API answers as the local user.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request

STORAGE_HEADER = "x-knowledge-storage"


class WorkspaceError(Exception):
    """The storage API refused or failed; the message is meant for Claude."""


def read_text(
    base_url: str,
    path: str,
    token: str | None,
    node: str | None = None,
    experiment: str | None = None,
    timeout: float = 30,
) -> str:
    """A text file's content from the workspace root, a knowledge node or an experiment."""
    query = {k: v for k, v in (("node", node), ("experiment", experiment)) if v}
    url = f"{base_url.rstrip('/')}/files/{urllib.parse.quote(path.lstrip('/'))}"
    if query:
        url += "?" + urllib.parse.urlencode(query)
    request = urllib.request.Request(url, headers={STORAGE_HEADER: token} if token else {})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.read().decode("utf-8")
    except urllib.error.HTTPError as err:
        raise WorkspaceError(f"Couldn't read {path} ({err.code}): {_reason(err)}") from err
    except (urllib.error.URLError, TimeoutError) as err:
        raise WorkspaceError(f"The chatroom's storage API at {base_url} isn't reachable: {err}") from err
    except UnicodeDecodeError as err:
        raise WorkspaceError(f"{path} isn't a text file") from err


def _reason(err: urllib.error.HTTPError) -> str:
    try:
        return json.loads(err.read()).get("error") or err.reason
    except (ValueError, AttributeError):
        return str(err.reason)
