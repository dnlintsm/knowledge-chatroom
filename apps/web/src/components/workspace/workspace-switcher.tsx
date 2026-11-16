"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { MEMBER_ROLE_LABEL, readRecent, switcherSections, workspacePath } from "@/lib/workspace-choice";
import { isAborted, workspaceFetch, type WorkspaceInfo } from "@/lib/workspace-request";
import { CreateWorkspaceDialog, Dialog } from "./create-workspace";
import { useCurrentWorkspace } from "./current-workspace";
import { savedStateScope } from "./local-persistence";
import { useWorkspace } from "./store";

/**
 * The workspace switcher, at the root of the breadcrumb (issue #226,
 * docs/workspaces.md, "Screens"): the workspace's name, which goes to its
 * root as the fixed word "Workspace" did, and a menu of the user's
 * workspaces, recent ones first, with Create. Shown whenever the server has
 * workspaces, also with only one, so Create is always there.
 */
export function WorkspaceSwitcher({ onRoot, current }: { onRoot: () => void; current: boolean }) {
  const workspace = useCurrentWorkspace();
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
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
      {prompt}
    </span>
  );
}

function SwitcherMenu({
  current,
  onPick,
  onCreate,
  onClose,
}: {
  current: WorkspaceInfo;
  onPick: (workspace: WorkspaceInfo) => void;
  onCreate: () => void;
  onClose: () => void;
}) {
  const [listed, setListed] = useState<WorkspaceInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const menu = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    workspaceFetch("/api/workspaces", { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`Couldn't list your workspaces (${res.status})`);
        const body = (await res.json()) as { workspaces?: WorkspaceInfo[] };
        setListed(body.workspaces ?? []);
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
      <div className="my-1 border-t border-[var(--border)]" />
      <button
        type="button"
        role="menuitem"
        onClick={onCreate}
        className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[var(--foreground)] hover:bg-[var(--secondary)] cursor-pointer"
      >
        <Plus className="size-3.5" /> Create workspace
      </button>
    </div>
  );
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
