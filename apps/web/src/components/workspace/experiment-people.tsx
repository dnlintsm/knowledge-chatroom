"use client";

import { useEffect, useId, useState } from "react";
import { UserPlus, Users, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { experimentPeople, type MemberRole } from "@/lib/workspace-admin";
import { workspacesApi } from "./add-member";
import { Dialog } from "./create-workspace";
import { useCurrentWorkspace } from "./current-workspace";
import type { Experiment } from "./server-files";
import { access } from "./sharing";
import { useWorkspace } from "./store";

/**
 * Who works on an experiment, in its header (issue #255, docs/workspaces.md,
 * "Experiment handover"): "Maintained by Alice · started by Bob" when they
 * differ, and its collaborators. Its maintainer adds and removes
 * collaborators and hands it over; an Owner or Admin hands over a shared or
 * archived one whose maintainer is no longer a member; a collaborator can
 * stop collaborating. The server checks each change again, and says why
 * when someone can't view the experiment's node.
 */
export function ExperimentPeople({ experiment: exp, nodeName }: { experiment: Experiment; nodeName: string }) {
  const ws = useWorkspace();
  const workspace = useCurrentWorkspace();
  const me = useMyId();
  const [dialog, setDialog] = useState<"add" | "handOver" | "leave" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const may = experimentPeople(exp, { id: me, role: workspace?.role ?? null });
  // Picking someone needs the workspace's members.
  const picks = workspace !== null;

  const removeCollaborator = async (id: string) => {
    try {
      await ws.changeExperimentPeople(exp.id, { remove: id });
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const maintainer = exp.mine ? "you" : (exp.maintainerName ?? "someone");
  return (
    <div data-testid="experiment-people" className="flex flex-col gap-1 text-xs text-[var(--muted-foreground)]">
      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
        <Users className="size-3.5" />
        <span>
          Maintained by <span className="font-medium text-[var(--foreground)]">{maintainer}</span>
        </span>
        {!exp.maintainerIsMember && (
          <span className="rounded bg-amber-100 px-1 text-amber-900 dark:bg-amber-950 dark:text-amber-200">
            No longer a member
          </span>
        )}
        {exp.authorId !== exp.maintainerId && <span>· started by {exp.authorName ?? "someone"}</span>}
        {exp.collaborators.length > 0 && (
          <>
            <span>· with</span>
            <ul aria-label="Collaborators" className="flex flex-wrap items-center gap-1">
              {exp.collaborators.map((c) => {
                const name = c.id === me ? "you" : (c.name ?? "someone");
                return (
                  <li
                    key={c.id}
                    className="flex items-center gap-0.5 rounded-full border border-[var(--border)] px-1.5 text-[var(--foreground)]"
                  >
                    {name}
                    {may.collaborators && (
                      <button
                        type="button"
                        aria-label={`Remove ${c.name ?? "them"} as a collaborator`}
                        onClick={() => void removeCollaborator(c.id)}
                        className="flex size-3.5 items-center justify-center rounded-full hover:bg-[var(--secondary)] cursor-pointer"
                      >
                        <X className="size-3" />
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          </>
        )}
        {may.collaborators && picks && (
          <LinkButton onClick={() => setDialog("add")}>
            <UserPlus className="size-3" /> Add collaborator
          </LinkButton>
        )}
        {may.handOver && picks && <LinkButton onClick={() => setDialog("handOver")}>Hand over</LinkButton>}
        {may.leave && <LinkButton onClick={() => setDialog("leave")}>Stop collaborating</LinkButton>}
      </div>
      {error && (
        <p role="alert" className="text-red-500">
          {error}
        </p>
      )}
      {dialog === "add" && workspace && (
        <AddCollaboratorDialog
          experiment={exp}
          workspaceId={workspace.id}
          nodeName={nodeName}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === "handOver" && workspace && (
        <HandOverDialog
          experiment={exp}
          workspaceId={workspace.id}
          nodeName={nodeName}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === "leave" && me && <LeaveDialog experiment={exp} me={me} onClose={() => setDialog(null)} />}
    </div>
  );
}

function LinkButton({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-0.5 text-[var(--primary)] underline-offset-2 hover:underline cursor-pointer"
    >
      {children}
    </button>
  );
}

let myIdOnce: Promise<string | null> | null = null;

/** The signed-in user's id (the same in every workspace), asked for once. */
function useMyId(): string | null {
  const [id, setId] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    myIdOnce ??= access<{ me: { id: string } | null }>("").then(
      (r) => r.me?.id ?? null,
      () => {
        myIdOnce = null;
        return null;
      },
    );
    void myIdOnce.then((found) => live && setId(found));
    return () => {
      live = false;
    };
  }, []);
  return id;
}

interface Member {
  id: string;
  name: string | null;
  role: MemberRole;
}

/** The workspace's members, but for those `leaveOut` names; null while loading. */
function useMembers(workspaceId: string, leaveOut: string[]) {
  const [members, setMembers] = useState<Member[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    workspacesApi<{ members?: Member[] }>(`/${encodeURIComponent(workspaceId)}/members`)
      .then(({ status, body }) => {
        if (!live) return;
        if (status !== 200) setError(body.error ?? `Couldn't list the members (${status}).`);
        else setMembers(body.members ?? []);
      })
      .catch((err) => live && setError(err instanceof Error ? err.message : String(err)));
    return () => {
      live = false;
    };
  }, [workspaceId]);
  return { members: members?.filter((m) => !leaveOut.includes(m.id)) ?? null, error };
}

const memberLabel = (m: Member) => m.name ?? "Unnamed member";

function MemberSelect({
  id,
  members,
  value,
  onChange,
}: {
  id: string;
  members: Member[];
  value: string;
  onChange: (id: string) => void;
}) {
  return (
    <select
      id={id}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="h-8 w-full rounded-md border border-[var(--border)] bg-transparent px-2 text-sm cursor-pointer"
    >
      <option value="" disabled>
        Pick a member
      </option>
      {members.map((m) => (
        <option key={m.id} value={m.id}>
          {memberLabel(m)}
        </option>
      ))}
    </select>
  );
}

/** Shared by the dialogs: a request that may fail with the server's reason. */
function useSubmit(run: () => Promise<unknown>, onDone: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await run();
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };
  return { busy, error, submit };
}

function AddCollaboratorDialog({
  experiment: exp,
  workspaceId,
  nodeName,
  onClose,
}: {
  experiment: Experiment;
  workspaceId: string;
  nodeName: string;
  onClose: () => void;
}) {
  const ws = useWorkspace();
  const { members, error: listError } = useMembers(workspaceId, [
    exp.maintainerId,
    ...exp.collaborators.map((c) => c.id),
  ]);
  const [pick, setPick] = useState("");
  const ids = useId();
  const { busy, error, submit } = useSubmit(() => ws.changeExperimentPeople(exp.id, { add: pick }), onClose);
  return (
    <Dialog label="Add a collaborator" onClose={() => !busy && onClose()}>
      <form onSubmit={submit} className="text-sm">
        <p className="mb-3 text-[var(--muted-foreground)]">
          Collaborators edit it with you{exp.status === "draft" ? " and see it while it's a draft" : ""}. They
          don&apos;t share, archive or delete it, or choose who works on it. They need Can view on {nodeName}.
        </p>
        {members === null && !listError && <p className="mb-3 text-[var(--muted-foreground)]">Loading the members…</p>}
        {members?.length === 0 && (
          <p className="mb-3 text-[var(--muted-foreground)]">Everyone in the workspace already works on it.</p>
        )}
        {members && members.length > 0 && (
          <div className="mb-3">
            <label htmlFor={`${ids}-who`} className="mb-1 block text-xs font-medium">
              Collaborator
            </label>
            <MemberSelect id={`${ids}-who`} members={members} value={pick} onChange={setPick} />
          </div>
        )}
        {(error ?? listError) && (
          <p role="alert" className="mb-3 text-xs text-red-500">
            {error ?? listError}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={busy || !pick}>
            {busy ? "Adding…" : "Add"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function HandOverDialog({
  experiment: exp,
  workspaceId,
  nodeName,
  onClose,
}: {
  experiment: Experiment;
  workspaceId: string;
  nodeName: string;
  onClose: () => void;
}) {
  const ws = useWorkspace();
  const { members, error: listError } = useMembers(workspaceId, [exp.maintainerId]);
  const [pick, setPick] = useState("");
  // Only a maintainer who is still a member can stay on (the server enforces it too).
  const [keep, setKeep] = useState(true);
  const ids = useId();
  const { busy, error, submit } = useSubmit(
    () => ws.changeExperimentPeople(exp.id, { handOver: pick, keepAsCollaborator: exp.mine && keep }),
    onClose,
  );
  const previous = exp.mine ? "you" : (exp.maintainerName ?? "its maintainer");
  return (
    <Dialog label="Hand over the experiment" onClose={() => !busy && onClose()}>
      <form onSubmit={submit} className="text-sm">
        <p className="mb-3 text-[var(--muted-foreground)]">
          The new maintainer is responsible for it instead of {previous}: they share, archive, restore or delete it and
          choose who works on it. They need Can view on {nodeName}.
          {exp.authorName ? ` It still says ${exp.authorName} started it.` : ""}
        </p>
        {members === null && !listError && <p className="mb-3 text-[var(--muted-foreground)]">Loading the members…</p>}
        {members?.length === 0 && (
          <p className="mb-3 text-[var(--muted-foreground)]">There&apos;s nobody else in the workspace yet.</p>
        )}
        {members && members.length > 0 && (
          <div className="mb-3">
            <label htmlFor={`${ids}-who`} className="mb-1 block text-xs font-medium">
              New maintainer
            </label>
            <MemberSelect id={`${ids}-who`} members={members} value={pick} onChange={setPick} />
          </div>
        )}
        {exp.mine && (
          <label className="mb-1 flex items-center gap-2">
            <input type="checkbox" checked={keep} onChange={(e) => setKeep(e.target.checked)} />
            Stay on as a collaborator
          </label>
        )}
        {exp.mine && !keep && exp.status === "draft" && (
          <p className="mb-1 text-xs text-[var(--muted-foreground)]">
            It&apos;s a draft, so you won&apos;t see it any more.
          </p>
        )}
        {(error ?? listError) && (
          <p role="alert" className="mt-2 text-xs text-red-500">
            {error ?? listError}
          </p>
        )}
        <div className="mt-3 flex justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={busy || !pick}>
            {busy ? "Handing over…" : "Hand over"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function LeaveDialog({ experiment: exp, me, onClose }: { experiment: Experiment; me: string; onClose: () => void }) {
  const ws = useWorkspace();
  const { busy, error, submit } = useSubmit(() => ws.changeExperimentPeople(exp.id, { remove: me }), onClose);
  const maintainer = exp.maintainerName ?? "its maintainer";
  return (
    <Dialog label="Stop collaborating?" onClose={() => !busy && onClose()}>
      <div className="text-sm">
        <p className="mb-4 text-[var(--muted-foreground)]">
          You stop editing {exp.title}
          {exp.status === "draft" ? ", and as it's a draft you won't see it any more" : ""}. Only {maintainer} can add
          you again.
        </p>
        {error && (
          <p role="alert" className="mb-3 text-xs text-red-500">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="button" variant="destructive" size="sm" onClick={() => void submit()} disabled={busy}>
            {busy ? "Leaving…" : "Stop collaborating"}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
