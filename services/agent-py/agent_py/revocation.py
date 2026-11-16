"""Ends a run whose user stops being a member of its workspace (issue #255).

The Python twin of apps/agent/src/storage/revocation.ts. The run's user may be
removed from the workspace, leave it, or see it archived while Claude works
(docs/workspaces.md, "Removing a member, or leaving"). The storage API checks
membership on every request, so this agent asks it again (GET /access, with the
run's token and workspace) at every tool boundary, for tools of any kind (the
workspace tools, memory, skills, outside MCP servers):

- before a call (PreToolUse): once the user is gone the call is refused and the
  run stops instead of starting another model turn;
- after the calls of a model turn end, whether they succeeded or failed, and
  before the next model request (PostToolBatch): a call accepted before the
  removal runs to its end and its result stays in the transcript (and its audit
  entries in the log), but the run stops there, so the model gets no turn
  after it.

Both storage servers (api-py and apps/agent) answer 404 {"error": "Workspace
not found"} for a workspace the user isn't a member of and for an archived one.
Anything else is not a revocation: storage down, a timeout, or a 404 without
that error, from an agent server that has no storage routes (the e2e mock, a
server without a database). The tools report those themselves.
"""

from __future__ import annotations

from collections.abc import Callable

from claude_agent_sdk import HookContext, HookInput, HookJSONOutput, HookMatcher

from .workspace import Storage, WorkspaceError

# The error both storage servers send with that 404 (NOT_FOUND in api_py/workspaces.py
# and apps/agent/src/storage/workspaces.ts).
WORKSPACE_NOT_FOUND = "Workspace not found"

NO_LONGER_MEMBER = (
    "The user is no longer a member of this workspace (they were removed, left, or it was "
    "archived), so this run stopped."
)


async def no_longer_member(storage: Storage) -> bool:
    """True once the storage API says the run's workspace is gone for its user."""
    try:
        await storage.call("GET", "/access")
    except WorkspaceError as err:
        return err.status == 404 and str(err) == WORKSPACE_NOT_FOUND
    return False


def membership_hooks(storage: Callable[[], Storage]) -> dict[str, HookMatcher]:
    """The PreToolUse and PostToolBatch hooks, each for every tool (no matcher)."""

    async def before(
        _input: HookInput, _tool_use_id: str | None, _context: HookContext
    ) -> HookJSONOutput:
        if not await no_longer_member(storage()):
            return {}
        return {
            "continue_": False,
            "stopReason": NO_LONGER_MEMBER,
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "deny",
                "permissionDecisionReason": NO_LONGER_MEMBER,
            },
        }

    async def after(
        _input: HookInput, _tool_use_id: str | None, _context: HookContext
    ) -> HookJSONOutput:
        if not await no_longer_member(storage()):
            return {}
        return {"continue_": False, "stopReason": NO_LONGER_MEMBER}

    return {
        "PreToolUse": HookMatcher(hooks=[before]),
        "PostToolBatch": HookMatcher(hooks=[after]),
    }
