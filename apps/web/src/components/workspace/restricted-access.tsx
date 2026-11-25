"use client";

import { useCallback, useEffect, useState } from "react";
import { Lock, User, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import { apiFetch, type KnowledgeNode, type Role } from "./server-files";
import { ROLES } from "./sharing";
import type { components } from "@knowledge-chatroom/contracts/generated/storage-api";

/**
 * Restricted Knowledge nodes in the UI (docs/restricted-knowledge.md, Screens):
 * the lock mark, Restrict and its preview, Who has access, and the view an
 * Owner or Admin gets of a restricted node they can't open.
 */

type Schema = components["schemas"];
type Restriction = Schema["Restriction"];
type Change = Restriction["changes"][number];
type GroupCut = Restriction["groups"][number];
type NodeAccess = Schema["NodeAccess"];
type Source = Schema["AccessSource"];

export const RESTRICTED_TITLE = "Restricted: only the people listed in Sharing can open this";

/** The lock beside a restricted node's name. */
export function LockMark({ className }: { className?: string }) {
  return (
    <span role="img" aria-label="Restricted" title={RESTRICTED_TITLE} className={cn("inline-flex shrink-0", className)}>
      <Lock className="size-3" />
    </span>
  );
}

async function nodeApi<T>(id: string, sub: string, init?: RequestInit): Promise<T> {
  const res = await apiFetch(`/api/nodes/${encodeURIComponent(id)}/${sub}`, {
    cache: "no-store",
    ...init,
    headers: init?.body ? { "Content-Type": "application/json" } : undefined,
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `${init?.method ?? "GET"} ${sub}: ${res.status}`);
  return data;
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

export const roleLabel = (role: Role | null) =>
  role === null ? "No access" : (ROLES.find((r) => r.role === role)?.label ?? role);

const shortDate = (at: string) =>
  new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });

/** Where a role comes from: "through Etch team on Process", "on the workspace", "here". */
export function sourceText(source: Source, here: string): string {
  const where = source.node === null ? "on the workspace" : source.node.id === here ? "here" : `on ${source.node.name}`;
  const how = source.group ? `through ${source.group.name ?? "a group"} ` : "";
  const took = source.takeover ? `, took over on ${shortDate(source.since)}` : "";
  return `${how}${where}${took}`;
}

const takeoverText = (node: KnowledgeNode, named: boolean) =>
  node.takenOver
    ? `${node.takenOver.user.name ?? "An Owner"} took over${named ? ` ${node.name}` : ""} on ${shortDate(node.takenOver.at)}`
    : "";

/** "Alice took over on Nov 25, 2026", in Sharing for a node that was taken over. */
export function TakenOver({ node }: { node: KnowledgeNode }) {
  if (!node.takenOver) return null;
  return <p className="text-xs text-[var(--muted-foreground)]">{takeoverText(node, false)}.</p>;
}

/**
 * The takeover of the restricted node that bounds where you are, shown beside
 * the breadcrumb so everyone who can open it sees it, not only those who
 * manage access there.
 */
export function TakeoverNotice({ lineage }: { lineage: KnowledgeNode[] }) {
  const boundary = lineage.findLast((n) => n.restricted);
  if (!boundary?.takenOver) return null;
  return (
    <span
      title={`${takeoverText(boundary, true)}.`}
      className="ml-2 flex shrink-0 items-center gap-1 rounded-full bg-[var(--secondary)] px-2 py-0.5 text-[var(--muted-foreground)] max-sm:hidden"
    >
      <Lock className="size-3 shrink-0" />
      Taken over by {boundary.takenOver.user.name ?? "an Owner"}
    </span>
  );
}

/** Everyone who can open the node, with their role and every source of it. */
export function WhoHasAccess({ node, revision = 0 }: { node: string; revision?: number }) {
  const [answer, setAnswer] = useState<NodeAccess | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    nodeApi<NodeAccess>(node, "access")
      .then((a) => live && (setAnswer(a), setError(null)))
      .catch((err) => live && setError(message(err)));
    return () => {
      live = false;
    };
  }, [node, revision]);

  const stops = answer?.inheritanceStopsAt;
  return (
    <section aria-label="Who has access" className="mt-3 border-t border-[var(--border)] pt-3">
      <h3 className="mb-1 flex items-baseline gap-2 text-xs font-semibold">
        Who has access
        {stops && (
          <span className="flex items-center gap-1 font-normal text-[var(--muted-foreground)]">
            <Lock className="size-3" />
            {stops.id === node ? "Inheritance stops here" : `Inheritance stops at ${stops.name}`}
          </span>
        )}
      </h3>
      {error && (
        <p role="alert" className="text-xs text-red-500">
          {error}
        </p>
      )}
      {!answer && !error && <p className="text-xs text-[var(--muted-foreground)]">Loading…</p>}
      <ul className="divide-y divide-[var(--border)]">
        {answer?.people.map((p) => (
          <li key={p.user.id} className="py-1.5">
            <div className="flex items-center gap-2">
              <User className="size-4 shrink-0 text-[var(--muted-foreground)]" />
              <span className="min-w-0 flex-1 truncate">{p.user.name ?? "Unnamed member"}</span>
              <span className="shrink-0 text-xs">{roleLabel(p.role)}</span>
            </div>
            <ul className="ml-6 text-xs text-[var(--muted-foreground)]">
              {p.sources.map((s, i) => (
                <li key={i} className={cn(i > 0 && "opacity-75")}>
                  {i === 0 ? sourceText(s, node) : `also ${roleLabel(s.role)}, ${sourceText(s, node)}`}
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * The Sharing panel's restriction row and its preview. Restricting lists who
 * would lose access, each with a checkbox to keep them (unchecked: restricting
 * means restricting); lifting lists who would gain it.
 */
export function RestrictControl({
  node,
  name,
  onChanged,
}: {
  node: KnowledgeNode;
  name: string;
  onChanged: () => void;
}) {
  const [preview, setPreview] = useState<Restriction | null>(null);
  const [keep, setKeep] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const open = useCallback(async () => {
    setBusy(true);
    try {
      setPreview(await nodeApi<Restriction>(node.id, "restriction"));
      setKeep(new Set());
      setError(null);
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }, [node.id]);

  const apply = async () => {
    if (!preview) return;
    setBusy(true);
    try {
      await nodeApi<Restriction>(node.id, "restriction", {
        method: "PUT",
        body: JSON.stringify(
          preview.restricted
            ? { restricted: false }
            : {
                restricted: true,
                // Keys are "user:<id>" or "group:<id>".
                keep: [...keep].map((k) => {
                  const [principalType, principalId] = k.split(":");
                  return { principalType, principalId };
                }),
              },
        ),
      });
      setPreview(null);
      setError(null);
      onChanged();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  };

  if (!preview) {
    return (
      <div className="mt-3 border-t border-[var(--border)] pt-3">
        {node.restricted ? (
          <div className="flex items-start gap-2">
            <Lock className="mt-0.5 size-4 shrink-0 text-brand-text" />
            <div className="min-w-0 flex-1 text-xs">
              <p className="font-medium text-[var(--foreground)]">Restricted</p>
              <p className="text-[var(--muted-foreground)]">
                Only people given access here, or below, can open it.
              </p>
              <TakenOver node={node} />
            </div>
            <Button variant="outline" size="sm" disabled={busy} onClick={() => void open()}>
              Lift…
            </Button>
          </div>
        ) : (
          <div className="flex items-start gap-2">
            <Lock className="mt-0.5 size-4 shrink-0 text-[var(--muted-foreground)]" />
            <p className="min-w-0 flex-1 text-xs text-[var(--muted-foreground)]">
              Restrict it so that only people given access here, or below, can open it.
            </p>
            <Button variant="outline" size="sm" disabled={busy} onClick={() => void open()}>
              Restrict…
            </Button>
          </div>
        )}
        {error && (
          <p role="alert" className="mt-2 text-xs text-red-500">
            {error}
          </p>
        )}
      </div>
    );
  }

  const lifting = preview.restricted;
  const toggle = (id: string) =>
    setKeep((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  return (
    <section
      aria-label={lifting ? `Lift the restriction on ${name}` : `Restrict ${name}`}
      className="mt-3 rounded-md border border-[var(--border)] bg-[var(--surface-raised)] p-3"
    >
      <h3 className="flex items-center gap-1.5 text-sm font-semibold">
        <Lock className="size-4" />
        {lifting ? `Lift the restriction on ${name}?` : `Restrict ${name}?`}
      </h3>
      <p className="mt-1 text-xs text-[var(--muted-foreground)]">
        {lifting
          ? "Access given higher up will reach it again."
          : "Access given higher up will stop here. You keep Full access."}
      </p>
      <h4 className="mt-3 text-xs font-medium">
        {preview.changes.length === 0
          ? lifting
            ? "No one else gains access."
            : "No one loses access."
          : lifting
            ? "These people will gain access"
            : "These people will lose access"}
      </h4>
      <ul aria-label={lifting ? "Gaining access" : "Losing access"} className="mt-1 divide-y divide-[var(--border)]">
        {preview.changes.map((c) => (
          <ChangeRow
            key={c.user.id}
            change={c}
            here={node.id}
            lifting={lifting}
            kept={keep.has(`user:${c.user.id}`)}
            onKeep={() => toggle(`user:${c.user.id}`)}
          />
        ))}
      </ul>
      {!lifting && preview.groups.length > 0 && (
        <>
          <h4 className="mt-3 text-xs font-medium">These groups&apos; access from higher up will stop</h4>
          <ul aria-label="Groups losing access" className="mt-1 divide-y divide-[var(--border)]">
            {preview.groups.map((g) => (
              <GroupRow
                key={g.group.id}
                cut={g}
                kept={keep.has(`group:${g.group.id}`)}
                onKeep={() => toggle(`group:${g.group.id}`)}
              />
            ))}
          </ul>
        </>
      )}
      {error && (
        <p role="alert" className="mt-2 text-xs text-red-500">
          {error}
        </p>
      )}
      <div className="mt-3 flex justify-end gap-2">
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => setPreview(null)}>
          Cancel
        </Button>
        <Button size="sm" disabled={busy} onClick={() => void apply()}>
          {lifting ? "Lift restriction" : "Restrict"}
        </Button>
      </div>
    </section>
  );
}

function GroupRow({ cut, kept, onKeep }: { cut: GroupCut; kept: boolean; onKeep: () => void }) {
  const name = cut.group.name ?? "Unnamed group";
  const id = `keep-group-${cut.group.id}`;
  return (
    <li className="flex items-start gap-2 py-1.5">
      <Checkbox
        id={id}
        aria-label={`Keep ${name} at ${roleLabel(cut.role)}`}
        checked={kept}
        onCheckedChange={onKeep}
        className="mt-0.5 size-4"
      />
      <label htmlFor={id} className="min-w-0 flex-1 text-sm">
        <span className="flex items-center gap-1 truncate">
          <Users className="size-3.5 shrink-0 text-[var(--muted-foreground)]" />
          {name}
        </span>
        <span className="block text-xs text-[var(--muted-foreground)]">
          {kept
            ? `Keeps ${roleLabel(cut.role)} here, for everyone in it`
            : `${roleLabel(cut.role)} ${cut.node ? `on ${cut.node.name}` : "on the workspace"}`}
        </span>
      </label>
    </li>
  );
}

function ChangeRow({
  change,
  here,
  lifting,
  kept,
  onKeep,
}: {
  change: Change;
  here: string;
  lifting: boolean;
  kept: boolean;
  onKeep: () => void;
}) {
  const who = change.user.name ?? "Unnamed member";
  const Icon = change.through?.group ? Users : User;
  const id = `keep-${change.user.id}`;
  return (
    <li className="flex items-start gap-2 py-1.5">
      {lifting ? (
        <Icon className="mt-0.5 size-4 shrink-0 text-[var(--muted-foreground)]" />
      ) : (
        <Checkbox
          id={id}
          aria-label={`Keep ${who} at ${roleLabel(change.role)}`}
          checked={kept}
          onCheckedChange={onKeep}
          className="mt-0.5 size-4"
        />
      )}
      <label htmlFor={lifting ? undefined : id} className="min-w-0 flex-1 text-sm">
        <span className="block truncate">{who}</span>
        <span className="block text-xs text-[var(--muted-foreground)]">
          {lifting
            ? `${roleLabel(change.becomes)}, ${change.through ? sourceText(change.through, here) : ""}`
            : kept
              ? `Keeps ${roleLabel(change.role)} here`
              : `${roleLabel(change.role)} → ${roleLabel(change.becomes)}${
                  change.through ? `, from access ${sourceText(change.through, here)}` : ""
                }`}
        </span>
        {!lifting && change.experiments > 0 && !kept && (
          <span className="block text-xs text-amber-700 dark:text-amber-300">
            {change.experiments === 1
              ? "1 of their Experiments will close to them"
              : `${change.experiments} of their Experiments will close to them`}
          </span>
        )}
      </label>
    </li>
  );
}

/**
 * What an Owner or Admin sees of a restricted node they can't open: that it is
 * restricted, who has access, and (Owners only) Take over, confirmed first
 * because everyone with access will see it.
 */
export function RestrictedNodeDialog({
  node,
  owner,
  onClose,
  onTookOver,
}: {
  node: KnowledgeNode;
  owner: boolean;
  onClose: () => void;
  /** After a takeover, with Full access there now. */
  onTookOver: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const takeOver = async () => {
    setBusy(true);
    try {
      await nodeApi(node.id, "takeover", { method: "POST" });
      onTookOver();
    } catch (err) {
      setError(message(err));
      setBusy(false);
    }
  };
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 p-4 pt-[12vh]"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={node.name}
        tabIndex={-1}
        ref={(el) => el?.focus()}
        onKeyDown={(e) => e.key === "Escape" && onClose()}
        className="max-h-[calc(88vh-1rem)] w-full max-w-md overflow-y-auto rounded-lg border border-[var(--border)] bg-[var(--background)] p-4 text-sm shadow-xl outline-none"
      >
        <h2 className="flex items-center gap-1.5 font-semibold">
          <Lock className="size-4" />
          <span className="truncate">{node.name}</span>
        </h2>
        <p className="mt-1 text-xs text-[var(--muted-foreground)]">
          Restricted. You can see who has access but not its content.
        </p>
        <WhoHasAccess node={node.id} />
        {error && (
          <p role="alert" className="mt-2 text-xs text-red-500">
            {error}
          </p>
        )}
        {confirming ? (
          <div className="mt-3 rounded-md border border-[var(--border)] bg-[var(--surface-raised)] p-3">
            <p className="text-xs">
              Take over {node.name}? You get Full access, and everyone who can open it will see that you took
              over. It is recorded in the audit log.
            </p>
            <div className="mt-2 flex justify-end gap-2">
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirming(false)}>
                Cancel
              </Button>
              <Button size="sm" disabled={busy} onClick={() => void takeOver()}>
                Take over
              </Button>
            </div>
          </div>
        ) : (
          <div className="mt-3 flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={onClose}>
              Close
            </Button>
            {owner && (
              <Button variant="outline" size="sm" onClick={() => setConfirming(true)}>
                Take over…
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
