"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pencil, Plus, Trash2, UserCog, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Role } from "./server-files";
import { access, personLabel, ROLES, type Group, type Person } from "./sharing";
import { useWorkspace } from "./store";

/**
 * Admin panel for workspace owners (#67): who has signed in and their
 * workspace role, the org tree of groups and its members, and recent access
 * changes. Everything goes through the agent's /access API, which checks the
 * caller owns the workspace; this only hides the button from everyone else.
 */

interface PersonRow extends Person {
  createdAt: string;
  lastSeenAt: string | null;
  role: Role | null;
  grantId: string | null;
  effectiveRole: Role | null;
  groupIds: string[];
}

interface AuditEntry {
  id: string;
  actorType: "user" | "agent";
  actorId: string | null;
  action: string;
  target: Record<string, unknown>;
  at: string;
}

type Tab = "people" | "groups" | "activity";

const RANK: Record<Role, number> = { viewer: 1, editor: 2, owner: 3 };
const roleLabel = (r: Role) => ROLES.find((x) => x.role === r)!.label;
const ACCESS: Record<Role, string> = { viewer: "view", editor: "edit", owner: "owner" };

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
function ago(iso: string | null) {
  if (!iso) return "—";
  const seconds = (new Date(iso).getTime() - Date.now()) / 1000;
  const steps: [Intl.RelativeTimeFormatUnit, number][] = [
    ["year", 31_536_000],
    ["month", 2_592_000],
    ["day", 86_400],
    ["hour", 3600],
    ["minute", 60],
  ];
  for (const [unit, size] of steps) {
    if (Math.abs(seconds) >= size) return relative.format(Math.round(seconds / size), unit);
  }
  return "just now";
}

/** Opens the admin panel; only workspace owners (with login on) see it. */
export function AdminButton() {
  const { account, rootRole, storageMode } = useWorkspace();
  const [open, setOpen] = useState(false);
  if (!account.login || storageMode !== "server" || rootRole !== "owner") return null;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex h-7 items-center gap-1 rounded px-2 text-xs text-[var(--muted-foreground)] hover:bg-[var(--secondary)] hover:text-[var(--foreground)] cursor-pointer"
      >
        <UserCog className="size-3.5" /> Admin
      </button>
      {open && <AdminDialog onClose={() => setOpen(false)} />}
    </>
  );
}

function AdminDialog({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<Tab>("people");
  const [people, setPeople] = useState<PersonRow[] | null>(null);
  const [groups, setGroups] = useState<Group[]>([]);
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [me, setMe] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dialog = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    const [p, g, a, who] = await Promise.all([
      access<{ people: PersonRow[] }>("/people"),
      access<{ groups: Group[] }>("/groups"),
      access<{ entries: AuditEntry[] }>("/audit?limit=200&kind=group&kind=grant"),
      access<{ me: { id: string } | null }>(""),
    ]);
    setPeople(p.people);
    setGroups(g.groups);
    setEntries(a.entries);
    setMe(who.me?.id ?? null);
  }, []);

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

  const tabs: { id: Tab; label: string }[] = [
    { id: "people", label: people ? `People (${people.length})` : "People" },
    { id: "groups", label: `Groups (${groups.length})` },
    { id: "activity", label: "Activity" },
  ];

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 p-4 pt-[8vh]"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-label="Admin"
        tabIndex={-1}
        onKeyDown={(e) => e.key === "Escape" && onClose()}
        className="flex max-h-[84vh] w-full max-w-3xl flex-col rounded-lg border border-[var(--border)] bg-[var(--background)] text-sm shadow-xl outline-none"
      >
        <header className="flex items-center justify-between border-b border-[var(--border)] px-4 pt-3">
          <div role="tablist" aria-label="Admin sections" className="flex gap-1">
            {tabs.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={tab === t.id}
                onClick={() => setTab(t.id)}
                className={cn(
                  "-mb-px border-b-2 px-3 pb-2 cursor-pointer",
                  tab === t.id
                    ? "border-[var(--primary)] font-medium text-[var(--foreground)]"
                    : "border-transparent text-[var(--muted-foreground)] hover:text-[var(--foreground)]",
                )}
              >
                {t.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="mb-2 flex size-6 items-center justify-center rounded text-[var(--muted-foreground)] hover:bg-[var(--secondary)] cursor-pointer"
          >
            <X className="size-4" />
          </button>
        </header>
        <div role="tabpanel" aria-label={tabs.find((t) => t.id === tab)!.label} className="min-h-0 flex-1 overflow-auto p-4">
          {tab === "people" && <PeopleTab people={people} groups={groups} me={me} run={run} />}
          {tab === "groups" && <GroupsTab people={people ?? []} groups={groups} run={run} />}
          {tab === "activity" && <ActivityTab entries={entries} people={people ?? []} groups={groups} />}
        </div>
        {error && (
          <p role="alert" className="border-t border-[var(--border)] px-4 py-2 text-xs text-red-500">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}

type Run = (action: () => Promise<unknown>) => Promise<void>;

function PeopleTab({
  people,
  groups,
  me,
  run,
}: {
  people: PersonRow[] | null;
  groups: Group[];
  me: string | null;
  run: Run;
}) {
  if (!people) return <p className="text-[var(--muted-foreground)]">Loading…</p>;
  const groupName = (id: string) => groups.find((g) => g.id === id)?.name ?? "Unknown group";
  const setRole = (p: PersonRow, role: Role | "") =>
    run(() =>
      role === ""
        ? access(`/grants/${p.grantId}`, { method: "DELETE" })
        : access("/grants", {
            method: "POST",
            body: JSON.stringify({ node: null, principalType: "user", principalId: p.id, role }),
          }),
    );
  return (
    <>
      <p className="mb-3 text-xs text-[var(--muted-foreground)]">
        Everyone who has signed in. A workspace role covers everything in the workspace; owners can open this panel.
        People get access to single places through Share, and through their groups.
      </p>
      <table aria-label="People" className="w-full text-left">
        <thead className="text-xs text-[var(--muted-foreground)]">
          <tr>
            <th className="py-1 font-normal">Person</th>
            <th className="py-1 font-normal">Workspace role</th>
            <th className="py-1 font-normal">Groups</th>
            <th className="py-1 font-normal">Last active</th>
            <th className="py-1 font-normal">Joined</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-[var(--border)]">
          {people.map((p) => {
            const label = personLabel(p);
            const viaGroup =
              p.effectiveRole && (!p.role || RANK[p.effectiveRole] > RANK[p.role]) ? p.effectiveRole : null;
            return (
              <tr key={p.id}>
                <td className="py-2 pr-2">
                  <div className="truncate font-medium">
                    {label}
                    {p.id === me && <span className="ml-1 text-xs text-[var(--muted-foreground)]">(you)</span>}
                  </div>
                  {p.email && p.email !== label && (
                    <div className="truncate text-xs text-[var(--muted-foreground)]">{p.email}</div>
                  )}
                </td>
                <td className="py-2 pr-2">
                  <select
                    aria-label={`Workspace role for ${label}`}
                    value={p.role ?? ""}
                    onChange={(e) => void setRole(p, e.target.value as Role | "")}
                    className="h-8 rounded border border-[var(--border)] bg-[var(--background)] px-1.5 text-sm"
                  >
                    <option value="">No workspace role</option>
                    {ROLES.map((r) => (
                      <option key={r.role} value={r.role}>
                        {r.label}
                      </option>
                    ))}
                  </select>
                  {viaGroup && (
                    <div className="mt-0.5 text-xs text-[var(--muted-foreground)]">
                      {roleLabel(viaGroup)} through a group
                    </div>
                  )}
                </td>
                <td className="py-2 pr-2 text-xs">
                  {p.groupIds.length === 0 ? (
                    <span className="text-[var(--muted-foreground)]">—</span>
                  ) : (
                    <div className="flex flex-wrap gap-1">
                      {p.groupIds.map((id) => (
                        <span key={id} className="rounded bg-[var(--secondary)] px-1.5 py-0.5">
                          {groupName(id)}
                        </span>
                      ))}
                    </div>
                  )}
                </td>
                <td className="py-2 pr-2 text-xs whitespace-nowrap" title={p.lastSeenAt ?? undefined}>
                  {ago(p.lastSeenAt)}
                </td>
                <td className="py-2 text-xs whitespace-nowrap" title={p.createdAt}>
                  {ago(p.createdAt)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </>
  );
}

function GroupsTab({ people, groups, run }: { people: PersonRow[]; groups: Group[]; run: Run }) {
  const [name, setName] = useState("");
  const [parent, setParent] = useState("");
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);

  const children = useMemo(() => {
    const map = new Map<string | null, Group[]>();
    for (const g of groups) map.set(g.parentId, [...(map.get(g.parentId) ?? []), g]);
    return map;
  }, [groups]);
  // Depth-first, so sub-groups sit under their parent.
  const ordered: { group: Group; depth: number }[] = [];
  const walk = (parentId: string | null, depth: number) => {
    for (const g of children.get(parentId) ?? []) {
      ordered.push({ group: g, depth });
      walk(g.id, depth + 1);
    }
  };
  walk(null, 0);

  const personName = (id: string) => {
    const p = people.find((x) => x.id === id);
    return p ? personLabel(p) : "Unknown user";
  };

  return (
    <>
      <form
        className="mb-4 flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!name.trim()) return;
          void run(async () => {
            await access("/groups", { method: "POST", body: JSON.stringify({ parentId: parent || null, name }) });
            setName("");
          });
        }}
      >
        <input
          aria-label="New group name"
          placeholder="New group name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="h-8 min-w-0 flex-1 rounded border border-[var(--border)] bg-[var(--background)] px-2 text-sm"
        />
        <select
          aria-label="Inside"
          value={parent}
          onChange={(e) => setParent(e.target.value)}
          className="h-8 max-w-[40%] rounded border border-[var(--border)] bg-[var(--background)] px-1.5 text-sm"
        >
          <option value="">Top level</option>
          {ordered.map(({ group, depth }) => (
            <option key={group.id} value={group.id}>
              {"  ".repeat(depth)}
              {group.name}
            </option>
          ))}
        </select>
        <button
          type="submit"
          disabled={!name.trim()}
          className={cn(
            "flex h-8 items-center gap-1 rounded bg-[var(--primary)] px-3 text-sm text-[var(--primary-foreground)] cursor-pointer",
            !name.trim() && "cursor-not-allowed opacity-50",
          )}
        >
          <Plus className="size-3.5" /> Create group
        </button>
      </form>

      {ordered.length === 0 && (
        <p className="text-[var(--muted-foreground)]">
          No groups yet. Groups can nest (company › department › team); sharing with a group covers its members and
          the members of every group inside it.
        </p>
      )}
      <ul aria-label="Groups" className="divide-y divide-[var(--border)]">
        {ordered.map(({ group, depth }) => {
          const outside = people.filter((p) => !group.memberIds.includes(p.id));
          return (
            <li
              key={group.id}
              aria-label={group.name}
              className="py-2"
              style={{ paddingLeft: `${depth * 20}px` }}
            >
              <div className="flex items-center gap-2">
                {renaming?.id === group.id ? (
                  <form
                    className="flex min-w-0 flex-1 items-center gap-1"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void run(async () => {
                        await access(`/groups/${group.id}`, {
                          method: "PATCH",
                          body: JSON.stringify({ name: renaming.name }),
                        });
                        setRenaming(null);
                      });
                    }}
                  >
                    <input
                      autoFocus
                      aria-label={`New name for ${group.name}`}
                      value={renaming.name}
                      onChange={(e) => setRenaming({ id: group.id, name: e.target.value })}
                      onKeyDown={(e) => {
                        if (e.key === "Escape") {
                          e.stopPropagation();
                          setRenaming(null);
                        }
                      }}
                      className="h-7 min-w-0 flex-1 rounded border border-[var(--border)] bg-[var(--background)] px-2 text-sm"
                    />
                    <button type="submit" className="h-7 rounded px-2 text-xs hover:bg-[var(--secondary)] cursor-pointer">
                      Save
                    </button>
                  </form>
                ) : (
                  <span className="min-w-0 flex-1 truncate font-medium">
                    {group.name}
                    <span className="ml-2 text-xs font-normal text-[var(--muted-foreground)]">
                      {group.memberIds.length === 1 ? "1 member" : `${group.memberIds.length} members`}
                    </span>
                  </span>
                )}
                <IconButton label={`Rename ${group.name}`} onClick={() => setRenaming({ id: group.id, name: group.name })}>
                  <Pencil className="size-3.5" />
                </IconButton>
                <IconButton
                  label={`Delete ${group.name}`}
                  danger
                  onClick={() => {
                    if (window.confirm(`Delete the group ${group.name}, its sub-groups and what was shared with them?`)) {
                      void run(() => access(`/groups/${group.id}`, { method: "DELETE" }));
                    }
                  }}
                >
                  <Trash2 className="size-3.5" />
                </IconButton>
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-1 text-xs">
                {group.memberIds.map((id) => (
                  <span key={id} className="flex items-center gap-0.5 rounded bg-[var(--secondary)] py-0.5 pl-1.5 pr-0.5">
                    {personName(id)}
                    <button
                      type="button"
                      aria-label={`Remove ${personName(id)} from ${group.name}`}
                      onClick={() =>
                        void run(() => access(`/groups/${group.id}/members/${id}`, { method: "DELETE" }))
                      }
                      className="flex size-4 items-center justify-center rounded text-[var(--muted-foreground)] hover:text-[var(--destructive)] cursor-pointer"
                    >
                      <X className="size-3" />
                    </button>
                  </span>
                ))}
                {outside.length > 0 && (
                  <select
                    aria-label={`Add a member to ${group.name}`}
                    value=""
                    onChange={(e) =>
                      e.target.value &&
                      void run(() => access(`/groups/${group.id}/members/${e.target.value}`, { method: "PUT" }))
                    }
                    className="h-6 rounded border border-[var(--border)] bg-[var(--background)] px-1 text-xs"
                  >
                    <option value="">Add member…</option>
                    {outside.map((p) => (
                      <option key={p.id} value={p.id}>
                        {personLabel(p)}
                      </option>
                    ))}
                  </select>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </>
  );
}

function ActivityTab({ entries, people, groups }: { entries: AuditEntry[] | null; people: PersonRow[]; groups: Group[] }) {
  const { nodes } = useWorkspace();
  if (!entries) return <p className="text-[var(--muted-foreground)]">Loading…</p>;
  if (entries.length === 0) return <p className="text-[var(--muted-foreground)]">No access changes yet.</p>;

  const person = (id: unknown) => {
    const p = people.find((x) => x.id === id);
    return p ? personLabel(p) : "someone";
  };
  const group = (id: unknown) => groups.find((g) => g.id === id)?.name ?? "a group";
  const principal = (t: Record<string, unknown>) =>
    t.principalType === "group" ? `the group ${group(t.principalId)}` : person(t.principalId);
  const place = (node: unknown) =>
    node ? (nodes.find((n) => n.id === node)?.name ?? "a knowledge node") : "the workspace";

  const describe = (e: AuditEntry) => {
    const t = e.target;
    switch (e.action) {
      case "group.create":
        return `created the group ${String(t.name)}`;
      case "group.rename":
        return `renamed a group to ${String(t.name)}`;
      case "group.delete":
        return "deleted a group";
      case "group.add_member":
        return `added ${person(t.user)} to ${group(t.group)}`;
      case "group.remove_member":
        return `removed ${person(t.user)} from ${group(t.group)}`;
      case "grant.set":
        return `gave ${principal(t)} ${ACCESS[t.role as Role] ?? String(t.role)} access to ${place(t.node)}`;
      case "grant.revoke":
        return `removed ${principal(t)}'s access to ${place(t.node)}`;
      default:
        return e.action;
    }
  };

  return (
    <ul aria-label="Access changes" className="divide-y divide-[var(--border)]">
      {entries.map((e) => (
        <li key={e.id} className="flex items-baseline gap-3 py-1.5">
          <span className="w-24 shrink-0 text-xs text-[var(--muted-foreground)]" title={e.at}>
            {ago(e.at)}
          </span>
          <span className="min-w-0 flex-1">
            <span className="font-medium">{person(e.actorId)}</span>
            {e.actorType === "agent" && <span className="text-[var(--muted-foreground)]"> (via Claude)</span>}{" "}
            {describe(e)}
          </span>
        </li>
      ))}
    </ul>
  );
}

function IconButton({
  label,
  danger,
  onClick,
  children,
}: {
  label: string;
  danger?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn(
        "flex size-6 items-center justify-center rounded text-[var(--muted-foreground)] hover:bg-[var(--secondary)] cursor-pointer",
        danger ? "hover:text-[var(--destructive)]" : "hover:text-[var(--foreground)]",
      )}
    >
      {children}
    </button>
  );
}
