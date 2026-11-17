"use client";

import { useEffect, useId, useState } from "react";
import { UserMinus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { MEMBER_ROLE_LABEL } from "@/lib/workspace-choice";
import { assignableRoles, canRemove, transferSteps, type MemberRole } from "@/lib/workspace-admin";
import type { WorkspaceInfo } from "@/lib/workspace-request";
import { workspacesApi } from "./add-member";
import { Dialog } from "./create-workspace";
import { apiFetch } from "./server-files";
import { useWorkspace } from "./store";

/**
 * A member's workspace role and removal, in the Admin panel's People tab
 * (issue #255, docs/workspaces.md, "Screens"): a menu with only the roles the
 * viewer may set, "Make Owner" asking how to hand over, and Remove confirming
 * from the server's preview of what goes.
 */

export interface MemberTarget {
  id: string;
  label: string;
  role: MemberRole;
  /** Whether they already hold Full access on the whole workspace (directly or through a group). */
  fullAccess: boolean;
}

/**
 * The dialogs these open sit inside the Admin panel's table: Escape closes
 * only them, and they don't take the cell's alignment.
 */
function Nested({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-left font-normal" onKeyDown={(e) => e.key === "Escape" && e.stopPropagation()}>
      {children}
    </div>
  );
}

/** A request to the workspace's member routes; throws the server's reason. */
async function send(path: string, method: string, body?: Record<string, unknown>): Promise<void> {
  const res = await apiFetch(path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const answer = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(answer.error ?? `${method} ${path}: ${res.status}`);
  }
}

const memberPath = (workspace: WorkspaceInfo, id: string) =>
  `/api/workspaces/${encodeURIComponent(workspace.id)}/members/${encodeURIComponent(id)}`;

/**
 * The role menu, or just the role when the viewer may not change it. Changes
 * to your own role reload the page, whose screens follow your role.
 */
export function MemberRoleMenu({
  workspace,
  viewer,
  me,
  target,
  onChanged,
  onError,
}: {
  workspace: WorkspaceInfo;
  viewer: MemberRole;
  me: string;
  target: MemberTarget;
  onChanged: () => Promise<void> | void;
  onError: (message: string | null) => void;
}) {
  const self = target.id === me;
  const roles = assignableRoles(viewer, target.role, self);
  const [stepDown, setStepDown] = useState<MemberRole | null>(null);
  const [transfer, setTransfer] = useState(false);
  if (roles.length === 0) return <span className="text-sm">{MEMBER_ROLE_LABEL[target.role]}</span>;

  const change = async (role: MemberRole) => {
    try {
      await send(memberPath(workspace, target.id), "PATCH", { role });
      onError(null);
      if (self) window.location.reload();
      else await onChanged();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <>
      <select
        aria-label={`Role of ${target.label}`}
        value={target.role}
        onChange={(e) => {
          const role = e.target.value as MemberRole;
          if (role === target.role) return;
          if (role === "owner" && !self) setTransfer(true);
          else if (self) setStepDown(role);
          else void change(role);
        }}
        className="h-8 rounded border border-[var(--border)] bg-[var(--background)] px-1.5 text-sm"
      >
        {roles.map((r) => (
          <option key={r} value={r}>
            {MEMBER_ROLE_LABEL[r]}
          </option>
        ))}
      </select>
      {stepDown && (
        <Nested>
          <Dialog label={`Become ${MEMBER_ROLE_LABEL[stepDown]}?`} onClose={() => setStepDown(null)}>
            <p className="mb-4 text-sm text-[var(--muted-foreground)]">
              {stepDown === "member"
                ? "You won't manage people or the workspace any more, and this panel closes. Your access to its content stays as it is."
                : "You won't change Owners' roles or archive the workspace any more. Your access to its content stays as it is."}
            </p>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={() => setStepDown(null)}>
                Cancel
              </Button>
              <Button
                type="button"
                size="sm"
                onClick={() => {
                  const role = stepDown;
                  setStepDown(null);
                  void change(role);
                }}
              >
                Become {MEMBER_ROLE_LABEL[stepDown]}
              </Button>
            </div>
          </Dialog>
        </Nested>
      )}
      {transfer && (
        <TransferDialog
          workspace={workspace}
          me={me}
          target={target}
          onClose={() => setTransfer(false)}
          onDone={async (keptOwner) => {
            setTransfer(false);
            onError(null);
            if (keptOwner) await onChanged();
            else window.location.reload();
          }}
        />
      )}
    </>
  );
}

/**
 * "Make Owner" on someone else: whether you stay an Owner, become an Admin or
 * a Member, and whether they get Full access on the root if they lack it.
 * The requests go in transferSteps' order, so the workspace always has an Owner.
 */
function TransferDialog({
  workspace,
  me,
  target,
  onClose,
  onDone,
}: {
  workspace: WorkspaceInfo;
  me: string;
  target: MemberTarget;
  onClose: () => void;
  onDone: (keptOwner: boolean) => Promise<void> | void;
}) {
  const [myRole, setMyRole] = useState<MemberRole>("owner");
  const [fullAccess, setFullAccess] = useState(!target.fullAccess);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ids = useId();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      for (const step of transferSteps(workspace.id, me, target.id, {
        fullAccess: fullAccess && !target.fullAccess,
        myRole,
      })) {
        await send(step.path, step.method, step.body);
      }
      await onDone(myRole === "owner");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  const choices: { role: MemberRole; label: string }[] = [
    { role: "owner", label: "Stay an Owner too" },
    { role: "admin", label: "Become an Admin" },
    { role: "member", label: "Become a Member" },
  ];
  return (
    <Nested>
      <Dialog label={`Make ${target.label} an Owner`} onClose={() => !busy && onClose()}>
        <form onSubmit={submit} className="text-sm">
          <p className="mb-3 text-[var(--muted-foreground)]">
            Owners manage people, roles and the workspace itself. There can be several, and any of them can change
            another&apos;s role.
          </p>
          <fieldset className="mb-3">
            <legend className="mb-1 text-xs font-medium">And you?</legend>
            {choices.map((c) => (
              <label key={c.role} className="flex items-center gap-2 py-0.5">
                <input
                  type="radio"
                  name={`${ids}-me`}
                  value={c.role}
                  checked={myRole === c.role}
                  onChange={() => setMyRole(c.role)}
                />
                {c.label}
              </label>
            ))}
          </fieldset>
          {!target.fullAccess && (
            <label className="mb-3 flex items-start gap-2">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={fullAccess}
                onChange={(e) => setFullAccess(e.target.checked)}
              />
              <span>
                Give them Full access to everything in the workspace
                <span className="block text-xs text-[var(--muted-foreground)]">
                  Owners need it to share content; without it they manage people but not what is shared.
                </span>
              </span>
            </label>
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
            <Button type="submit" size="sm" disabled={busy}>
              {busy ? "Saving…" : "Make Owner"}
            </Button>
          </div>
        </form>
      </Dialog>
    </Nested>
  );
}

interface Removal {
  grants: number;
  collaborations: number;
  groups: { id: string; name: string }[];
  experiments: { id: string; title: string; nodeId: string | null }[];
}

/** Remove, for the members the viewer may remove; confirms from the server's preview. */
export function RemoveMember({
  workspace,
  viewer,
  me,
  target,
  onRemoved,
  onOpened,
}: {
  workspace: WorkspaceInfo;
  viewer: MemberRole;
  me: string;
  target: MemberTarget;
  onRemoved: () => Promise<void> | void;
  /** After opening one of the Experiments they maintain: closes the Admin panel, so it shows. */
  onOpened: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ws = useWorkspace();
  if (!canRemove(viewer, target.role, target.id === me)) return null;
  return (
    <>
      <button
        type="button"
        aria-label={`Remove ${target.label}`}
        title={`Remove ${target.label} from the workspace`}
        onClick={() => setOpen(true)}
        className="flex size-6 items-center justify-center rounded text-[var(--muted-foreground)] hover:bg-[var(--secondary)] hover:text-[var(--destructive)] cursor-pointer"
      >
        <UserMinus className="size-3.5" />
      </button>
      {open && (
        <RemoveDialog
          workspace={workspace}
          target={target}
          onClose={() => setOpen(false)}
          onOpened={() => {
            setOpen(false);
            onOpened();
          }}
          onRemoved={async () => {
            setOpen(false);
            // The Experiments they maintained now say they're no longer a member.
            await Promise.all([onRemoved(), ws.refresh().catch(() => undefined)]);
          }}
        />
      )}
    </>
  );
}

function RemoveDialog({
  workspace,
  target,
  onClose,
  onOpened,
  onRemoved,
}: {
  workspace: WorkspaceInfo;
  target: MemberTarget;
  onClose: () => void;
  onOpened: () => void;
  onRemoved: () => Promise<void>;
}) {
  const { enterExperiment } = useWorkspace();
  const [preview, setPreview] = useState<Removal | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const base = `/${encodeURIComponent(workspace.id)}/members/${encodeURIComponent(target.id)}`;

  useEffect(() => {
    let live = true;
    workspacesApi<Removal>(`${base}/removal`)
      .then(({ status, body }) => {
        if (!live) return;
        if (status === 200) setPreview(body);
        else setError(body.error ?? `Couldn't see what would go (${status}).`);
      })
      .catch((err) => live && setError(err instanceof Error ? err.message : String(err)));
    return () => {
      live = false;
    };
  }, [base]);

  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      const { status, body } = await workspacesApi(base, { method: "DELETE" });
      if (status !== 200) throw new Error(body.error ?? `Couldn't remove ${target.label} (${status}).`);
      await onRemoved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  return (
    <Nested>
      <Dialog label={`Remove ${target.label}?`} onClose={() => !busy && onClose()}>
        <div className="text-sm">
          <p className="mb-2 text-[var(--muted-foreground)]">
            They lose access to this workspace at once, and a chat of theirs running here stops at its next step.
          </p>
          {!preview && !error && <p className="mb-3 text-[var(--muted-foreground)]">Checking what would go…</p>}
          {preview && (
            <div aria-label="What goes" className="mb-3">
              <p className="mb-1 font-medium">What goes</p>
              <ul className="mb-2 list-disc pl-5">
                <li>{count(preview.grants, "direct access they were given", "direct accesses they were given")}</li>
                <li>
                  {preview.groups.length === 0
                    ? "No groups"
                    : `Their place in ${preview.groups.map((g) => g.name).join(", ")}`}
                </li>
                {preview.collaborations > 0 && (
                  <li>
                    {count(preview.collaborations, "Experiment they collaborate on", "Experiments they collaborate on")}
                  </li>
                )}
              </ul>
              <p className="mb-1 font-medium">What stays</p>
              <p className="text-[var(--muted-foreground)]">
                Their files, proposals and Experiments stay. Their drafts, chats and memory stay private, and come back
                if they are added again; what was given to them doesn&apos;t.
              </p>
              {preview.experiments.length > 0 && (
                <>
                  <p className="mt-2 mb-1">They maintain these, which you can hand over to someone else:</p>
                  <ul aria-label="Experiments they maintain" className="pl-1">
                    {preview.experiments.map((x) => (
                      <li key={x.id}>
                        <button
                          type="button"
                          onClick={() => {
                            void enterExperiment(x.id);
                            onOpened();
                          }}
                          className="text-left text-[var(--primary)] underline underline-offset-2 cursor-pointer"
                        >
                          {x.title}
                        </button>
                      </li>
                    ))}
                  </ul>
                </>
              )}
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
            <Button
              type="button"
              variant="destructive"
              size="sm"
              onClick={() => void remove()}
              disabled={busy || !preview}
            >
              {busy ? "Removing…" : "Remove"}
            </Button>
          </div>
        </div>
      </Dialog>
    </Nested>
  );
}
