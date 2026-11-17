"use client";

import { useEffect, useId, useState } from "react";
import { ArrowLeft, UserPlus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { inventoryMatches, type PlatformWorkspace } from "@/lib/workspace-admin";
import { workspacePath } from "@/lib/workspace-choice";
import { DEFAULT_SLUG } from "@/lib/workspace-request";
import { Dialog } from "./create-workspace";

/** A request to the API server's /platform, with its answer. */
async function platformApi<T>(
  path: string,
  init?: RequestInit,
): Promise<{ status: number; body: T & { error?: string } }> {
  const res = await fetch(`/api/platform${path}`, {
    cache: "no-store",
    ...init,
    headers: init?.body ? { "Content-Type": "application/json" } : undefined,
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as T & { error?: string } };
}

const day = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { dateStyle: "medium" }) : "never";

/**
 * The workspace inventory (issue #255, docs/workspaces.md, "Workspace
 * inventory"): every workspace in the deployment, active and archived, with
 * who created it, how many members it has, its Owners and when it was last
 * used, and no content. "Add an Owner" is for a workspace whose Owners can no
 * longer sign in. Only the deployment's admins (PLATFORM_ADMINS) get the list.
 */
export function WorkspaceInventory() {
  const [workspaces, setWorkspaces] = useState<PlatformWorkspace[] | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState<PlatformWorkspace | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    platformApi<{ workspaces?: PlatformWorkspace[] }>("/workspaces")
      .then(({ status, body }) => {
        if (!live) return;
        if (status === 200) setWorkspaces(body.workspaces ?? []);
        else setRefused(body.error ?? `The inventory isn't available (${status}).`);
      })
      .catch((err) => live && setRefused(err instanceof Error ? err.message : String(err)));
    return () => {
      live = false;
    };
  }, []);

  const shown = workspaces?.filter((w) => inventoryMatches(w, query)) ?? [];
  return (
    <main
      data-testid="workspace-inventory"
      className="min-h-screen bg-[var(--background)] px-6 py-8 text-[var(--foreground)]"
    >
      <div className="mx-auto max-w-5xl">
        <a
          href={workspacePath(DEFAULT_SLUG)}
          className="mb-4 inline-flex items-center gap-1 text-xs text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
        >
          <ArrowLeft className="size-3.5" /> Back to the workspaces
        </a>
        <h1 className="mb-1 text-lg font-semibold">Workspace inventory</h1>
        <p className="mb-5 max-w-2xl text-sm text-[var(--muted-foreground)]">
          Every workspace on this server, for its admins. It shows no content, and being an admin doesn&apos;t make you
          a member of any. When a workspace&apos;s Owners can no longer sign in, add an Owner who can.
        </p>
        {refused !== null && (
          <p role="alert" className="text-sm text-[var(--muted-foreground)]">
            {refused}
          </p>
        )}
        {workspaces === null && refused === null && (
          <p className="text-sm text-[var(--muted-foreground)]">Loading the workspaces…</p>
        )}
        {workspaces !== null && (
          <>
            <div className="mb-3 flex items-center gap-3">
              <Input
                type="search"
                aria-label="Find a workspace"
                placeholder="Find by name, address or Owner"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="h-8 max-w-xs"
              />
              <span className="text-xs text-[var(--muted-foreground)]">
                {shown.length === workspaces.length
                  ? `${workspaces.length} workspace${workspaces.length === 1 ? "" : "s"}`
                  : `${shown.length} of ${workspaces.length}`}
              </span>
            </div>
            {notice && (
              <p role="status" className="mb-3 text-sm text-green-600">
                {notice}
              </p>
            )}
            <div className="overflow-x-auto rounded-lg border border-[var(--border)]">
              <table aria-label="Workspaces" className="w-full border-collapse text-left text-sm">
                <thead className="text-xs text-[var(--muted-foreground)]">
                  <tr>
                    {["Workspace", "Created", "Members", "Owners", "Last used", ""].map((h, i) => (
                      <th key={i} className="border-b border-[var(--border)] px-3 py-2 font-medium">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {shown.map((w) => (
                    <tr key={w.id} aria-label={w.name} className="align-top">
                      <td className="border-b border-[var(--border)] px-3 py-2">
                        <div className="font-medium">{w.name}</div>
                        <div className="text-xs text-[var(--muted-foreground)]">
                          {w.slug}
                          {w.status === "archived" && (
                            <span className="ml-1.5 rounded bg-[var(--secondary)] px-1 uppercase">Archived</span>
                          )}
                        </div>
                      </td>
                      <td className="border-b border-[var(--border)] px-3 py-2 text-xs">
                        {day(w.createdAt)}
                        <div className="text-[var(--muted-foreground)]">
                          {w.createdBy ? `by ${w.createdBy.name ?? "someone"}` : "by the server"}
                        </div>
                      </td>
                      <td className="border-b border-[var(--border)] px-3 py-2 text-xs">{w.memberCount}</td>
                      <td className="border-b border-[var(--border)] px-3 py-2 text-xs">
                        {w.owners.length === 0 ? (
                          <span className="text-[var(--muted-foreground)]">None</span>
                        ) : (
                          <ul aria-label={`Owners of ${w.name}`} className="flex flex-col gap-1">
                            {w.owners.map((o) => (
                              <li key={o.id}>
                                <span className="font-medium">{o.name ?? o.email ?? "Unnamed"}</span>
                                {o.email && o.name && (
                                  <span className="text-[var(--muted-foreground)]"> · {o.email}</span>
                                )}
                                <div className="text-[var(--muted-foreground)]">last signed in {day(o.lastSeenAt)}</div>
                              </li>
                            ))}
                          </ul>
                        )}
                        {!w.fullAccessHeld && (
                          <div className="mt-1 text-amber-700 dark:text-amber-300">Nobody active has Full access</div>
                        )}
                      </td>
                      <td className="border-b border-[var(--border)] px-3 py-2 text-xs">{day(w.lastActiveAt)}</td>
                      <td className="border-b border-[var(--border)] px-3 py-2 text-right">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          aria-label={`Add an Owner to ${w.name}`}
                          onClick={() => {
                            setNotice(null);
                            setAdding(w);
                          }}
                        >
                          <UserPlus className="size-3.5" /> Add an Owner
                        </Button>
                      </td>
                    </tr>
                  ))}
                  {shown.length === 0 && (
                    <tr>
                      <td colSpan={6} className="px-3 py-4 text-center text-xs text-[var(--muted-foreground)]">
                        No workspace matches.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
      {adding && (
        <AddOwnerDialog
          workspace={adding}
          onClose={() => setAdding(null)}
          onAdded={(entry, name) => {
            setWorkspaces((list) => list?.map((w) => (w.id === entry.id ? entry : w)) ?? list);
            setAdding(null);
            setNotice(`${name} is now an Owner of ${entry.name}.`);
          }}
        />
      )}
    </main>
  );
}

interface Found {
  id: string;
  name: string | null;
  email: string | null;
}

/**
 * Adding an Owner: found by the exact email they signed in with, and, when
 * nobody active holds Full access on the workspace, given it too (preselected
 * then), so they can share and recover its content.
 */
function AddOwnerDialog({
  workspace,
  onClose,
  onAdded,
}: {
  workspace: PlatformWorkspace;
  onClose: () => void;
  onAdded: (entry: PlatformWorkspace, name: string) => void;
}) {
  const [email, setEmail] = useState("");
  const [found, setFound] = useState<Found | null>(null);
  const [fullAccess, setFullAccess] = useState(!workspace.fullAccessHeld);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ids = useId();

  const find = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setFound(null);
    const { status, body } = await platformApi<{ user?: Found }>(
      `/users?email=${encodeURIComponent(email.trim())}`,
    ).catch((err) => ({
      status: 0,
      body: { error: err instanceof Error ? err.message : String(err) } as { user?: Found; error?: string },
    }));
    setBusy(false);
    if (status === 200 && body.user) setFound(body.user);
    else setError(body.error ?? `Couldn't look them up (${status}).`);
  };

  const add = async () => {
    if (!found) return;
    setBusy(true);
    setError(null);
    const { status, body } = await platformApi<{ workspace?: PlatformWorkspace }>(
      `/workspaces/${encodeURIComponent(workspace.id)}/owners`,
      { method: "POST", body: JSON.stringify({ userId: found.id, fullAccess }) },
    ).catch((err) => ({
      status: 0,
      body: { error: err instanceof Error ? err.message : String(err) } as {
        workspace?: PlatformWorkspace;
        error?: string;
      },
    }));
    if (status === 200 && body.workspace) {
      onAdded(body.workspace, found.name ?? found.email ?? "They");
      return;
    }
    setBusy(false);
    setError(body.error ?? `Couldn't add them (${status}).`);
  };

  const already = found !== null && workspace.owners.some((o) => o.id === found.id);
  return (
    <Dialog label={`Add an Owner to ${workspace.name}`} onClose={() => !busy && onClose()}>
      <div className="text-sm">
        <p className="mb-3 text-[var(--muted-foreground)]">
          For a workspace whose Owners can no longer sign in. They become an Owner, and a member if they aren&apos;t
          one. The workspace&apos;s Owners and Admins see this in its activity, with you as who did it.
        </p>
        <form onSubmit={find} className="mb-3">
          <label htmlFor={`${ids}-email`} className="mb-1 block text-xs font-medium">
            Their email
          </label>
          <div className="flex gap-2">
            <Input
              id={`${ids}-email`}
              type="email"
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                setFound(null);
              }}
              placeholder="The one they signed in with"
              className="h-8 flex-1"
            />
            <Button type="submit" size="sm" variant="outline" disabled={busy || !email.trim()}>
              Find
            </Button>
          </div>
        </form>
        {found && (
          <div className="mb-3 rounded-md border border-[var(--border)] p-3">
            <p className="mb-2">
              <span className="font-medium">{found.name ?? found.email}</span>
              {found.name && found.email && <span className="text-[var(--muted-foreground)]"> · {found.email}</span>}
              {already && <span className="text-[var(--muted-foreground)]"> is already an Owner.</span>}
            </p>
            <label className="flex items-start gap-2">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={fullAccess}
                onChange={(e) => setFullAccess(e.target.checked)}
              />
              <span>
                Also give them Full access to the whole workspace
                <span className="block text-xs text-[var(--muted-foreground)]">
                  {workspace.fullAccessHeld
                    ? "Someone who signed in lately already has it."
                    : "Nobody who signed in lately has it, so without it they can't share or recover its content."}{" "}
                  Only they get it, never you.
                </span>
              </span>
            </label>
          </div>
        )}
        {error && (
          <p role="alert" className="mb-3 text-xs text-red-500">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="button" size="sm" onClick={() => void add()} disabled={busy || !found}>
            {busy && found ? "Adding…" : "Make Owner"}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
