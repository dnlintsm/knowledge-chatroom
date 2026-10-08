"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { LogOut, Share2, User, Users, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { apiFetch, type NodeId, type Role } from "./server-files";
import { useWorkspace } from "./store";

/**
 * Who you are (with login on) and who a place is shared with. Sharing lists
 * the grants made on the current place; access granted higher up the tree
 * also reaches it, so that is said rather than repeated.
 */

interface Person {
  id: string;
  name: string | null;
  email: string | null;
  subject: string;
}

interface Group {
  id: string;
  parentId: string | null;
  name: string;
}

interface Grant {
  id: string;
  nodeId: string | null;
  principalType: "user" | "group";
  principalId: string;
  role: Role;
}

const ROLES: { role: Role; label: string }[] = [
  { role: "viewer", label: "Can view" },
  { role: "editor", label: "Can edit" },
  { role: "owner", label: "Owner" },
];

async function access<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await apiFetch(`/api/access${path}`, {
    ...init,
    headers: init?.body ? { "Content-Type": "application/json" } : undefined,
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `${init?.method ?? "GET"} ${path}: ${res.status}`);
  return data;
}

const personLabel = (p: Person) => p.name ?? p.email ?? p.subject;

/** The signed-in user, and signing out. Shown only with login on. */
export function AccountMenu() {
  const { account } = useWorkspace();
  const [open, setOpen] = useState(false);
  if (!account.login || !account.user) return null;
  const { name, email } = account.user;
  return (
    <div className="relative">
      <button
        type="button"
        aria-label="Account"
        aria-expanded={open}
        title={email ?? name ?? "Account"}
        onClick={() => setOpen((o) => !o)}
        className="flex h-7 items-center gap-1.5 rounded px-1.5 text-xs text-[var(--muted-foreground)] hover:bg-[var(--secondary)] hover:text-[var(--foreground)] cursor-pointer"
      >
        <span className="flex size-5 items-center justify-center rounded-full bg-[var(--accent)] text-[10px] font-semibold uppercase text-[var(--accent-foreground)]">
          {(name ?? email ?? "?").slice(0, 1)}
        </span>
        <span className="max-w-[140px] truncate max-md:hidden">{name ?? email}</span>
      </button>
      {open && (
        <div className="absolute right-0 top-8 z-50 w-56 rounded-md border border-[var(--border)] bg-[var(--background)] p-2 text-xs shadow-lg">
          <p className="truncate font-medium text-[var(--foreground)]">{name ?? email}</p>
          {email && name && <p className="truncate text-[var(--muted-foreground)]">{email}</p>}
          <form method="post" action="/api/auth/logout" className="mt-2 border-t border-[var(--border)] pt-2">
            <button
              type="submit"
              className="flex w-full items-center gap-1.5 rounded px-1.5 py-1 hover:bg-[var(--secondary)] cursor-pointer"
            >
              <LogOut className="size-3.5" /> Sign out
            </button>
          </form>
        </div>
      )}
    </div>
  );
}

/** Opens sharing for the current place; only owners there see it. */
export function ShareButton() {
  const { account, placeRole, storageMode, node, lineage } = useWorkspace();
  const [open, setOpen] = useState(false);
  if (!account.login || storageMode !== "server" || placeRole !== "owner") return null;
  const name = lineage[lineage.length - 1]?.name ?? "Workspace";
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex h-7 items-center gap-1 rounded px-2 text-xs text-[var(--muted-foreground)] hover:bg-[var(--secondary)] hover:text-[var(--foreground)] cursor-pointer"
      >
        <Share2 className="size-3.5" /> Share
      </button>
      {open && <ShareDialog node={node} name={name} onClose={() => setOpen(false)} />}
    </>
  );
}

function ShareDialog({ node, name, onClose }: { node: NodeId; name: string; onClose: () => void }) {
  const [people, setPeople] = useState<Person[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [grants, setGrants] = useState<Grant[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pick, setPick] = useState("");
  const [role, setRole] = useState<Role>("viewer");
  const dialog = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    const query = node ? `?node=${encodeURIComponent(node)}` : "";
    const [u, g, gr] = await Promise.all([
      access<{ users: Person[] }>("/users"),
      access<{ groups: Group[] }>("/groups"),
      access<{ grants: Grant[] }>(`/grants${query}`),
    ]);
    setPeople(u.users);
    setGroups(g.groups);
    setGrants(gr.grants);
  }, [node]);

  useEffect(() => {
    load().catch((err) => setError(err instanceof Error ? err.message : String(err)));
    dialog.current?.focus();
  }, [load]);

  const run = async (action: () => Promise<unknown>) => {
    try {
      await action();
      setError(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  const grant = (principalType: Grant["principalType"], principalId: string, r: Role) =>
    run(() =>
      access("/grants", {
        method: "POST",
        body: JSON.stringify({ node, principalType, principalId, role: r }),
      }),
    );

  const nameOf = (g: Grant) => {
    if (g.principalType === "group") return groups.find((x) => x.id === g.principalId)?.name ?? "Unknown group";
    const person = people.find((p) => p.id === g.principalId);
    return person ? personLabel(person) : "Unknown user";
  };
  const granted = new Set(grants?.map((g) => `${g.principalType}:${g.principalId}`));
  const choices = [
    ...people.map((p) => ({ value: `user:${p.id}`, label: personLabel(p) })),
    ...groups.map((g) => ({ value: `group:${g.id}`, label: `${g.name} (group)` })),
  ].filter((c) => !granted.has(c.value));

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 p-4 pt-[12vh]"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-label={`Share ${name}`}
        tabIndex={-1}
        onKeyDown={(e) => e.key === "Escape" && onClose()}
        className="w-full max-w-md rounded-lg border border-[var(--border)] bg-[var(--background)] p-4 text-sm shadow-xl outline-none"
      >
        <header className="mb-1 flex items-center justify-between">
          <h2 className="truncate font-semibold">Share {name}</h2>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="flex size-6 items-center justify-center rounded text-[var(--muted-foreground)] hover:bg-[var(--secondary)] cursor-pointer"
          >
            <X className="size-4" />
          </button>
        </header>
        <p className="mb-3 text-xs text-[var(--muted-foreground)]">
          {node
            ? "Access applies to everything below this too. People with access higher up keep it here."
            : "Access to the workspace applies to everything in it."}{" "}
          People appear here once they have signed in.
        </p>

        <ul aria-label="People with access" className="mb-3 divide-y divide-[var(--border)]">
          {grants === null && !error && <li className="py-2 text-[var(--muted-foreground)]">Loading…</li>}
          {grants?.length === 0 && (
            <li className="py-2 text-[var(--muted-foreground)]">Not shared here yet.</li>
          )}
          {grants?.map((g) => {
            const Icon = g.principalType === "user" ? User : Users;
            return (
              <li key={g.id} className="flex items-center gap-2 py-1.5">
                <Icon className="size-4 shrink-0 text-[var(--muted-foreground)]" />
                <span className="min-w-0 flex-1 truncate">{nameOf(g)}</span>
                <RoleSelect
                  label={`Role for ${nameOf(g)}`}
                  value={g.role}
                  onChange={(r) => void grant(g.principalType, g.principalId, r)}
                />
                <button
                  type="button"
                  aria-label={`Remove ${nameOf(g)}`}
                  onClick={() => void run(() => access(`/grants/${g.id}`, { method: "DELETE" }))}
                  className="flex size-6 items-center justify-center rounded text-[var(--muted-foreground)] hover:text-[var(--destructive)] cursor-pointer"
                >
                  <X className="size-3.5" />
                </button>
              </li>
            );
          })}
        </ul>

        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const [type, id] = pick.split(":");
            if (!id) return;
            setPick("");
            void grant(type as Grant["principalType"], id, role);
          }}
        >
          <select
            aria-label="Person or group"
            value={pick}
            onChange={(e) => setPick(e.target.value)}
            className="h-8 min-w-0 flex-1 rounded border border-[var(--border)] bg-[var(--background)] px-2 text-sm"
          >
            <option value="">Add a person or group…</option>
            {choices.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
          <RoleSelect label="Role to give" value={role} onChange={setRole} />
          <button
            type="submit"
            disabled={!pick}
            className={cn(
              "h-8 rounded bg-[var(--primary)] px-3 text-sm text-[var(--primary-foreground)] cursor-pointer",
              !pick && "cursor-not-allowed opacity-50",
            )}
          >
            Share
          </button>
        </form>
        {error && (
          <p role="alert" className="mt-2 text-xs text-red-500">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}

function RoleSelect({ label, value, onChange }: { label: string; value: Role; onChange: (r: Role) => void }) {
  return (
    <select
      aria-label={label}
      value={value}
      onChange={(e) => onChange(e.target.value as Role)}
      className="h-8 rounded border border-[var(--border)] bg-[var(--background)] px-1.5 text-sm"
    >
      {ROLES.map((r) => (
        <option key={r.role} value={r.role}>
          {r.label}
        </option>
      ))}
    </select>
  );
}
