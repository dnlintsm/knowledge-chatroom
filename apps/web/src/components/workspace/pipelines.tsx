"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Check, Copy, KeyRound, Plus, Trash2, UserRoundCog } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { SegmentedControl, SegmentedControlItem } from "@/components/ui/segmented-control";
import {
  DEFAULT_KEY_DAYS,
  KEY_LIFETIMES,
  OPERATIONS,
  STATUS_LABEL,
  keyName,
  newPipelineBody,
  operationsText,
  pipelineActions,
  placesText,
  statusNote,
  type NewPipelineKey,
  type Pipeline,
  type PipelineKey,
  type PipelineOperation,
  type PipelinePlace,
  type PlaceNames,
} from "@/lib/pipelines";
import { ago, cn } from "@/lib/utils";
import type { WorkspaceInfo } from "@/lib/workspace-request";
import type { components } from "@knowledge-chatroom/contracts/generated/storage-api";
import { workspacesApi } from "./add-member";
import { Dialog } from "./create-workspace";
import { apiFetch } from "./server-files";
import { access } from "./sharing";
import { useWorkspace } from "./store";

type Member = components["schemas"]["WorkspaceMember"];

async function pipelinesApi<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await apiFetch(`/api/pipelines${path}`, {
    ...init,
    headers: init?.body ? { "Content-Type": "application/json" } : undefined,
    cache: "no-store",
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `${init?.method ?? "GET"} pipelines: ${res.status}`);
  return data;
}

const servedIn = new Map<string, Promise<boolean>>();

/**
 * Whether this server serves pipelines (PIPELINES=on), asked once per
 * workspace by listing them: off, /api/pipelines answers 404.
 */
export function usePipelinesServed(workspaceId: string | undefined): boolean {
  const [served, setServed] = useState(false);
  useEffect(() => {
    if (!workspaceId) return;
    let live = true;
    let asked = servedIn.get(workspaceId);
    if (!asked) {
      asked = apiFetch("/api/pipelines", { cache: "no-store" }).then(
        (res) => res.ok,
        () => {
          servedIn.delete(workspaceId);
          return false;
        },
      );
      servedIn.set(workspaceId, asked);
    }
    void asked.then((yes) => live && setServed(yes));
    return () => {
      live = false;
    };
  }, [workspaceId]);
  return served;
}

/** Places named as the reader's own tree and Experiment list name them. */
function usePlaceNames(): PlaceNames {
  const { nodes, experiments } = useWorkspace();
  return useMemo(
    () => ({
      node: (id) => nodes.find((n) => n.id === id && n.role !== null)?.name,
      experiment: (id) => experiments.find((e) => e.id === id)?.title,
    }),
    [nodes, experiments],
  );
}

type Confirm =
  | { kind: "revoke"; pipeline: Pipeline }
  | { kind: "revokeKey"; pipeline: Pipeline; key: PipelineKey }
  | { kind: "handOver"; pipeline: Pipeline };

/**
 * Pipelines (docs/pipeline-identities.md, "Screens"): named keys for work
 * that runs on its own, each acting for its owner with only the places and
 * operations chosen. Members see and make their own; Owners and Admins see
 * every one, revoke any, and hand one over. A key is shown once, when it is
 * made.
 */
export function PipelinesDialog({ workspace, onClose }: { workspace: WorkspaceInfo; onClose: () => void }) {
  const manages = workspace.role === "owner" || workspace.role === "admin";
  const [everyone, setEveryone] = useState(false);
  const [pipelines, setPipelines] = useState<Pipeline[] | null>(null);
  const [me, setMe] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [revealed, setRevealed] = useState<{ name: string; key: NewPipelineKey } | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const names = usePlaceNames();
  const content = useRef<HTMLDivElement>(null);

  // Swapping the list, the form and a revealed key removes whatever had focus,
  // leaving it on the page; put it back in the dialog, so Escape still closes
  // it. Opening is the Dialog's own: it focuses itself, and restores on close.
  const opened = useRef(false);
  useEffect(() => {
    if (!opened.current) {
      opened.current = true;
      return;
    }
    const lost = !document.activeElement || document.activeElement === document.body;
    if (lost) content.current?.querySelector<HTMLElement>("button:not([disabled]), input, select, textarea")?.focus();
  }, [revealed, creating, confirm, pipelines]);

  const load = useCallback(async () => {
    try {
      const [listed, who] = await Promise.all([
        pipelinesApi<{ pipelines: Pipeline[] }>(everyone ? "?all" : ""),
        access<{ me: { id: string } | null }>(""),
      ]);
      setPipelines(listed.pipelines);
      setMe(who.me?.id ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [everyone]);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (run: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await run();
      setConfirm(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const addKey = (pipeline: Pipeline) =>
    act(async () => {
      const { key } = await pipelinesApi<{ key: NewPipelineKey }>(`/${encodeURIComponent(pipeline.id)}/keys`, {
        method: "POST",
        body: JSON.stringify({ expiresInDays: DEFAULT_KEY_DAYS }),
      });
      setRevealed({ name: pipeline.name, key });
    });

  return (
    <Dialog label="Pipelines" wide onClose={() => !busy && onClose()}>
      <div ref={content} className="flex flex-col gap-3 text-sm">
        {revealed ? (
          <KeyReveal name={revealed.name} pipelineKey={revealed.key} onDone={() => setRevealed(null)} />
        ) : creating ? (
          <NewPipeline
            onCancel={() => setCreating(false)}
            onMade={async (made) => {
              setCreating(false);
              setRevealed({ name: made.pipeline.name, key: made.key });
              await load();
            }}
          />
        ) : (
          <>
            <div className="flex items-center gap-2">
              <p className="min-w-0 flex-1 text-xs text-[var(--muted-foreground)]">
                A pipeline lets a script or a scheduled job use this workspace with a key of its own. It acts for its owner, with
                only the places and operations chosen for it.
              </p>
              <Button size="sm" onClick={() => setCreating(true)}>
                <Plus className="size-3.5" /> New pipeline
              </Button>
            </div>
            {manages && (
              <SegmentedControl aria-label="Whose pipelines">
                <SegmentedControlItem selected={!everyone} onClick={() => setEveryone(false)}>
                  Yours
                </SegmentedControlItem>
                <SegmentedControlItem selected={everyone} onClick={() => setEveryone(true)}>
                  Everyone&apos;s
                </SegmentedControlItem>
              </SegmentedControl>
            )}
            {!pipelines && !error && <p className="text-[var(--muted-foreground)]">Loading…</p>}
            {pipelines?.length === 0 && (
              <p className="text-xs text-[var(--muted-foreground)]">
                {everyone ? "Nobody in this workspace has made a pipeline yet." : "You haven't made a pipeline yet."}
              </p>
            )}
            {pipelines && pipelines.length > 0 && (
              <ul aria-label="Pipelines" className="flex flex-col gap-2">
                {pipelines.map((p) => (
                  <PipelineCard
                    key={p.id}
                    pipeline={p}
                    names={names}
                    showOwner={everyone}
                    may={pipelineActions(p, me, manages)}
                    busy={busy}
                    confirm={confirm?.pipeline.id === p.id ? confirm : null}
                    onConfirm={setConfirm}
                    onAddKey={() => void addKey(p)}
                    onRevoke={() =>
                      void act(async () => {
                        await pipelinesApi(`/${encodeURIComponent(p.id)}`, { method: "DELETE" });
                      })
                    }
                    onRevokeKey={(key) =>
                      void act(async () => {
                        await pipelinesApi(`/${encodeURIComponent(p.id)}/keys/${encodeURIComponent(key.id)}`, {
                          method: "DELETE",
                        });
                      })
                    }
                    onHandOver={(userId) =>
                      void act(async () => {
                        await pipelinesApi(`/${encodeURIComponent(p.id)}/owner`, {
                          method: "POST",
                          body: JSON.stringify({ userId }),
                        });
                      })
                    }
                    workspace={workspace}
                  />
                ))}
              </ul>
            )}
          </>
        )}
        {error && (
          <p role="alert" className="text-xs text-red-500">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}

function PipelineCard({
  pipeline,
  names,
  showOwner,
  may,
  busy,
  confirm,
  onConfirm,
  onAddKey,
  onRevoke,
  onRevokeKey,
  onHandOver,
  workspace,
}: {
  pipeline: Pipeline;
  names: PlaceNames;
  showOwner: boolean;
  may: ReturnType<typeof pipelineActions>;
  busy: boolean;
  confirm: Confirm | null;
  onConfirm: (confirm: Confirm | null) => void;
  onAddKey: () => void;
  onRevoke: () => void;
  onRevokeKey: (key: PipelineKey) => void;
  onHandOver: (userId: string) => void;
  workspace: WorkspaceInfo;
}) {
  const note = statusNote(pipeline);
  const keys = pipeline.keys.filter((k) => k.status !== "revoked" || pipeline.status === "revoked").slice(-4);
  return (
    <li
      aria-label={pipeline.name}
      className={cn(
        "rounded-md border border-[var(--border)] p-3",
        pipeline.status === "revoked" && "opacity-70",
      )}
    >
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-medium">{pipeline.name}</span>
        <Badge variant={pipeline.status === "active" ? "secondary" : "outline"}>{STATUS_LABEL[pipeline.status]}</Badge>
      </div>
      {note && <p className="mt-1 text-xs text-[var(--muted-foreground)]">{note}</p>}
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        {showOwner && (
          <>
            <dt className="text-[var(--muted-foreground)]">For</dt>
            <dd>{pipeline.owner?.name ?? "a former member"}</dd>
          </>
        )}
        <dt className="text-[var(--muted-foreground)]">Reaches</dt>
        <dd className="min-w-0 break-words">{placesText(pipeline.places, names)}</dd>
        <dt className="text-[var(--muted-foreground)]">May</dt>
        <dd>{operationsText(pipeline.operations)}</dd>
        <dt className="text-[var(--muted-foreground)]">Keys</dt>
        <dd>
          {keys.length === 0 ? (
            <span className="text-[var(--muted-foreground)]">No key</span>
          ) : (
            <ul aria-label={`Keys of ${pipeline.name}`} className="flex flex-col gap-0.5">
              {keys.map((k) => (
                <li key={k.id} className="flex items-center gap-2">
                  <span className="font-mono">{keyName(k)}</span>
                  <span className="min-w-0 flex-1 truncate text-[var(--muted-foreground)]">{keyLine(k)}</span>
                  {may.revokeKey && k.status === "active" && (
                    <button
                      type="button"
                      aria-label={`Revoke key ${keyName(k)}`}
                      title="Revoke this key"
                      disabled={busy}
                      onClick={() => onConfirm({ kind: "revokeKey", pipeline, key: k })}
                      className="flex size-5 items-center justify-center rounded text-[var(--muted-foreground)] hover:bg-[var(--secondary)] hover:text-[var(--destructive)] cursor-pointer"
                    >
                      <Trash2 className="size-3" />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </dd>
      </dl>
      {confirm ? (
        <ConfirmBox confirm={confirm} workspace={workspace} busy={busy} onCancel={() => onConfirm(null)}
          onRevoke={onRevoke} onRevokeKey={onRevokeKey} onHandOver={onHandOver} />
      ) : (
        (may.addKey || may.revoke || may.handOver) && (
          <div className="mt-2 flex flex-wrap gap-1">
            {may.addKey && (
              <Button variant="quiet" size="xs" disabled={busy} onClick={onAddKey}>
                <KeyRound /> New key
              </Button>
            )}
            {may.handOver && (
              <Button variant="quiet" size="xs" disabled={busy} onClick={() => onConfirm({ kind: "handOver", pipeline })}>
                <UserRoundCog /> Hand over
              </Button>
            )}
            {may.revoke && (
              <Button variant="quiet" size="xs" disabled={busy} onClick={() => onConfirm({ kind: "revoke", pipeline })}>
                <Trash2 /> Revoke
              </Button>
            )}
          </div>
        )
      )}
    </li>
  );
}

function keyLine(k: PipelineKey): string {
  if (k.status === "revoked") return "revoked";
  if (k.status === "expired") return `expired ${ago(k.expiresAt)}`;
  const used = k.lastUsedAt ? `last used ${ago(k.lastUsedAt)}` : "not used yet";
  return `expires ${ago(k.expiresAt)} · ${used}`;
}

function ConfirmBox({
  confirm,
  workspace,
  busy,
  onCancel,
  onRevoke,
  onRevokeKey,
  onHandOver,
}: {
  confirm: Confirm;
  workspace: WorkspaceInfo;
  busy: boolean;
  onCancel: () => void;
  onRevoke: () => void;
  onRevokeKey: (key: PipelineKey) => void;
  onHandOver: (userId: string) => void;
}) {
  const [members, setMembers] = useState<Member[] | null>(null);
  const [to, setTo] = useState("");
  const ownerId = confirm.pipeline.owner?.id;
  useEffect(() => {
    if (confirm.kind !== "handOver") return;
    void workspacesApi<{ members: Member[] }>(`/${encodeURIComponent(workspace.id)}/members`).then(({ body }) =>
      setMembers((body.members ?? []).filter((m) => m.id !== ownerId)),
    );
  }, [confirm.kind, workspace.id, ownerId]);

  const box = "mt-2 rounded-md border border-[var(--border)] bg-surface-raised p-2 text-xs";
  if (confirm.kind === "handOver") {
    return (
      <div role="group" aria-label="Hand over" className={box}>
        <p className="mb-2">
          It will act for the new owner, with their access. Its keys stop working now: the new owner adds a key for the pipeline
          to use.
        </p>
        <div className="flex gap-2">
          <select
            aria-label="New owner"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="h-8 min-w-0 flex-1 rounded-md border border-[var(--border)] bg-[var(--background)] px-2"
          >
            <option value="">{members ? "Choose a member" : "Loading members…"}</option>
            {(members ?? []).map((m) => (
              <option key={m.id} value={m.id}>
                {m.name ?? m.email ?? "Unnamed member"}
              </option>
            ))}
          </select>
          <Button size="sm" disabled={busy || !to} onClick={() => onHandOver(to)}>
            Hand over
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </div>
    );
  }
  const key = confirm.kind === "revokeKey" ? confirm.key : null;
  return (
    <div role="group" aria-label={key ? `Revoke key ${keyName(key)}` : `Revoke ${confirm.pipeline.name}`} className={box}>
      <p className="mb-2">
        {key ? `Requests with the key ${keyName(key)} stop at once.` : "Requests with any of its keys stop at once, and it can't be turned back on."}{" "}
        A request already running ends as it would have, and its result is kept.
      </p>
      <div className="flex gap-2">
        <Button size="sm" variant="destructive" disabled={busy} onClick={() => (key ? onRevokeKey(key) : onRevoke())}>
          {key ? "Revoke key" : "Revoke pipeline"}
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function NewPipeline({
  onCancel,
  onMade,
}: {
  onCancel: () => void;
  onMade: (made: { pipeline: Pipeline; key: NewPipelineKey }) => Promise<void>;
}) {
  const { nodes, experiments } = useWorkspace();
  const ids = useId();
  const [name, setName] = useState("");
  const [whole, setWhole] = useState(true);
  const [places, setPlaces] = useState<PipelinePlace[]>([]);
  const [operations, setOperations] = useState<PipelineOperation[]>(["read"]);
  const [days, setDays] = useState<number>(DEFAULT_KEY_DAYS);
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const checked = useMemo(() => new Set(places.map((p) => ("node" in p ? `n:${p.node}` : `x:${p.experiment}`))), [places]);
  const toggle = (place: PipelinePlace, on: boolean) => {
    const id = "node" in place ? `n:${place.node}` : `x:${place.experiment}`;
    setPlaces((now) =>
      on ? [...now, place] : now.filter((p) => ("node" in p ? `n:${p.node}` : `x:${p.experiment}`) !== id),
    );
  };
  const wanted = filter.trim().toLowerCase();
  const shownNodes = nodes.filter((n) => n.role !== null && (!wanted || n.name.toLowerCase().includes(wanted)));
  const shownExperiments = experiments.filter((e) => !wanted || e.title.toLowerCase().includes(wanted));
  const ready = newPipelineBody({ name, whole, places, operations, days });

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if ("problem" in ready) return setError(ready.problem);
    setBusy(true);
    setError(null);
    try {
      await onMade(await pipelinesApi<{ pipeline: Pipeline; key: NewPipelineKey }>("", { method: "POST", body: JSON.stringify(ready.body) }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <form aria-label="New pipeline" onSubmit={submit} className="flex flex-col gap-3 text-xs">
      <div>
        <label htmlFor={`${ids}-name`} className="mb-1 block font-medium">
          Name
        </label>
        <Input id={`${ids}-name`} value={name} maxLength={200} placeholder="Nightly etch import" onChange={(e) => setName(e.target.value)} className="h-8" />
      </div>
      <fieldset>
        <legend className="mb-1 font-medium">Places it reaches</legend>
        <label className="flex items-center gap-2 py-0.5">
          <input type="radio" name={`${ids}-where`} checked={whole} onChange={() => setWhole(true)} /> The whole workspace
        </label>
        <label className="flex items-center gap-2 py-0.5">
          <input type="radio" name={`${ids}-where`} checked={!whole} onChange={() => setWhole(false)} /> Only the nodes and
          Experiments I choose
        </label>
        {!whole && (
          <div className="mt-1 rounded-md border border-[var(--border)] p-2">
            <Input aria-label="Find a place" placeholder="Find a node or Experiment" value={filter} onChange={(e) => setFilter(e.target.value)} className="mb-2 h-7" />
            <div className="max-h-48 overflow-y-auto">
              {shownNodes.length > 0 && <p className="pb-1 text-[11px] font-medium text-[var(--muted-foreground)]">Knowledge (each with everything below it)</p>}
              {shownNodes.map((n) => (
                <label key={n.id} className="flex items-center gap-2 py-0.5" style={{ paddingLeft: wanted ? 0 : (n.depth - 1) * 12 }}>
                  <Checkbox checked={checked.has(`n:${n.id}`)} onCheckedChange={(on) => toggle({ node: n.id }, on === true)} className="size-4" />
                  <span className="truncate">{n.name}</span>
                </label>
              ))}
              {shownExperiments.length > 0 && <p className="pb-1 pt-2 text-[11px] font-medium text-[var(--muted-foreground)]">Experiments (each with its Runs)</p>}
              {shownExperiments.map((x) => (
                <label key={x.id} className="flex items-center gap-2 py-0.5">
                  <Checkbox checked={checked.has(`x:${x.id}`)} onCheckedChange={(on) => toggle({ experiment: x.id }, on === true)} className="size-4" />
                  <span className="truncate">{x.title}</span>
                </label>
              ))}
              {shownNodes.length === 0 && shownExperiments.length === 0 && <p className="text-[var(--muted-foreground)]">Nothing matches.</p>}
            </div>
          </div>
        )}
      </fieldset>
      <fieldset>
        <legend className="mb-1 font-medium">What it may do</legend>
        {OPERATIONS.map((op) => (
          <label key={op.id} className="flex items-start gap-2 py-0.5">
            <Checkbox
              checked={operations.includes(op.id)}
              onCheckedChange={(on) => setOperations((now) => (on === true ? [...now, op.id] : now.filter((x) => x !== op.id)))}
              className="mt-0.5 size-4"
            />
            <span>
              <span className="font-medium">{op.label}</span>
              <span className="text-[var(--muted-foreground)]"> · {op.allows}</span>
            </span>
          </label>
        ))}
        <p className="mt-1 text-[var(--muted-foreground)]">
          Never more than you can do yourself. Like Claude, it can&apos;t share, delete, accept proposals or manage people.
        </p>
      </fieldset>
      <div>
        <label htmlFor={`${ids}-days`} className="mb-1 block font-medium">
          Its key lasts
        </label>
        <select
          id={`${ids}-days`}
          value={days}
          onChange={(e) => setDays(Number(e.target.value))}
          className="h-8 rounded-md border border-[var(--border)] bg-[var(--background)] px-2"
        >
          {KEY_LIFETIMES.map((d) => (
            <option key={d} value={d}>
              {d} days
            </option>
          ))}
        </select>
      </div>
      {error && (
        <p role="alert" className="text-red-500">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={busy || "problem" in ready} title={"problem" in ready ? ready.problem : undefined}>
          {busy ? "Making it…" : "Make pipeline"}
        </Button>
      </div>
    </form>
  );
}

function KeyReveal({ name, pipelineKey, onDone }: { name: string; pipelineKey: NewPipelineKey; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(pipelineKey.secret);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  return (
    <section aria-label={`The key for ${name}`} className="flex flex-col gap-2 text-xs">
      <h3 className="text-sm font-medium">The key for {name}</h3>
      <p role="status" className="font-medium">
        You won&apos;t see this key again. Copy it now, and keep it where the pipeline runs, like any password.
      </p>
      <div className="flex items-center gap-2 rounded-md border border-[var(--border)] bg-surface-raised p-2">
        <code data-testid="pipeline-secret" className="min-w-0 flex-1 break-all font-mono">
          {pipelineKey.secret}
        </code>
        <Button size="sm" variant="outline" onClick={() => void copy()}>
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />} {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <p className="text-[var(--muted-foreground)]">
        It lasts until {new Date(pipelineKey.expiresAt).toLocaleDateString(undefined, { dateStyle: "medium" })}. Send it as{" "}
        <code className="font-mono">Authorization: Bearer …</code> to the files, nodes, Experiments, runs, search and proposals
        routes, for example:
      </p>
      <pre className="overflow-x-auto rounded-md bg-surface-raised p-2 font-mono text-[11px]">
        {`curl -H "Authorization: Bearer $KEY" ${origin}/api/experiments`}
      </pre>
      <div className="flex justify-end">
        <Button size="sm" onClick={onDone}>
          Done
        </Button>
      </div>
    </section>
  );
}
