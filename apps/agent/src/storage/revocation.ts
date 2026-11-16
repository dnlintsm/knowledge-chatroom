import type { HookCallbackMatcher } from "@anthropic-ai/claude-agent-sdk";

import type { Storage } from "./index";

/** What the run is told, and stops with, once its user is no longer a member (issue #255). */
export const NO_LONGER_MEMBER =
  "The user is no longer a member of this workspace (they were removed, left, or it was archived), so this run stopped.";

/**
 * Ends a run whose user stops being a member of its workspace (docs/workspaces.md,
 * "Removing a member, or leaving"): before each tool call, of any kind (the
 * workspace tools, memory, skills, Bash, outside MCP servers), membership is
 * checked again. Once it is gone the call is refused and the run stops instead
 * of starting another model turn. A call accepted before that runs to its end.
 */
export function membershipHook(storage: () => Storage | null, userId: string): HookCallbackMatcher {
  return {
    hooks: [
      async () => {
        const current = storage();
        // No storage (starting, or failed): the workspace tools say so themselves.
        if (!current || (await current.access.membership(userId))) return {};
        return {
          continue: false,
          stopReason: NO_LONGER_MEMBER,
          hookSpecificOutput: {
            hookEventName: "PreToolUse" as const,
            permissionDecision: "deny" as const,
            permissionDecisionReason: NO_LONGER_MEMBER,
          },
        };
      },
    ],
  };
}
