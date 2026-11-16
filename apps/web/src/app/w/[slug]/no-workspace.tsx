"use client";

import { LogOut } from "lucide-react";

import { CreateWorkspaceForm } from "@/components/workspace/create-workspace";
import { workspacePath } from "@/lib/workspace-choice";

/**
 * A user who belongs to no workspace yet (issue #226, docs/workspaces.md,
 * "Screens"): they can create one, unless the server limits who may
 * (WORKSPACE_CREATORS), and learn how to join someone else's.
 */
export function NoWorkspaceYet({ email, login, canCreate }: { email: string | null; login: boolean; canCreate: boolean }) {
  const byEmail = email ? (
    <>
      {" "}
      by your email, <span className="font-medium text-[var(--foreground)]">{email}</span>
    </>
  ) : null;
  return (
    <main
      data-testid="workspace-onboarding"
      className="flex min-h-screen items-start justify-center bg-[var(--background)] p-6 pt-[12vh] text-[var(--foreground)]"
    >
      <div className="w-full max-w-md">
        <h1 className="mb-2 text-lg font-semibold">{canCreate ? "Create your first workspace" : "You aren't in a workspace yet"}</h1>
        {canCreate ? (
          <>
            <p className="mb-5 text-sm text-[var(--muted-foreground)]">
              You aren&apos;t in a workspace yet. Create one to start, or, to join a workspace someone else has, ask one
              of its Owners or Admins to add you{byEmail}.
            </p>
            <div className="rounded-lg border border-[var(--border)] p-4">
              <CreateWorkspaceForm onCreated={(w) => window.location.assign(workspacePath(w.slug))} />
            </div>
          </>
        ) : (
          <p className="mb-5 text-sm text-[var(--muted-foreground)]">
            To join a workspace, ask one of its Owners or Admins to add you{byEmail}. Creating workspaces is limited on
            this server.
          </p>
        )}
        {login && (
          <form method="post" action="/api/auth/logout" className="mt-4">
            <button
              type="submit"
              className="flex items-center gap-1.5 text-xs text-[var(--muted-foreground)] hover:text-[var(--foreground)] cursor-pointer"
            >
              <LogOut className="size-3.5" /> Sign out
            </button>
          </form>
        )}
      </div>
    </main>
  );
}
