/**
 * Who may do what to whom among a workspace's members (issue #255,
 * docs/workspaces.md, "Changing a role" and "Removing a member, or leaving"),
 * for the screens to offer only what the API server would allow. The server
 * checks every change again. Client-safe and without React, so the unit tests
 * can call it directly.
 */

import type { WorkspaceInfo } from "./workspace-request";

export type MemberRole = WorkspaceInfo["role"];

const ORDER: MemberRole[] = ["owner", "admin", "member"];

/**
 * The roles `viewer` may give a member whose role is `target`, the current
 * one included; empty when they may change nothing. Owners give any member
 * any role. Admins make a Member an Admin, and step down to Member themselves.
 */
export function assignableRoles(viewer: MemberRole, target: MemberRole, self: boolean): MemberRole[] {
  if (viewer === "owner") return ORDER;
  if (viewer === "admin" && (self || target === "member")) return ["admin", "member"];
  return [];
}

/** Whether `viewer` may remove a member whose role is `target` (yourself: Leave, from the switcher). */
export function canRemove(viewer: MemberRole, target: MemberRole, self: boolean): boolean {
  if (self) return false;
  return viewer === "owner" || (viewer === "admin" && target === "member");
}

/** Whether `role` may rename the workspace, archive it, and restore an archived one. */
export function settingsFor(role: MemberRole, isDefault: boolean) {
  return { rename: role === "owner" || role === "admin", archive: role === "owner" && !isDefault };
}

/**
 * Whether the name typed to confirm archiving matches the workspace's, ignoring
 * spaces at either end and runs of spaces, as a person reads it.
 */
export function namesMatch(typed: string, name: string): boolean {
  const norm = (s: string) => s.replace(/\s+/g, " ").trim();
  return norm(typed) !== "" && norm(typed) === norm(name);
}

/**
 * The requests that transfer ownership (or share it), in the order that
 * always leaves an Owner: make them Owner, give them Full access on the root
 * if asked, then lower your own role if you chose to.
 */
export function transferSteps(
  workspaceId: string,
  me: string,
  them: string,
  options: { fullAccess: boolean; myRole: MemberRole },
): { path: string; method: "PATCH" | "POST"; body: Record<string, unknown> }[] {
  const member = (id: string) => `/api/workspaces/${encodeURIComponent(workspaceId)}/members/${encodeURIComponent(id)}`;
  return [
    { path: member(them), method: "PATCH", body: { role: "owner" } },
    ...(options.fullAccess
      ? [
          {
            path: "/api/access/grants",
            method: "POST" as const,
            body: { node: null, principalType: "user", principalId: them, role: "owner" },
          },
        ]
      : []),
    ...(options.myRole !== "owner"
      ? [{ path: member(me), method: "PATCH" as const, body: { role: options.myRole } }]
      : []),
  ];
}
