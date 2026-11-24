"use client";

import { useId, useState } from "react";
import { UserPlus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MEMBER_ROLE_LABEL } from "@/lib/workspace-choice";
import type { WorkspaceInfo } from "@/lib/workspace-request";
import { apiFetch } from "./server-files";

/** The access a new member starts with on the whole workspace (its root). */
const STARTING_ACCESS = [
  { value: "none", label: "No access" },
  { value: "viewer", label: "Can view" },
  { value: "editor", label: "Can edit" },
] as const;
type StartingAccess = (typeof STARTING_ACCESS)[number]["value"];

/** A request to the workspaces API (services/api-py/api_py/workspaces.py), with its answer. */
export async function workspacesApi<T>(path: string, init?: RequestInit): Promise<{ status: number; body: T & { error?: string } }> {
  const res = await apiFetch(`/api/workspaces${path}`, {
    ...init,
    headers: init?.body ? { "Content-Type": "application/json" } : undefined,
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as T & { error?: string } };
}

/**
 * Adding someone to the workspace (docs/workspaces.md, "Adding a
 * member"), for its Owners and Admins: found by the exact email they signed
 * in with, as a Member or an Admin, with a starting access to everything in
 * the workspace. Someone already a member keeps their role and access.
 */
export function AddMember({ workspace, onAdded }: { workspace: WorkspaceInfo; onAdded: () => Promise<void> | void }) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"member" | "admin">("member");
  const [startAccess, setStartAccess] = useState<StartingAccess>("viewer");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const ids = useId();
  const base = `/${encodeURIComponent(workspace.id)}`;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const address = email.trim();
    if (!address) return;
    setBusy(true);
    setNotice(null);
    try {
      const found = await workspacesApi<{ user?: { id: string; name: string | null } }>(
        `${base}/lookup?email=${encodeURIComponent(address)}`,
      );
      const person = found.body.user;
      if (found.status !== 200 || !person) {
        setNotice({ ok: false, text: found.body.error ?? `Couldn't look up that email (${found.status}).` });
        return;
      }
      const who = person.name ?? address;
      const added = await workspacesApi<{ role?: WorkspaceInfo["role"] }>(`${base}/members`, {
        method: "POST",
        body: JSON.stringify({ userId: person.id, role, access: startAccess }),
      });
      if (added.status === 409) {
        const current = added.body.role ? MEMBER_ROLE_LABEL[added.body.role] : "a member";
        setNotice({ ok: false, text: `${who} is already in this workspace, as ${current}. Nothing changed.` });
        return;
      }
      if (added.status !== 201) {
        setNotice({ ok: false, text: added.body.error ?? `Couldn't add ${who} (${added.status}).` });
        return;
      }
      setEmail("");
      setNotice({ ok: true, text: `Added ${who} as ${MEMBER_ROLE_LABEL[role]}.` });
      await onAdded();
    } catch (err) {
      setNotice({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  const select = "h-8 rounded border border-[var(--border)] bg-[var(--background)] px-1.5 text-sm";
  return (
    <form
      onSubmit={submit}
      aria-label="Add a member"
      className="mb-4 rounded-md border border-[var(--border)] p-3"
    >
      <h3 className="mb-2 flex items-center gap-1.5 text-xs font-medium">
        <UserPlus className="size-3.5" /> Add a member
      </h3>
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={`${ids}-email`} className="sr-only">
          Email
        </label>
        <Input
          id={`${ids}-email`}
          type="email"
          required
          value={email}
          placeholder="Their email, exactly"
          onChange={(e) => setEmail(e.target.value)}
          className="h-8 min-w-48 flex-1"
        />
        <select aria-label="Role" value={role} onChange={(e) => setRole(e.target.value as "member" | "admin")} className={select}>
          <option value="member">Member</option>
          <option value="admin">Admin</option>
        </select>
        <select
          aria-label="Starting access"
          value={startAccess}
          onChange={(e) => setStartAccess(e.target.value as StartingAccess)}
          className={select}
        >
          {STARTING_ACCESS.map((a) => (
            <option key={a.value} value={a.value}>
              {a.label}
            </option>
          ))}
        </select>
        <Button type="submit" size="sm" disabled={busy || !email.trim()}>
          {busy ? "Adding…" : "Add"}
        </Button>
      </div>
      <p className="mt-1.5 text-xs text-[var(--muted-foreground)]">
        They need to have signed in once. Admins can add people too. The access covers everything in the workspace;
        Share gives access to single places.
      </p>
      {notice && (
        <p role={notice.ok ? "status" : "alert"} className={notice.ok ? "mt-1.5 text-xs text-green-600" : "mt-1.5 text-xs text-red-500"}>
          {notice.text}
        </p>
      )}
    </form>
  );
}
