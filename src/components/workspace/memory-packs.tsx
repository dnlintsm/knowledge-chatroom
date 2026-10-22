"use client";

import { useCallback, useEffect, useState } from "react";
import { BadgeCheck, Ban, GitFork, Package, RefreshCw, Search, Trash2, Upload } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  call,
  field,
  json,
  typeLabel,
  useMemory,
  when,
  type MemoryType,
  type PackInstall,
  type SharedPlace,
} from "./memory";
import { PlaceIcon, placeKey } from "./shared-memory";

/**
 * Memory packs and import in the Memory view (issue #93, step 4).
 * - Import: another assistant's memory (pasted, or a file) or a .zip export
 *   becomes changes in your inbox, to accept one by one.
 * - Memory packs: a place's shared notes published to the hub, for other
 *   places to install pinned to a version. Installed notes are read-only and
 *   Manual for everyone until someone turns them on; forking makes them the
 *   place's own. The hub opens in the middle pane.
 */

/** In the editor, the memory pack hub. */
export const PACKS = "packs:";

interface PackFlag {
  kind: string;
  path: string;
  line?: number;
  detail: string;
}

interface PackVersion {
  version: number;
  description: string;
  notes: number;
  flags: PackFlag[];
  publishedBy: string | null;
  publishedAt: string;
  verified: boolean;
  yanked: boolean;
  yankReason: string | null;
}

interface PackListing {
  name: string;
  owner: string | null;
  mine: boolean;
  latest: PackVersion | null;
  updatedAt: string;
}

interface PackDetail extends PackListing {
  versions: PackVersion[];
  version: PackVersion;
  notes: { name: string; description: string; type: MemoryType; body: string }[];
  isAdmin: boolean;
}

type Place = Pick<SharedPlace, "scope" | "nodeId" | "groupId">;

const packUrl = (name = "", action = "") =>
  `/api/memory/packs${name ? `/${encodeURIComponent(name)}` : ""}${action ? `/${action}` : ""}`;

const button =
  "flex items-center gap-1 rounded border border-[var(--border)] px-2 py-1 text-xs hover:bg-[var(--secondary)] disabled:opacity-50 cursor-pointer";

/** Pastes or picks another assistant's memory; it all lands in the inbox. */
export function ImportMemory() {
  const { reload } = useMemory();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      let init: RequestInit;
      if (file && /\.zip$/i.test(file.name)) {
        init = { method: "POST", headers: { "Content-Type": "application/zip" }, body: await file.arrayBuffer() };
      } else if (file) {
        init = json("POST", { text: await file.text(), label: file.name });
      } else {
        init = json("POST", { text, label: "pasted memory" });
      }
      const result = await call<{ proposed: number; skipped: number }>("/api/memory/import", init);
      setDone(
        `${result.proposed} ${result.proposed === 1 ? "note is" : "notes are"} waiting for your review above.` +
          (result.skipped ? ` ${result.skipped} left out (invalid, or the inbox is full).` : ""),
      );
      setText("");
      setFile(null);
      setOpen(false);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <div className="mt-2 px-3">
        <button type="button" onClick={() => { setDone(null); setOpen(true); }} className={button}>
          <Upload className="size-3.5" /> Import memory…
        </button>
        {done && <p role="status" className="mt-1 text-xs text-[var(--muted-foreground)]">{done}</p>}
      </div>
    );
  }
  return (
    <section aria-label="Import memory" data-testid="memory-import" className="mx-3 mt-2 flex flex-col gap-2 rounded border border-violet-300 bg-violet-50/50 p-2 dark:border-violet-800 dark:bg-violet-950/30">
      <p className="text-xs text-[var(--muted-foreground)]">
        Paste what another assistant remembers about you (ask ChatGPT or Claude to list it), or pick a file: notes in
        markdown, or a .zip exported here. Claude sorts it into notes; each waits for you to accept.
      </p>
      <textarea
        aria-label="Memory to import"
        rows={5}
        value={text}
        disabled={!!file}
        onChange={(e) => setText(e.target.value)}
        className={cn(field, "text-xs")}
      />
      <input
        aria-label="Import file"
        type="file"
        accept=".md,.markdown,.txt,.zip,.json"
        onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        className="text-xs"
      />
      {error && <p role="alert" className="text-xs text-red-600">{error}</p>}
      <div className="flex gap-2">
        <button
          type="button"
          disabled={busy || (!file && !text.trim())}
          onClick={() => void submit()}
          className="rounded bg-[var(--primary)] px-3 py-1 text-xs text-[var(--primary-foreground)] disabled:opacity-50 cursor-pointer"
        >
          {busy ? "Importing…" : "Import"}
        </button>
        <button type="button" onClick={() => setOpen(false)} className="rounded px-3 py-1 text-xs hover:bg-[var(--secondary)] cursor-pointer">
          Cancel
        </button>
      </div>
    </section>
  );
}

function InstallRow({ install }: { install: PackInstall }) {
  const { reload } = useMemory();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    fn()
      .then(() => reload())
      .catch((err: Error) => setError(err.message))
      .finally(() => setBusy(false));
  };
  const place: Place = { scope: install.place.scope, nodeId: install.place.nodeId, groupId: install.place.groupId };
  return (
    <div data-testid="pack-install" data-pack={install.name} className="border-b border-[var(--border)] px-3 py-1.5 last:border-b-0">
      <div className="flex items-center gap-1.5 text-xs">
        <Package className="size-3.5 shrink-0 text-amber-600" />
        <span className="min-w-0 flex-1 truncate">
          <span className="font-medium">{install.name}</span> v{install.version} · {install.notes} notes
        </span>
        {install.canEdit && install.latest && (
          <button
            type="button"
            disabled={busy}
            title={`Update to version ${install.latest}`}
            aria-label={`Update ${install.name}`}
            onClick={() => run(() => call(packUrl(install.name, "install"), json("POST", { ...place, version: install.latest })))}
            className="rounded p-0.5 text-sky-700 hover:bg-[var(--secondary)] cursor-pointer"
          >
            <RefreshCw className="size-3.5" />
          </button>
        )}
        {install.canEdit && (
          <>
            <button
              type="button"
              disabled={busy}
              title="Fork: make its notes this place's own, to edit"
              aria-label={`Fork ${install.name}`}
              onClick={() => run(() => call(`/api/memory/installs/${install.id}/fork`, { method: "POST" }))}
              className="rounded p-0.5 hover:bg-[var(--secondary)] cursor-pointer"
            >
              <GitFork className="size-3.5" />
            </button>
            <button
              type="button"
              disabled={busy}
              title="Uninstall, with its notes"
              aria-label={`Uninstall ${install.name}`}
              onClick={() => {
                if (window.confirm(`Uninstall ${install.name} from ${install.place.label}? Its notes go with it.`)) {
                  run(() => call(`/api/memory/installs/${install.id}`, { method: "DELETE" }));
                }
              }}
              className="rounded p-0.5 text-red-600 hover:bg-[var(--secondary)] cursor-pointer"
            >
              <Trash2 className="size-3.5" />
            </button>
          </>
        )}
      </div>
      <p className="flex items-center gap-1 pl-5 text-[11px] text-[var(--muted-foreground)]">
        <PlaceIcon place={install.place} className="size-3" /> {install.place.label}
        {install.latest && ` · v${install.latest} is out`}
      </p>
      {error && <p role="alert" className="pl-5 text-xs text-red-600">{error}</p>}
    </div>
  );
}

/** The Memory view's packs part: what's installed where, and the way to the hub. */
export function InstalledPacks() {
  const { installs, openNote, targets } = useMemory();
  if (!installs.length && !targets.some((t) => t.canEdit)) return null;
  return (
    <section aria-label="Memory packs" data-testid="installed-packs" className="mt-3 border-t border-[var(--border)]">
      <div className="flex items-center gap-1.5 px-3 pt-2">
        <h3 className="flex flex-1 items-center gap-1.5 text-xs font-semibold">
          <Package className="size-3.5 text-amber-600" /> Memory packs ({installs.length})
        </h3>
        <button type="button" onClick={() => openNote(PACKS)} className={button}>
          <Search className="size-3" /> Browse
        </button>
      </div>
      <p className="px-3 pb-1 text-xs text-[var(--muted-foreground)]">
        Shared notes published on the hub. Installed ones start Manual for everyone.
      </p>
      {installs.map((i) => (
        <InstallRow key={i.id} install={i} />
      ))}
    </section>
  );
}

function PlacePicker({ places, value, onChange, label }: { places: SharedPlace[]; value: number; onChange: (i: number) => void; label: string }) {
  return (
    <select aria-label={label} value={value} onChange={(e) => onChange(Number(e.target.value))} className={cn(field, "max-w-xs text-xs")}>
      {places.map((p, i) => (
        <option key={placeKey(p)} value={i}>
          {p.label}
        </option>
      ))}
    </select>
  );
}

function PackView({ name, onChanged }: { name: string; onChanged: () => void }) {
  const { targets, installs, reload } = useMemory();
  const [pack, setPack] = useState<PackDetail | null>(null);
  const [version, setVersion] = useState<number | undefined>(undefined);
  const [place, setPlace] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const editable = targets.filter((t) => t.canEdit);

  const load = useCallback(async () => {
    const query = version === undefined ? "" : `?version=${version}`;
    setPack((await call<{ pack: PackDetail }>(`${packUrl(name)}${query}`)).pack);
  }, [name, version]);
  useEffect(() => {
    load().catch((err: Error) => setError(err.message));
  }, [load]);

  const run = async (fn: () => Promise<unknown>, message?: string) => {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      await fn();
      await Promise.all([load(), reload()]);
      onChanged();
      if (message) setDone(message);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (!pack) return <p className="text-sm text-[var(--muted-foreground)]">{error ?? "Loading…"}</p>;
  const v = pack.version;
  const target = editable[Math.min(place, editable.length - 1)];
  const installed = target && installs.find((i) => i.name === pack.name && placeKey(i.place) === placeKey(target));
  return (
    <section aria-label={`Pack ${pack.name}`} data-testid="pack-detail" className="flex flex-col gap-2 rounded border border-[var(--border)] p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Package className="size-4 text-amber-600" />
        <h3 className="font-semibold">{pack.name}</h3>
        <select
          aria-label="Version"
          value={v.version}
          onChange={(e) => setVersion(Number(e.target.value))}
          className="rounded border border-[var(--border)] bg-[var(--background)] px-1 py-0.5 text-xs"
        >
          {pack.versions.map((x) => (
            <option key={x.version} value={x.version}>
              v{x.version}
              {x.yanked ? " (yanked)" : ""}
            </option>
          ))}
        </select>
        {v.verified && (
          <span className="flex items-center gap-0.5 text-xs text-green-700">
            <BadgeCheck className="size-3.5" /> Verified
          </span>
        )}
        {v.yanked && <span className="text-xs text-red-600">Yanked{v.yankReason ? `: ${v.yankReason}` : ""}</span>}
      </div>
      <p className="text-sm">{v.description}</p>
      <p className="text-xs text-[var(--muted-foreground)]">
        By {pack.owner ?? "someone"} · v{v.version} published {when(v.publishedAt)}
        {v.publishedBy ? ` by ${v.publishedBy}` : ""} · {v.notes} notes
      </p>
      {v.flags.length > 0 && (
        <div role="note" className="rounded bg-amber-50 px-2 py-1 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-200">
          <p className="font-medium">Check before installing: the scan flagged {v.flags.length} {v.flags.length === 1 ? "thing" : "things"}</p>
          {v.flags.slice(0, 5).map((f, i) => (
            <p key={i}>
              {f.path}
              {f.line ? `:${f.line}` : ""}: {f.detail}
            </p>
          ))}
        </div>
      )}
      <div className="flex flex-col">
        {pack.notes.map((n) => (
          <details key={n.name} data-testid="pack-note" className="border-b border-[var(--border)] py-1 text-xs last:border-b-0">
            <summary className="cursor-pointer">
              <span className="font-medium">{n.name}</span> · {typeLabel(n.type)} · {n.description}
            </summary>
            <pre className="mt-1 whitespace-pre-wrap rounded bg-[var(--secondary)] p-1.5">{n.body}</pre>
          </details>
        ))}
      </div>
      {editable.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <PlacePicker places={editable} value={place} onChange={setPlace} label="Install to" />
          <button
            type="button"
            disabled={busy || (v.yanked && installed?.version !== v.version)}
            onClick={() =>
              void run(
                () => call(packUrl(pack.name, "install"), json("POST", { scope: target.scope, nodeId: target.nodeId, groupId: target.groupId, version: v.version })),
                `Installed v${v.version} in ${target.label}. Its notes are Manual for everyone; turn them on in the Memory panel.`,
              )
            }
            className="rounded bg-[var(--primary)] px-3 py-1 text-xs text-[var(--primary-foreground)] disabled:opacity-50 cursor-pointer"
          >
            {installed ? (installed.version === v.version ? "Installed" : `Move to v${v.version}`) : `Install v${v.version}`}
          </button>
        </div>
      )}
      {(pack.isAdmin || pack.mine) && (
        <div className="flex flex-wrap gap-2">
          {pack.isAdmin && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void run(() => call(packUrl(pack.name, "verify"), json("POST", { version: v.version, verified: !v.verified })))}
              className={button}
            >
              <BadgeCheck className="size-3.5" /> {v.verified ? "Unverify" : "Verify"}
            </button>
          )}
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              const reason = v.yanked ? "" : window.prompt(`Why yank v${v.version}? Places that have it keep it; nobody can newly install it.`);
              if (reason === null) return;
              void run(() => call(packUrl(pack.name, "yank"), json("POST", { version: v.version, yanked: !v.yanked, reason })));
            }}
            className={button}
          >
            <Ban className="size-3.5" /> {v.yanked ? "Unyank" : "Yank"}
          </button>
        </div>
      )}
      {error && <p role="alert" className="text-xs text-red-600">{error}</p>}
      {done && <p role="status" className="text-xs text-[var(--muted-foreground)]">{done}</p>}
    </section>
  );
}

/** Publishes a place's own shared notes as a pack (or its next version). */
function PublishPack({ onPublished }: { onPublished: (name: string) => void }) {
  const { targets } = useMemory();
  const editable = targets.filter((t) => t.canEdit);
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState(0);
  const [draft, setDraft] = useState({ name: "", description: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!editable.length) return null;
  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className={cn(button, "self-start")}>
        <Upload className="size-3.5" /> Publish a pack…
      </button>
    );
  }
  const target = editable[Math.min(place, editable.length - 1)];
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const made = await call<{ name: string; version: number; unchanged: boolean }>(
        packUrl(),
        json("POST", { scope: target.scope, nodeId: target.nodeId, groupId: target.groupId, ...draft, name: draft.name.trim() }),
      );
      setOpen(false);
      onPublished(made.name);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section aria-label="Publish a pack" data-testid="publish-pack" className="flex flex-col gap-2 rounded border border-amber-300 bg-amber-50/50 p-3 dark:border-amber-800 dark:bg-amber-950/30">
      <p className="text-xs text-[var(--muted-foreground)]">
        Publishes the place&apos;s own shared notes (not ones from other packs) for anyone on this server to install. Each
        publish is a new version; whoever publishes a name first owns it.
      </p>
      <label className="flex flex-col gap-1 text-xs font-medium">
        Notes from
        <PlacePicker places={editable} value={place} onChange={setPlace} label="Publish from" />
      </label>
      <label className="flex flex-col gap-1 text-xs font-medium">
        Pack name
        <input aria-label="Pack name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} className={cn(field, "max-w-xs")} />
      </label>
      <label className="flex flex-col gap-1 text-xs font-medium">
        Description
        <input aria-label="Pack description" value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} className={field} />
      </label>
      {error && <p role="alert" className="text-xs text-red-600">{error}</p>}
      <div className="flex gap-2">
        <button
          type="button"
          disabled={busy || !draft.name.trim() || !draft.description.trim()}
          onClick={() => void submit()}
          className="rounded bg-[var(--primary)] px-3 py-1 text-xs text-[var(--primary-foreground)] disabled:opacity-50 cursor-pointer"
        >
          Publish
        </button>
        <button type="button" onClick={() => setOpen(false)} className="rounded px-3 py-1 text-xs hover:bg-[var(--secondary)] cursor-pointer">
          Cancel
        </button>
      </div>
    </section>
  );
}

/** The middle pane's memory pack hub: find, read, install and publish packs. */
export function PackBrowser() {
  const [query, setQuery] = useState("");
  const [packs, setPacks] = useState<PackListing[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stamp, setStamp] = useState(0);

  useEffect(() => {
    let live = true;
    const timer = setTimeout(() => {
      call<{ packs: PackListing[] }>(`${packUrl()}?q=${encodeURIComponent(query)}`)
        .then((d) => live && (setPacks(d.packs), setError(null)))
        .catch((err: Error) => live && setError(err.message));
    }, 200);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [query, stamp]);

  return (
    <div data-testid="pack-browser" className="mx-auto flex max-w-3xl flex-col gap-3 p-6">
      <div className="flex items-center gap-2">
        <Package className="size-5 text-amber-600" />
        <h2 className="text-lg font-semibold">Memory packs</h2>
      </div>
      <p className="text-xs text-[var(--muted-foreground)]">
        Shared notes other places published: team conventions, project background, glossaries. Installing one adds its
        notes to a place you edit, pinned to that version and Manual for everyone, so nobody&apos;s chats change until
        someone turns them on.
      </p>
      <PublishPack
        onPublished={(name) => {
          setOpen(name);
          setStamp((s) => s + 1);
        }}
      />
      <input aria-label="Search packs" placeholder="Search packs" value={query} onChange={(e) => setQuery(e.target.value)} className={field} />
      {error && <p role="alert" className="text-xs text-red-600">{error}</p>}
      {packs && !packs.length && <p className="text-sm text-[var(--muted-foreground)]">No memory packs yet.</p>}
      {packs?.map((p) => (
        <div key={p.name} className="flex flex-col gap-2">
          <button
            type="button"
            data-testid="pack-row"
            data-pack={p.name}
            aria-expanded={open === p.name}
            onClick={() => setOpen((o) => (o === p.name ? null : p.name))}
            className="flex flex-col items-start gap-0.5 rounded border border-[var(--border)] px-3 py-2 text-left hover:bg-[var(--secondary)] cursor-pointer"
          >
            <span className="flex items-center gap-1.5 text-sm font-medium">
              {p.name}
              {p.latest && <span className="text-xs font-normal text-[var(--muted-foreground)]">v{p.latest.version} · {p.latest.notes} notes</span>}
              {p.latest?.verified && <BadgeCheck className="size-3.5 text-green-700" aria-label="Verified" />}
            </span>
            <span className="text-xs text-[var(--muted-foreground)]">
              {p.latest?.description ?? "Every version is yanked"} · by {p.mine ? "you" : (p.owner ?? "someone")}
            </span>
          </button>
          {open === p.name && <PackView name={p.name} onChanged={() => setStamp((s) => s + 1)} />}
        </div>
      ))}
    </div>
  );
}
