import type { HookCallbackMatcher, HookEvent } from "@anthropic-ai/claude-agent-sdk";

import type { Storage } from "./index";

/** What the run is told, and stops with, once its user is no longer a member (issue #255). */
export const NO_LONGER_MEMBER =
  "The user is no longer a member of this workspace (they were removed, left, or it was archived), so this run stopped.";

/** The hook events membershipHooks covers: before each tool call, and after each batch of calls ends. */
export type RevocationEvent = Extract<HookEvent, "PreToolUse" | "PostToolBatch">;

/**
 * Ends a run whose user stops being a member of its workspace (docs/workspaces.md,
 * "Removing a member, or leaving"). Membership is checked again at every tool
 * boundary, for tools of any kind (the workspace tools, memory, skills, Bash,
 * outside MCP servers):
 *
 * - before a call (PreToolUse): once it is gone the call is refused and the run
 *   stops instead of starting another model turn;
 * - after the calls of a model turn end, whether they succeeded or failed, and
 *   before the next model request (PostToolBatch): a call accepted before the
 *   removal runs to its end and its result stays in the transcript (and its
 *   audit entries in the log), but the run stops there, so the model gets no
 *   turn after it. (PostToolUseFailure can't do this: the engine doesn't stop
 *   on it for a tool that returns an error result.)
 */
export function membershipHooks(
  storage: () => Storage | null,
  userId: string,
): Record<RevocationEvent, HookCallbackMatcher> {
  const gone = async () => {
    const current = storage();
    // No storage (starting, or failed): the workspace tools say so themselves.
    return Boolean(current && !(await current.access.membership(userId)));
  };
  return {
    PreToolUse: {
      hooks: [
        async () =>
          (await gone())
            ? {
                continue: false,
                stopReason: NO_LONGER_MEMBER,
                hookSpecificOutput: {
                  hookEventName: "PreToolUse" as const,
                  permissionDecision: "deny" as const,
                  permissionDecisionReason: NO_LONGER_MEMBER,
                },
              }
            : {},
      ],
    },
    PostToolBatch: { hooks: [async () => ((await gone()) ? { continue: false, stopReason: NO_LONGER_MEMBER } : {})] },
  };
}
