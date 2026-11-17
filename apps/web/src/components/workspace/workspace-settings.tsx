"use client";

import { useEffect, useId, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { namesMatch, settingsFor } from "@/lib/workspace-admin";
import { DEFAULT_SLUG, type WorkspaceInfo } from "@/lib/workspace-request";
import { workspacesApi } from "./add-member";
import { Dialog } from "./create-workspace";
import { useRenameWorkspace } from "./current-workspace";
import { access } from "./sharing";
import { useWorkspace } from "./store";

/**
 * The current workspace's settings, from the switcher (issue #255,
 * docs/workspaces.md, "Renaming and archiving a workspace"): Owners and
 * Admins rename it; Owners archive it, never the default workspace, after
 * typing its name. Archiving takes everyone out of it, so the page then goes
 * to the user's default workspace.
 */
export function WorkspaceSettingsDialog({ workspace, onClose }: { workspace: WorkspaceInfo; onClose: () => void }) {
  const rename = useRenameWorkspace();
  const may = settingsFor(workspace.role, workspace.slug === DEFAULT_SLUG);
  const [name, setName] = useState(workspace.name);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const ids = useId();
  const path = `/${encodeURIComponent(workspace.id)}`;
  const trimmed = name.replace(/\s+/g, " ").trim();

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!trimmed || trimmed === workspace.name) return;
    setBusy(true);
    setNotice(null);
    const { status, body } = await workspacesApi<WorkspaceInfo>(path, {
      method: "PATCH",
      body: JSON.stringify({ name: trimmed }),
    }).catch((err) => ({
      status: 0,
      body: { error: err instanceof Error ? err.message : String(err) } as WorkspaceInfo & { error?: string },
    }));
    setBusy(false);
    if (status !== 200) {
      setNotice({ ok: false, text: body.error ?? `Couldn't rename it (${status}).` });
      return;
    }
    rename(body.name ?? trimmed);
    setNotice({ ok: true, text: "Renamed. Its address stays the same." });
  };

  const archive = async () => {
    setBusy(true);
    setNotice(null);
    const { status, body } = await workspacesApi(path, {
      method: "PATCH",
      body: JSON.stringify({ status: "archived" }),
    }).catch((err) => ({ status: 0, body: { error: err instanceof Error ? err.message : String(err) } }));
    if (status !== 200) {
      setBusy(false);
      setNotice({ ok: false, text: body.error ?? `Couldn't archive it (${status}).` });
      return;
    }
    window.location.assign("/");
  };

  return (
    <Dialog label="Workspace settings" onClose={() => !busy && onClose()}>
      <div className="text-sm">
        {may.rename && (
          <form onSubmit={save} aria-label="Rename the workspace" className="mb-4">
            <label htmlFor={`${ids}-name`} className="mb-1 block text-xs font-medium">
              Name
            </label>
            <div className="flex gap-2">
              <Input
                id={`${ids}-name`}
                value={name}
                maxLength={200}
                onChange={(e) => setName(e.target.value)}
                className="h-8 flex-1"
              />
              <Button type="submit" size="sm" disabled={busy || !trimmed || trimmed === workspace.name}>
                Rename
              </Button>
            </div>
          </form>
        )}
        {may.archive && (
          <section aria-label="Archive the workspace" className="rounded-md border border-[var(--border)] p-3">
            <h3 className="mb-1 text-xs font-medium">Archive</h3>
            <p className="mb-2 text-xs text-[var(--muted-foreground)]">
              Everyone loses access until an Owner restores it, from the switcher&apos;s Archived workspaces. Nothing is
              deleted. Chats running in it stop at their next step.
            </p>
            <label htmlFor={`${ids}-confirm`} className="mb-1 block text-xs">
              Type <span className="font-medium">{workspace.name}</span> to confirm
            </label>
            <div className="flex gap-2">
              <Input
                id={`${ids}-confirm`}
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                className="h-8 flex-1"
              />
              <Button
                type="button"
                variant="destructive"
                size="sm"
                disabled={busy || !namesMatch(typed, workspace.name)}
                onClick={() => void archive()}
              >
                Archive
              </Button>
            </div>
          </section>
        )}
        {!may.rename && !may.archive && (
          <p className="text-[var(--muted-foreground)]">
            Only the workspace&apos;s Owners and Admins change its settings.
          </p>
        )}
        {notice && (
          <p
            role={notice.ok ? "status" : "alert"}
            className={notice.ok ? "mt-2 text-xs text-green-600" : "mt-2 text-xs text-red-500"}
          >
            {notice.text}
          </p>
        )}
      </div>
    </Dialog>
  );
}

/**
 * Leaving the current workspace (docs/workspaces.md, "Removing a member, or
 * leaving"): says what happens first, and tells its last Owner to make someone
 * else Owner instead. The page then goes to the user's default workspace.
 */
export function LeaveWorkspaceDialog({ workspace, onClose }: { workspace: WorkspaceInfo; onClose: () => void }) {
  const { edits } = useWorkspace();
  const [me, setMe] = useState<string | null>(null);
  const [lastOwner, setLastOwner] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const base = `/${encodeURIComponent(workspace.id)}`;

  useEffect(() => {
    let live = true;
    Promise.all([
      access<{ me: { id: string } | null }>(""),
      workspacesApi<{ members?: { id: string; role: WorkspaceInfo["role"] }[] }>(`${base}/members`),
    ])
      .then(([who, listed]) => {
        if (!live) return;
        const id = who.me?.id ?? null;
        const members = listed.body.members ?? [];
        setMe(id);
        const mine = members.find((m) => m.id === id)?.role;
        setLastOwner(mine === "owner" && members.filter((m) => m.role === "owner").length === 1);
      })
      .catch((err) => live && setError(err instanceof Error ? err.message : String(err)));
    return () => {
      live = false;
    };
  }, [base]);

  const leave = async () => {
    if (!me) return;
    setBusy(true);
    setError(null);
    const { status, body } = await workspacesApi(`${base}/members/${encodeURIComponent(me)}`, {
      method: "DELETE",
    }).catch((err) => ({ status: 0, body: { error: err instanceof Error ? err.message : String(err) } }));
    if (status !== 200) {
      setBusy(false);
      setError(body.error ?? `Couldn't leave (${status}).`);
      return;
    }
    window.location.assign("/");
  };

  return (
    <Dialog label={`Leave ${workspace.name}?`} onClose={() => !busy && onClose()}>
      <div className="text-sm">
        {lastOwner ? (
          <p className="mb-4 text-[var(--muted-foreground)]">
            You&apos;re its only Owner. Make someone else Owner first, in Admin, People; then you can leave.
          </p>
        ) : (
          <p className="mb-4 text-[var(--muted-foreground)]">
            Your access to it goes, and only an Owner or Admin can add you again. Your drafts, chats and memory here
            stay private, and come back if you are.
            {edits.unsaved() && " Edits here that haven't saved yet are lost."}
          </p>
        )}
        {error && (
          <p role="alert" className="mb-3 text-xs text-red-500">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onClose} disabled={busy}>
            {lastOwner ? "Close" : "Cancel"}
          </Button>
          {!lastOwner && (
            <Button type="button" variant="destructive" size="sm" onClick={() => void leave()} disabled={busy || !me}>
              {busy ? "Leaving…" : "Leave"}
            </Button>
          )}
        </div>
      </div>
    </Dialog>
  );
}
