"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArchiveRestore, Check, ChevronDown, LayoutList, LogOut, Plus, Settings } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { MEMBER_ROLE_LABEL, readRecent, switcherSections, workspacePath } from "@/lib/workspace-choice";
import { isAborted, workspaceFetch, type WorkspaceInfo } from "@/lib/workspace-request";
import { CreateWorkspaceDialog, Dialog } from "./create-workspace";
import { useCurrentWorkspace } from "./current-workspace";
import { savedStateScope } from "./local-persistence";
import { useWorkspace } from "./store";
import { LeaveWorkspaceDialog, WorkspaceSettingsDialog } from "./workspace-settings";

/**
 * The workspace switcher, at the root of the breadcrumb (* docs/workspaces.md, "Screens"): the workspace's name, which goes to its
 * root as the fixed word "Workspace" did, and a menu of the user's
 * workspaces, recent ones first, with Create. Shown whenever the server has
 * workspaces, also with only one, so Create is always there for those the
 * server lets create one (WORKSPACE_CREATORS).
 *
 * It also opens the current workspace's settings (Owners and
 * Admins), leaving it (with login), and lists the archived workspaces the
 * user owns, to restore. The deployment's admins (PLATFORM_ADMINS) also get
 * the workspace inventory.
 */
export function WorkspaceSwitcher({ onRoot, current }: { onRoot: () => void; current: boolean }) {
  const workspace = useCurrentWorkspace();
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [dialog, setDialog] = useState<"settings" | "leave" | null>(null);
  const { account } = useWorkspace();
  const { leave, prompt } = useLeave();
  if (!workspace) return null;

  return (
    <span className="relative flex min-w-0 items-center">
      <button
        type="button"
        aria-current={current ? "location" : undefined}
        onClick={onRoot}
        title={`${workspace.name}: the workspace root`}
        className={cn(
          "flex min-w-0 items-center gap-1 rounded-l px-1 hover:bg-[var(--secondary)] hover:text-[var(--foreground)] cursor-pointer",
          current && "text-[var(--foreground)]",
        )}
      >
        <span className="truncate">{workspace.name}</span>
      </button>
      <button
        type="button"
        aria-label="Switch workspace"
        aria-haspopup="menu"
        aria-expanded={open}
        title="Switch workspace"
        onClick={() => setOpen((o) => !o)}
        className="flex h-5 items-center rounded-r px-0.5 hover:bg-[var(--secondary)] hover:text-[var(--foreground)] cursor-pointer"
      >
        <ChevronDown className="size-3" />
      </button>
      {open && (
        <SwitcherMenu
          current={workspace}
          onClose={() => setOpen(false)}
          onPick={(w) => {
            setOpen(false);
            leave(workspacePath(w.slug));
          }}
          onCreate={() => {
            setOpen(false);
            setCreating(true);
          }}
          onInventory={() => {
            setOpen(false);
            leave("/platform");
          }}
          onSettings={
            workspace.role === "owner" || workspace.role === "admin"
              ? () => {
                  setOpen(false);
                  setDialog("settings");
                }
              : undefined
          }
          onLeave={
            account.login
              ? () => {
                  setOpen(false);
                  setDialog("leave");
                }
              : undefined
          }
        />
      )}
      {creating && (
        <CreateWorkspaceDialog
          onClose={() => setCreating(false)}
          onCreated={(w) => {
            setCreating(false);
            leave(workspacePath(w.slug));
          }}
        />
      )}
      {dialog === "settings" && <WorkspaceSettingsDialog workspace={workspace} onClose={() => setDialog(null)} />}
      {dialog === "leave" && <LeaveWorkspaceDialog workspace={workspace} onClose={() => setDialog(null)} />}
      {prompt}
    </span>
  );
}

function SwitcherMenu({
  current,
  onPick,
  onCreate,
  onClose,
  onSettings,
  onLeave,
  onInventory,
}: {
  current: WorkspaceInfo;
  onPick: (workspace: WorkspaceInfo) => void;
  onCreate: () => void;
  onClose: () => void;
  /** The workspace inventory, offered only to the deployment's admins. */
  onInventory: () => void;
  /** The current workspace's settings, for its Owners and Admins. */
  onSettings?: () => void;
  /** Leaving the current workspace, with login. */
  onLeave?: () => void;
}) {
  const [listed, setListed] = useState<WorkspaceInfo[] | null>(null);
  // The archived workspaces this user owns, which they may restore.
  const [archived, setArchived] = useState<WorkspaceInfo[]>([]);
  const [restoring, setRestoring] = useState<string | null>(null);
  // Whether the server lets this user create one (WORKSPACE_CREATORS); unknown until listed.
  const [canCreate, setCanCreate] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const deploymentAdmin = useDeploymentAdmin();
  const menu = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    workspaceFetch("/api/workspaces?archived=true", { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`Couldn't list your workspaces (${res.status})`);
        const body = (await res.json()) as { workspaces?: WorkspaceInfo[]; canCreate?: boolean };
        const all = body.workspaces ?? [];
        setListed(all.filter((w) => w.status !== "archived"));
        setArchived(all.filter((w) => w.status === "archived"));
        setCanCreate(body.canCreate !== false);
      })
      .catch((err) => {
        if (!isAborted(err)) setError(err instanceof Error ? err.message : String(err));
      });
    return () => controller.abort();
  }, []);

  // Closes on a click elsewhere or Escape, like the other menus here.
  useEffect(() => {
    const away = (e: MouseEvent) => {
      if (!menu.current?.parentElement?.contains(e.target as Node)) onClose();
    };
    const escape = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", escape);
    };
  }, [onClose]);

  let recentIds: string[] = [];
  try {
    const user = savedStateScope()?.user;
    if (user) recentIds = readRecent(window.localStorage, user);
  } catch {
    // Site storage blocked: no recent ones.
  }
  const sections = switcherSections(listed ?? [current], recentIds, current.id);

  const restore = async (w: WorkspaceInfo) => {
    setRestoring(w.id);
    setError(null);
    try {
      const res = await workspaceFetch(`/api/workspaces/${encodeURIComponent(w.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "active" }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Couldn't restore ${w.name} (${res.status})`);
      }
      onPick({ ...w, status: "active" });
    } catch (err) {
      if (!isAborted(err)) setError(err instanceof Error ? err.message : String(err));
      setRestoring(null);
    }
  };
  const action = "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[var(--foreground)] hover:bg-[var(--secondary)] cursor-pointer";

  const item = (w: WorkspaceInfo, key: string) => {
    const here = w.id === current.id;
    return (
      <a
        key={key}
        role="menuitem"
        href={workspacePath(w.slug)}
        aria-current={here ? "page" : undefined}
        onClick={(e) => {
          if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
          e.preventDefault();
          if (here) onClose();
          else onPick(w);
        }}
        className="flex items-center gap-2 rounded px-2 py-1.5 text-[var(--foreground)] hover:bg-[var(--secondary)]"
      >
        <Check className={cn("size-3.5 shrink-0", !here && "invisible")} />
        <span className="min-w-0 flex-1 truncate">{w.name}</span>
        <span className="shrink-0 text-[var(--muted-foreground)]">{MEMBER_ROLE_LABEL[w.role]}</span>
      </a>
    );
  };

  return (
    <div
      ref={menu}
      role="menu"
      aria-label="Workspaces"
      className="absolute left-0 top-6 z-50 w-64 rounded-md border border-[var(--border)] bg-[var(--background)] p-1 text-xs shadow-lg"
    >
      {sections.recent.length > 0 && (
        <>
          <p className="px-2 pb-1 pt-1.5 text-[11px] font-medium text-[var(--muted-foreground)]">Recent</p>
          {sections.recent.map((w) => item(w, `recent:${w.id}`))}
          <div className="my-1 border-t border-[var(--border)]" />
        </>
      )}
      <p className="px-2 pb-1 pt-1.5 text-[11px] font-medium text-[var(--muted-foreground)]">Your workspaces</p>
      <div className="max-h-72 overflow-auto">{sections.all.map((w) => item(w, w.id))}</div>
      {!listed && !error && <p className="px-2 py-1.5 text-[var(--muted-foreground)]">Loading…</p>}
      {error && (
        <p role="alert" className="px-2 py-1.5 text-red-500">
          {error}
        </p>
      )}
      {archived.length > 0 && (
        <>
          <div className="my-1 border-t border-[var(--border)]" />
          <p className="px-2 pb-1 pt-1.5 text-[11px] font-medium text-[var(--muted-foreground)]">Archived workspaces</p>
          <ul aria-label="Archived workspaces" className="max-h-40 overflow-auto">
            {archived.map((w) => (
              <li key={w.id} className="flex items-center gap-2 px-2 py-1 text-[var(--muted-foreground)]">
                <span className="min-w-0 flex-1 truncate">{w.name}</span>
                <button
                  type="button"
                  role="menuitem"
                  aria-label={`Restore ${w.name}`}
                  disabled={restoring !== null}
                  onClick={() => void restore(w)}
                  className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[var(--foreground)] hover:bg-[var(--secondary)] cursor-pointer disabled:cursor-wait disabled:opacity-50"
                >
                  <ArchiveRestore className="size-3" /> {restoring === w.id ? "Restoring…" : "Restore"}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      {(onSettings || onLeave || canCreate || deploymentAdmin) && <div className="my-1 border-t border-[var(--border)]" />}
      {onSettings && (
        <button type="button" role="menuitem" onClick={onSettings} className={action}>
          <Settings className="size-3.5" /> Workspace settings
        </button>
      )}
      {onLeave && (
        <button type="button" role="menuitem" onClick={onLeave} className={action}>
          <LogOut className="size-3.5" /> Leave workspace
        </button>
      )}
      {canCreate && (
        <button type="button" role="menuitem" onClick={onCreate} className={action}>
          <Plus className="size-3.5" /> Create workspace
        </button>
      )}
      {deploymentAdmin && (
        <button type="button" role="menuitem" onClick={onInventory} className={action}>
          <LayoutList className="size-3.5" /> Workspace inventory
        </button>
      )}
    </div>
  );
}

let adminOnce: Promise<boolean> | null = null;

/**
 * Whether the server names this user a deployment admin (PLATFORM_ADMINS),
 * asked once per page by trying the inventory: anyone else gets a 403.
 */
function useDeploymentAdmin(): boolean {
  const [admin, setAdmin] = useState(false);
  useEffect(() => {
    let live = true;
    adminOnce ??= fetch("/api/platform/workspaces", { cache: "no-store" }).then(
      (res) => res.ok,
      () => {
        adminOnce = null;
        return false;
      },
    );
    void adminOnce.then((yes) => live && setAdmin(yes));
    return () => {
      live = false;
    };
  }, []);
  return admin;
}

/**
 * Leaving this workspace for another page: right away when every edit has
 * saved, otherwise after asking to save, discard or stay (docs/workspaces.md,
 * "Switching with unsaved edits"). The page loads anew there, so nothing of
 * this workspace's carries over.
 */
export function useLeave(go: (href: string) => void = (href) => window.location.assign(href)) {
  const { edits } = useWorkspace();
  const [target, setTarget] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const leave = useCallback(
    (href: string) => {
      if (edits.unsaved()) {
        setError(null);
        setTarget(href);
      } else go(href);
    },
    [edits, go],
  );

  const close = () => !saving && setTarget(null);
  const save = async () => {
    if (!target) return;
    setSaving(true);
    setError(null);
    try {
      await edits.save();
      go(target);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSaving(false);
    }
  };
  const discard = () => {
    if (!target) return;
    edits.discard();
    go(target);
  };

  const prompt = target && (
    <Dialog label="Unsaved edits" onClose={close}>
      <p className="mb-4 text-sm text-[var(--muted-foreground)]">
        Some of your edits here haven&apos;t saved yet. Save them before you switch workspace?
      </p>
      {error && (
        <p role="alert" className="mb-3 text-xs text-red-500">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={close} disabled={saving}>
          Stay
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={discard} disabled={saving}>
          Discard
        </Button>
        <Button type="button" size="sm" onClick={() => void save()} disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>
    </Dialog>
  );

  return { leave, prompt };
}
