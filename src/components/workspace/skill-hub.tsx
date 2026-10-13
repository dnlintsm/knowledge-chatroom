"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowLeft, BadgeCheck, Ban, Download, Flag, Search, ShieldAlert, Store, Upload } from "lucide-react";
import { cn } from "@/lib/utils";
import { Diff } from "./review-panel";
import { ScriptsBadge, useSkills, type SkillInfo } from "./skills";

/**
 * The skill hub in the Skills panel (issue #7, steps 3 and 4): browse and
 * install skills published on this deployment, publish the workspace's own,
 * update (after reviewing the diff) or fork installed ones, and move skills
 * in and out as .zip files. Each version shows what the publish check
 * flagged, whether a hub admin verified it, and whether it was yanked;
 * anyone can report a skill. The agent server checks every action.
 */

export interface Notice {
  kind: "ok" | "error";
  text: string;
}

type Notify = (notice: Notice) => void;

interface ScanFlag {
  kind: "scripts" | "network" | "large" | "binary" | "hidden-text" | "instructions";
  path: string;
  line: number | null;
  detail: string;
}

interface HubListing {
  name: string;
  description: string;
  argumentHint: string | null;
  needsExecution: boolean;
  publisher: string | null;
  mine: boolean;
  /** The newest version that isn't yanked; `verified`, `yanked` and `flags` are about it. */
  latest: number;
  verified: boolean;
  yanked: boolean;
  flags: number;
  updatedAt: string;
  installed: number | null;
  /** Open reports, shown to hub admins and the publisher. */
  reports: number | null;
}

interface HubVersion {
  version: number;
  publishedAt: string;
  publishedBy: string | null;
  files: number;
  size: number;
  verified: boolean;
  yanked: boolean;
  yankReason: string | null;
  flags: ScanFlag[];
}

interface HubDetail extends HubListing {
  versions: HubVersion[];
  version: number;
  skillMd: string;
  canModerate: boolean;
  canYank: boolean;
  openReports: { id: string; version: number | null; reason: string; reporter: string | null; createdAt: string }[] | null;
}

interface HubDiff {
  from: number;
  to: number;
  files: { path: string; change: "added" | "removed" | "changed"; before: string | null; after: string | null; binary: boolean }[];
  flags: ScanFlag[];
}

const FLAG_LABEL: Record<ScanFlag["kind"], string> = {
  scripts: "Script",
  network: "Network",
  large: "Large file",
  binary: "Binary file",
  "hidden-text": "Hidden text",
  instructions: "Odd instruction",
};

/** Calls the skills or hub API; throws the server's error message. */
async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { cache: "no-store", ...init });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error((body as { error?: string }).error ?? `Request failed (${res.status})`);
    (error as Error & { status: number }).status = res.status;
    throw error;
  }
  return body as T;
}

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** A version's standing: verified by a hub admin, yanked, and how many things the publish check flagged. */
export function TrustBadges({
  verified,
  yanked,
  yankReason,
  flags,
}: {
  verified: boolean;
  yanked: boolean;
  yankReason?: string | null;
  flags?: number;
}) {
  return (
    <>
      {verified && (
        <span
          data-testid="skill-verified"
          title="A hub admin checked this version"
          className="inline-flex shrink-0 items-center gap-0.5 text-[10px] font-medium text-emerald-700 dark:text-emerald-400"
        >
          <BadgeCheck className="size-3.5" /> Verified
        </span>
      )}
      {yanked && (
        <span
          data-testid="skill-yanked"
          title={`Its publisher withdrew this version${yankReason ? `: ${yankReason}` : ""}`}
          className="inline-flex shrink-0 items-center gap-0.5 text-[10px] font-medium text-red-600"
        >
          <Ban className="size-3.5" /> Yanked
        </span>
      )}
      {!!flags && (
        <span
          data-testid="skill-flags"
          title={`The publish check flagged ${flags} thing${flags === 1 ? "" : "s"} to look at`}
          className="inline-flex shrink-0 items-center gap-0.5 text-[10px] text-amber-600"
        >
          <ShieldAlert className="size-3.5" /> {flags}
        </span>
      )}
    </>
  );
}

/** What the publish check found, one line per flag. */
function FlagList({ flags }: { flags: ScanFlag[] }) {
  if (!flags.length) return <p className="text-[var(--muted-foreground)]">The publish check flagged nothing.</p>;
  return (
    <ul data-testid="hub-flags" className="flex flex-col gap-0.5">
      {flags.map((f, i) => (
        <li key={i} className="flex gap-1.5">
          <span className="shrink-0 font-medium text-amber-700 dark:text-amber-500">{FLAG_LABEL[f.kind]}</span>
          <span className="min-w-0 break-words text-[var(--muted-foreground)]">
            {f.path}
            {f.line !== null && `:${f.line}`} · {f.detail}
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * What moving an installed hub skill from one version to another changes, to
 * confirm before it happens (from the skill's row and from the hub alike).
 */
function UpdateReview({
  name,
  from: version,
  to: latest,
  onUpdate,
  onCancel,
  busy,
}: {
  name: string;
  from: number;
  to: number;
  onUpdate: () => void;
  onCancel: () => void;
  busy: boolean;
}) {
  const [diff, setDiff] = useState<HubDiff | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    call<HubDiff>(`/api/hub/${encodeURIComponent(name)}/diff?from=${version}&to=${latest}`)
      .then((d) => live && setDiff(d))
      .catch((err) => live && setError(message(err)));
    return () => {
      live = false;
    };
  }, [name, version, latest]);

  return (
    <div data-testid="skill-update-review" className="mt-2 rounded border border-[var(--border)] text-xs">
      <p className="border-b border-[var(--border)] px-2 py-1 font-medium">
        v{version} → v{latest}
      </p>
      {error && <p className="px-2 py-1 text-red-600">{error}</p>}
      {diff && (
        <>
          <div className="px-2 py-1.5">
            <FlagList flags={diff.flags} />
          </div>
          {diff.files.length === 0 && <p className="px-2 pb-1.5 text-[var(--muted-foreground)]">No file changes.</p>}
          {/* The pane is narrow: let long words (links) wrap instead of widening the table. */}
          <div className="max-h-80 overflow-auto [&_td]:[overflow-wrap:anywhere]">
            {diff.files.map((f) => (
              <div key={f.path} className="border-t border-[var(--border)]">
                <p className="px-2 py-1 font-mono text-[11px]">
                  {f.path} <span className="text-[var(--muted-foreground)]">({f.change})</span>
                </p>
                {f.binary ? (
                  <p className="px-2 pb-1 text-[var(--muted-foreground)]">Not text, so not shown.</p>
                ) : (
                  <Diff before={f.before ?? ""} after={f.after ?? ""} />
                )}
              </div>
            ))}
          </div>
        </>
      )}
      <div className="flex justify-end gap-2 border-t border-[var(--border)] px-2 py-1.5">
        <button type="button" onClick={onCancel} className={linkButton}>
          Cancel
        </button>
        <button
          type="button"
          data-testid="skill-update-confirm"
          disabled={busy || !diff}
          onClick={onUpdate}
          className="rounded border border-[var(--border)] px-2 py-0.5 font-medium hover:bg-[var(--secondary)] cursor-pointer disabled:opacity-50"
        >
          {latest > version ? "Update" : "Switch"} to v{latest}
        </button>
      </div>
    </div>
  );
}

const linkButton =
  "text-[var(--muted-foreground)] underline-offset-2 hover:text-[var(--foreground)] hover:underline cursor-pointer disabled:cursor-wait disabled:opacity-50";

/** "Browse hub" and "Import .zip" above the skills list. */
export function SkillsToolbar({ onBrowse, notify }: { onBrowse: () => void; notify: Notify }) {
  const { hub, canSetDefaults, reload } = useSkills();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  if (!hub) return null;

  const importZip = async (file: File, replace = false): Promise<void> => {
    setBusy(true);
    try {
      const query = new URLSearchParams({ filename: file.name, ...(replace ? { replace: "1" } : {}) });
      const added = await call<{ name: string; files: number }>(`/api/skills/import?${query}`, {
        method: "POST",
        headers: { "Content-Type": "application/zip" },
        body: file,
      });
      notify({ kind: "ok", text: `Imported ${added.name} into skills/${added.name}/.` });
      await reload();
    } catch (err) {
      if ((err as { status?: number }).status === 409 && confirm(`${message(err)}. Replace it with the zip's files?`)) {
        return importZip(file, true);
      }
      notify({ kind: "error", text: message(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center gap-1.5 px-3 pb-2 text-xs">
      <button
        type="button"
        data-testid="hub-browse"
        onClick={onBrowse}
        className="inline-flex items-center gap-1 rounded border border-[var(--border)] px-2 py-0.5 hover:bg-[var(--secondary)] cursor-pointer"
      >
        <Store className="size-3.5" /> Browse hub
      </button>
      {canSetDefaults && (
        <>
          <button
            type="button"
            data-testid="skill-import"
            disabled={busy}
            title="Add a skill from a .zip with a SKILL.md (Claude Code / Agent Skills layout)"
            onClick={() => input.current?.click()}
            className="inline-flex items-center gap-1 rounded border border-[var(--border)] px-2 py-0.5 hover:bg-[var(--secondary)] cursor-pointer disabled:opacity-50"
          >
            <Upload className="size-3.5" /> Import .zip
          </button>
          <input
            ref={input}
            type="file"
            accept=".zip,application/zip"
            data-testid="skill-import-file"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) void importZip(file);
            }}
          />
        </>
      )}
    </div>
  );
}

/** A skill row's actions: export; publish (workspace skills); update, fork, remove (hub skills). */
export function SkillActions({ skill, notify }: { skill: SkillInfo; notify: Notify }) {
  const { hub, canSetDefaults, canPublish, reload } = useSkills();
  const [busy, setBusy] = useState(false);
  const [reviewing, setReviewing] = useState(false);

  const run = async (action: () => Promise<string>) => {
    setBusy(true);
    try {
      notify({ kind: "ok", text: await action() });
      setReviewing(false);
      await reload();
    } catch (err) {
      notify({ kind: "error", text: message(err) });
    } finally {
      setBusy(false);
    }
  };
  const name = encodeURIComponent(skill.name);

  return (
    <>
      {skill.hub?.yanked && (
        <p className="mt-1 text-xs text-red-600">
          This version was yanked{skill.hub.yankReason ? `: ${skill.hub.yankReason}` : ""}. It still works; update or remove
          it.
        </p>
      )}
      <div className="mt-1 flex flex-wrap items-center gap-x-2.5 text-xs">
        <a
          href={`/api/skills/${name}/export`}
          download={`${skill.name}.zip`}
          title="Download as a .zip (works in Claude Code too)"
          className={cn(linkButton, "inline-flex items-center gap-0.5")}
        >
          <Download className="size-3" /> Export
        </a>
        {hub && skill.source === "workspace" && canPublish && (
          <button
            type="button"
            data-testid="skill-publish"
            disabled={busy}
            title="Publish this version to the hub, for anyone on this deployment to install"
            onClick={() =>
              void run(async () => {
                const out = await call<{ version: number; unchanged: boolean }>("/api/hub", json("POST", { skill: skill.name }));
                return out.unchanged
                  ? `${skill.name} hasn't changed since v${out.version} on the hub.`
                  : `Published ${skill.name} v${out.version} to the hub.`;
              })
            }
            className={linkButton}
          >
            Publish
          </button>
        )}
        {skill.hub && canSetDefaults && (
          <>
            {skill.hub.latest > skill.hub.version && (
              <button
                type="button"
                data-testid="skill-update"
                disabled={busy}
                title="See what changes first"
                onClick={() => setReviewing((r) => !r)}
                className={cn(linkButton, "text-[var(--foreground)] font-medium")}
              >
                Update to v{skill.hub.latest}
              </button>
            )}
            <button
              type="button"
              data-testid="skill-fork"
              disabled={busy}
              title="Copy it into the workspace's skills/ to change it there"
              onClick={() =>
                void run(async () => {
                  await call(`/api/hub/${name}/fork`, { method: "POST" });
                  return `Forked ${skill.name} into skills/${skill.name}/.`;
                })
              }
              className={linkButton}
            >
              Fork
            </button>
            <button
              type="button"
              data-testid="skill-uninstall"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await call(`/api/hub/${name}/install`, { method: "DELETE" });
                  return `Removed ${skill.name}.`;
                })
              }
              className={linkButton}
            >
              Remove
            </button>
          </>
        )}
      </div>
      {reviewing && skill.hub && (
        <UpdateReview
          name={skill.name}
          from={skill.hub.version}
          to={skill.hub.latest}
          busy={busy}
          onCancel={() => setReviewing(false)}
          onUpdate={() =>
            void run(async () => {
              await call(`/api/hub/${name}/install`, json("PUT", { version: skill.hub!.latest }));
              return `Updated ${skill.name} to v${skill.hub!.latest}.`;
            })
          }
        />
      )}
    </>
  );
}

/** Searches the hub and installs from it. */
export function HubBrowser({ onClose, notify }: { onClose: () => void; notify: Notify }) {
  const { reload } = useSkills();
  const [query, setQuery] = useState("");
  const [state, setState] = useState<{ skills: HubListing[]; canInstall: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<HubDetail | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  /** A version change waiting on the user's look at the diff. */
  const [reviewing, setReviewing] = useState<{ name: string; from: number; to: number } | null>(null);

  useEffect(() => {
    let live = true;
    const timer = setTimeout(async () => {
      try {
        const list = await call<{ skills: HubListing[]; canInstall: boolean }>(`/api/hub?q=${encodeURIComponent(query)}`);
        if (live) {
          setState(list);
          setError(null);
        }
      } catch (err) {
        if (live) setError(message(err));
      }
    }, query ? 250 : 0);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [query, tick]);

  /** Installs; moving an existing install to another version shows its diff first. */
  const install = async (name: string, version: number, installed: number | null, reviewed = false) => {
    if (installed !== null && installed !== version && !reviewed) {
      setReviewing({ name, from: installed, to: version });
      return;
    }
    setReviewing(null);
    setBusy(name);
    try {
      const out = await call<{ version: number }>(`/api/hub/${encodeURIComponent(name)}/install`, json("PUT", { version }));
      notify({ kind: "ok", text: `Installed ${name} v${out.version}. It starts as Manual: type /${name} to run it.` });
      await reload();
      setTick((t) => t + 1);
      if (open?.name === name) setOpen({ ...open, installed: out.version });
    } catch (err) {
      notify({ kind: "error", text: message(err) });
    } finally {
      setBusy(null);
    }
  };

  const review = (name: string) =>
    reviewing?.name === name && (
      <UpdateReview
        name={name}
        from={reviewing.from}
        to={reviewing.to}
        busy={busy === name}
        onCancel={() => setReviewing(null)}
        onUpdate={() => void install(name, reviewing.to, reviewing.from, true)}
      />
    );

  const details = async (name: string, version?: number) => {
    setReviewing(null);
    try {
      const query = version ? `?version=${version}` : "";
      setOpen(await call<HubDetail>(`/api/hub/${encodeURIComponent(name)}${query}`));
    } catch (err) {
      notify({ kind: "error", text: message(err) });
    }
  };

  /** Verify, yank, report or dismiss on the open skill, then show it again. */
  const moderate = async (done: string, path: string, init: RequestInit) => {
    if (!open) return;
    setBusy(open.name);
    try {
      await call(`/api/hub/${encodeURIComponent(open.name)}/${path}`, init);
      notify({ kind: "ok", text: done });
      await details(open.name, open.version);
      setTick((t) => t + 1);
      await reload();
    } catch (err) {
      notify({ kind: "error", text: message(err) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div data-testid="hub-browser" className="flex flex-col">
      <div className="flex items-center gap-1.5 px-3 pb-2">
        <button
          type="button"
          aria-label="Back to your skills"
          onClick={open ? () => setOpen(null) : onClose}
          className="rounded p-0.5 hover:bg-[var(--secondary)] cursor-pointer"
        >
          <ArrowLeft className="size-4" />
        </button>
        {open ? (
          <span className="font-medium">{open.name}</span>
        ) : (
          <label className="flex min-w-0 flex-1 items-center gap-1 rounded border border-[var(--border)] px-1.5">
            <Search className="size-3.5 shrink-0 text-[var(--muted-foreground)]" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search the hub"
              aria-label="Search the hub"
              className="min-w-0 flex-1 bg-transparent py-0.5 text-xs outline-none"
            />
          </label>
        )}
      </div>

      {error && <p className="px-3 py-2 text-xs text-red-600">{error}</p>}
      {!open && state && state.skills.length === 0 && (
        <p className="px-3 py-2 text-xs text-[var(--muted-foreground)]">
          {query
            ? "No skills on the hub match that."
            : "Nothing on the hub yet. Owners publish a workspace skill from its row in your skills."}
        </p>
      )}

      {open ? (
        <div className="px-3 text-xs">
          <p className="text-[var(--muted-foreground)]">{open.description}</p>
          <p className="mt-1 flex flex-wrap items-center gap-x-1.5 text-[var(--muted-foreground)]">
            <span>
              By {open.publisher ?? "someone"} · v{open.latest}
              {open.installed !== null && ` · installed v${open.installed}`}
            </span>
            <button
              type="button"
              data-testid="hub-report"
              disabled={busy === open.name}
              onClick={() => {
                const reason = prompt(`What's wrong with ${open.name}? Its publisher and the hub admins will see this.`);
                if (reason?.trim()) {
                  void moderate("Reported. Thanks for flagging it.", "reports", json("POST", { reason, version: open.version }));
                }
              }}
              className={cn(linkButton, "ml-auto inline-flex items-center gap-0.5")}
            >
              <Flag className="size-3" /> Report
            </button>
          </p>
          <ul className="mt-2 flex flex-col gap-1" aria-label="Versions">
            {open.versions.map((v) => (
              <li key={v.version} data-testid="hub-version" data-version={v.version} className="flex flex-wrap items-center gap-x-2">
                <button
                  type="button"
                  onClick={() => void details(open.name, v.version)}
                  className={cn("cursor-pointer hover:underline", v.version === open.version && "font-medium")}
                >
                  v{v.version}
                </button>
                <span className="min-w-0 truncate text-[var(--muted-foreground)]">
                  {new Date(v.publishedAt).toLocaleDateString()} · {v.files} file{v.files === 1 ? "" : "s"}
                </span>
                <TrustBadges verified={v.verified} yanked={v.yanked} yankReason={v.yankReason} flags={v.flags.length} />
                <span className="ml-auto flex items-center gap-2">
                  {open.canModerate && (
                    <button
                      type="button"
                      data-testid="hub-verify"
                      disabled={busy === open.name}
                      title={v.verified ? "Take back the verification" : "Mark this version as checked by a hub admin"}
                      onClick={() =>
                        void moderate(
                          v.verified ? `v${v.version} is no longer verified.` : `Verified v${v.version}.`,
                          "verify",
                          json("POST", { version: v.version, verified: !v.verified }),
                        )
                      }
                      className={linkButton}
                    >
                      {v.verified ? "Unverify" : "Verify"}
                    </button>
                  )}
                  {open.canYank && (
                    <button
                      type="button"
                      data-testid="hub-yank"
                      disabled={busy === open.name}
                      title={v.yanked ? "Let it be installed again" : "Stop new installs of this version; installs of it keep working"}
                      onClick={() => {
                        if (v.yanked) {
                          void moderate(`Restored v${v.version}.`, "yank", json("POST", { version: v.version, yanked: false }));
                          return;
                        }
                        const reason = prompt(`Why yank v${v.version}? Workspaces that have it will see this.`);
                        if (reason !== null) {
                          void moderate(`Yanked v${v.version}.`, "yank", json("POST", { version: v.version, yanked: true, reason }));
                        }
                      }}
                      className={linkButton}
                    >
                      {v.yanked ? "Restore" : "Yank"}
                    </button>
                  )}
                  {state?.canInstall &&
                    (open.installed === v.version ? (
                      <span className="text-[var(--muted-foreground)]">Installed</span>
                    ) : v.yanked ? null : (
                      <button
                        type="button"
                        disabled={busy === open.name}
                        data-testid="hub-install-version"
                        onClick={() => void install(open.name, v.version, open.installed)}
                        className={linkButton}
                      >
                        Install v{v.version}
                      </button>
                    ))}
                </span>
              </li>
            ))}
          </ul>
          {review(open.name)}
          {open.openReports && open.openReports.length > 0 && (
            <div data-testid="hub-reports" className="mt-3">
              <p className="mb-1 font-medium text-amber-700 dark:text-amber-500">
                Open reports ({open.openReports.length})
              </p>
              <ul className="flex flex-col gap-1">
                {open.openReports.map((r) => (
                  <li key={r.id} className="flex gap-2">
                    <span className="min-w-0 flex-1 break-words">
                      {r.reason}
                      <span className="text-[var(--muted-foreground)]">
                        {" "}
                        · {r.reporter ?? "someone"}
                        {r.version !== null && `, on v${r.version}`}
                      </span>
                    </span>
                    {open.canModerate && (
                      <button
                        type="button"
                        disabled={busy === open.name}
                        onClick={() =>
                          void moderate("Dismissed the report.", `reports?id=${encodeURIComponent(r.id)}`, {
                            method: "DELETE",
                          })
                        }
                        className={cn(linkButton, "shrink-0")}
                      >
                        Dismiss
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <p className="mt-3 mb-1 text-[var(--muted-foreground)]">Publish check (v{open.version})</p>
          <FlagList flags={open.versions.find((v) => v.version === open.version)?.flags ?? []} />
          <p className="mt-3 mb-1 text-[var(--muted-foreground)]">SKILL.md (v{open.version})</p>
          <pre
            data-testid="hub-skill-md"
            className="max-h-80 overflow-auto whitespace-pre-wrap rounded bg-[var(--secondary)] p-2 font-mono text-[11px]"
          >
            {open.skillMd}
          </pre>
        </div>
      ) : (
        state?.skills.map((skill) => (
          <div
            key={skill.name}
            data-testid="hub-skill"
            data-skill={skill.name}
            className="border-b border-[var(--border)] px-3 py-2 last:border-b-0"
          >
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => void details(skill.name)}
                className="min-w-0 truncate font-medium hover:underline cursor-pointer"
              >
                {skill.name}
              </button>
              <span className="shrink-0 text-xs text-[var(--muted-foreground)]">v{skill.latest}</span>
              <TrustBadges verified={skill.verified} yanked={skill.yanked} flags={skill.flags} />
              {skill.needsExecution && <ScriptsBadge />}
              <span className="ml-auto shrink-0 text-xs">
                {skill.installed === skill.latest ? (
                  <span className="text-[var(--muted-foreground)]">Installed</span>
                ) : skill.yanked ? null : state.canInstall ? (
                  <button
                    type="button"
                    data-testid="hub-install"
                    disabled={busy === skill.name}
                    onClick={() => void install(skill.name, skill.latest, skill.installed)}
                    className="rounded border border-[var(--border)] px-2 py-0.5 hover:bg-[var(--secondary)] cursor-pointer disabled:opacity-50"
                  >
                    {skill.installed === null ? "Install" : `Update to v${skill.latest}`}
                  </button>
                ) : null}
              </span>
            </div>
            {skill.description && (
              <p className="mt-0.5 line-clamp-2 text-xs text-[var(--muted-foreground)]">{skill.description}</p>
            )}
            {review(skill.name)}
            <p className="mt-0.5 text-[11px] text-[var(--muted-foreground)]">
              By {skill.mine ? "you" : (skill.publisher ?? "someone")}
              {!!skill.reports && (
                <span className="text-amber-700 dark:text-amber-500">
                  {" "}
                  · {skill.reports} open report{skill.reports === 1 ? "" : "s"}
                </span>
              )}
            </p>
          </div>
        ))
      )}
    </div>
  );
}
