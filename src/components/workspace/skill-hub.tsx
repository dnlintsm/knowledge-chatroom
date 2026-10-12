"use client";

import { useEffect, useRef, useState } from "react";
import { AlertTriangle, ArrowLeft, Download, Search, Store, Upload } from "lucide-react";
import { cn } from "@/lib/utils";
import { useSkills, type SkillInfo } from "./skills";

/**
 * The skill hub in the Skills panel (issue #7, step 3): browse and install
 * skills published on this deployment, publish the workspace's own, update
 * or fork installed ones, and move skills in and out as .zip files. The
 * agent server checks every action against the user's role.
 */

export interface Notice {
  kind: "ok" | "error";
  text: string;
}

type Notify = (notice: Notice) => void;

interface HubListing {
  name: string;
  description: string;
  argumentHint: string | null;
  needsExecution: boolean;
  publisher: string | null;
  mine: boolean;
  latest: number;
  updatedAt: string;
  installed: number | null;
}

interface HubDetail extends HubListing {
  versions: { version: number; publishedAt: string; publishedBy: string | null; files: number; size: number }[];
  version: number;
  skillMd: string;
}

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

  const run = async (action: () => Promise<string>) => {
    setBusy(true);
    try {
      notify({ kind: "ok", text: await action() });
      await reload();
    } catch (err) {
      notify({ kind: "error", text: message(err) });
    } finally {
      setBusy(false);
    }
  };
  const name = encodeURIComponent(skill.name);

  return (
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
              onClick={() =>
                void run(async () => {
                  await call(`/api/hub/${name}/install`, json("PUT", { version: skill.hub!.latest }));
                  return `Updated ${skill.name} to v${skill.hub!.latest}.`;
                })
              }
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

  const install = async (name: string, version?: number) => {
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

  const details = async (name: string, version?: number) => {
    try {
      const query = version ? `?version=${version}` : "";
      setOpen(await call<HubDetail>(`/api/hub/${encodeURIComponent(name)}${query}`));
    } catch (err) {
      notify({ kind: "error", text: message(err) });
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
          <p className="mt-1 text-[var(--muted-foreground)]">
            By {open.publisher ?? "someone"} · v{open.latest}
            {open.installed !== null && ` · installed v${open.installed}`}
          </p>
          <ul className="mt-2 flex flex-col gap-1" aria-label="Versions">
            {open.versions.map((v) => (
              <li key={v.version} className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => void details(open.name, v.version)}
                  className={cn("cursor-pointer hover:underline", v.version === open.version && "font-medium")}
                >
                  v{v.version}
                </button>
                <span className="min-w-0 flex-1 truncate text-[var(--muted-foreground)]">
                  {new Date(v.publishedAt).toLocaleDateString()} · {v.files} file{v.files === 1 ? "" : "s"}
                </span>
                {state?.canInstall &&
                  (open.installed === v.version ? (
                    <span className="text-[var(--muted-foreground)]">Installed</span>
                  ) : (
                    <button
                      type="button"
                      disabled={busy === open.name}
                      onClick={() => void install(open.name, v.version)}
                      className={linkButton}
                    >
                      Install v{v.version}
                    </button>
                  ))}
              </li>
            ))}
          </ul>
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
              {skill.needsExecution && (
                <span
                  title="It ships scripts or asks for a shell; skills here are instructions only, so those parts won't run."
                  className="shrink-0 text-amber-600"
                >
                  <AlertTriangle className="size-3.5" />
                </span>
              )}
              <span className="ml-auto shrink-0 text-xs">
                {skill.installed === skill.latest ? (
                  <span className="text-[var(--muted-foreground)]">Installed</span>
                ) : state.canInstall ? (
                  <button
                    type="button"
                    data-testid="hub-install"
                    disabled={busy === skill.name}
                    onClick={() => void install(skill.name)}
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
            <p className="mt-0.5 text-[11px] text-[var(--muted-foreground)]">
              By {skill.mine ? "you" : (skill.publisher ?? "someone")}
            </p>
          </div>
        ))
      )}
    </div>
  );
}
