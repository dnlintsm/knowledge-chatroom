"use client";

import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import { Lock } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog } from "./create-workspace";
import { importFolder, type FolderImport } from "./folder-import";
import { formatSize } from "./review-panel";
import { useWorkspace } from "./store";
import { lineageOf } from "./workspace-context";

const ROOT = "";

/**
 * Import as Experiment, from a folder in Files (docs/experiment-runs.md): a
 * preview of what the new Experiment will hold, where it goes and who sees
 * it, then the import. Copy keeps the folder; Move and the pointer file need
 * Can edit where the folder is, and say so when you don't have it.
 */
export function ImportFolderDialog({
  node,
  folder,
  onClose,
}: {
  node: string | null;
  folder: string;
  onClose: () => void;
}) {
  const ws = useWorkspace();
  const ids = useId();
  const [destination, setDestination] = useState<string>(node ?? ROOT);
  const [preview, setPreview] = useState<FolderImport | null>(null);
  const [title, setTitle] = useState<string | null>(null);
  const [hypothesis, setHypothesis] = useState("");
  const [shared, setShared] = useState(false);
  const [move, setMove] = useState(false);
  const [pointer, setPointer] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const asked = useRef(0);

  // The preview again for each destination: whether a restriction travels depends on it.
  useEffect(() => {
    const ask = ++asked.current;
    setError(null);
    importFolder({ node, folder, destination: destination || null }, true).then(
      (answer) => {
        if (ask !== asked.current) return;
        setPreview(answer);
        setTitle((t) => t ?? answer.title);
      },
      (err: unknown) => ask === asked.current && setError(err instanceof Error ? err.message : String(err)),
    );
  }, [node, folder, destination]);

  // Anywhere you can see: the root when you have a role there, and the nodes you have one on.
  const destinations = useMemo(() => {
    const list = ws.nodes
      .filter((n) => n.role !== null)
      .map((n) => ({
        id: n.id,
        label: lineageOf(ws.nodes, n.id)
          .map((a) => a.name)
          .join(" / "),
      }))
      .sort((a, b) => a.label.localeCompare(b.label));
    return ws.rootRole !== null ? [{ id: ROOT, label: "The workspace" }, ...list] : list;
  }, [ws.nodes, ws.rootRole]);

  const blocked = preview?.restricted && !preview.restricted.fullAccess;
  const name = folder.split("/").pop() ?? folder;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!preview || blocked || busy) return;
    setBusy(true);
    setError(null);
    try {
      await ws.importFolder({
        node,
        folder,
        destination: destination || null,
        title: (title ?? "").trim() || preview.title,
        hypothesis: hypothesis.trim() || undefined,
        status: shared ? "shared" : "draft",
        move: move && preview.canMove,
        pointer: pointer && preview.canPoint,
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  const total = preview?.files.reduce((sum, f) => sum + f.size, 0) ?? 0;
  const params = Object.entries(preview?.params ?? {});
  const placeLabel =
    destination === ROOT ? "the workspace" : (destinations.find((d) => d.id === destination)?.label ?? "there");
  return (
    <Dialog label={`Import ${name} as an Experiment`} onClose={() => !busy && onClose()} wide>
      <form onSubmit={submit} className="space-y-4 text-sm" aria-busy={!preview}>
        <label className="block">
          <span className="mb-1 block text-xs font-medium">Title</span>
          <input
            value={title ?? ""}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={200}
            placeholder={preview?.title ?? name}
            className="h-8 w-full rounded border border-[var(--border)] bg-[var(--background)] px-2 outline-none focus:border-[var(--ring)]"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium">Hypothesis</span>
          <textarea
            value={hypothesis}
            onChange={(e) => setHypothesis(e.target.value)}
            rows={2}
            placeholder="Optional: what this experiment asks"
            className="w-full rounded border border-[var(--border)] bg-[var(--background)] px-2 py-1 outline-none focus:border-[var(--ring)]"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium">Destination</span>
          <select
            value={destination}
            onChange={(e) => setDestination(e.target.value)}
            className="h-8 w-full rounded border border-[var(--border)] bg-[var(--background)] px-1.5 outline-none focus:border-[var(--ring)]"
          >
            {destinations.map((d) => (
              <option key={d.id} value={d.id}>
                {d.label}
              </option>
            ))}
          </select>
        </label>

        {preview?.restricted && (
          <p
            role="note"
            data-testid="import-restriction"
            className="flex gap-2 rounded border border-[var(--border)] bg-[var(--secondary)] p-2 text-xs"
          >
            <Lock className="mt-0.5 size-3.5 shrink-0" />
            <span>
              {name} is inside {preview.restricted.name}, which is restricted. Importing it to {placeLabel} opens its
              content to everyone who can see there.{" "}
              {preview.restricted.fullAccess
                ? "You have Full access there, so you can."
                : `It needs Full access on ${preview.restricted.name}; choose a destination inside it instead.`}
            </span>
          </p>
        )}

        <fieldset>
          <legend className="mb-1 text-xs font-medium">Who sees it</legend>
          <label className="flex items-center gap-2 py-0.5">
            <input type="radio" name={`${ids}-status`} checked={!shared} onChange={() => setShared(false)} />
            Draft: only you
          </label>
          <label className="flex items-center gap-2 py-0.5">
            <input type="radio" name={`${ids}-status`} checked={shared} onChange={() => setShared(true)} />
            Shared: everyone who can see {placeLabel}
          </label>
        </fieldset>

        <section aria-label="Planned parameters">
          <h3 className="mb-1 text-xs font-medium">Planned parameters</h3>
          {params.length ? (
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 font-mono text-xs">
              {params.map(([key, value]) => (
                <div key={key} className="contents">
                  <dt className="text-[var(--muted-foreground)]">{key}</dt>
                  <dd className="truncate">{typeof value === "string" ? value : JSON.stringify(value)}</dd>
                </div>
              ))}
            </dl>
          ) : (
            <p className="text-xs text-[var(--muted-foreground)]">
              None. A params.json at the top of the folder gives each new run its parameters.
            </p>
          )}
        </section>

        <section aria-label="Files it will hold">
          <h3 className="mb-1 text-xs font-medium">
            {preview
              ? `${preview.files.length} ${preview.files.length === 1 ? "file" : "files"}, ${formatSize(total)}`
              : "Files"}
          </h3>
          {!preview ? (
            <p className="text-xs text-[var(--muted-foreground)]">{error ? "" : "Reading the folder…"}</p>
          ) : (
            <ul className="max-h-40 overflow-y-auto rounded border border-[var(--border)] text-xs">
              {preview.files.map((f) => (
                <li
                  key={f.path}
                  data-testid="import-file"
                  className="flex justify-between gap-3 px-2 py-0.5 odd:bg-[var(--secondary)]/50"
                >
                  <span className="truncate font-mono">{f.path}</span>
                  <span className="shrink-0 text-[var(--muted-foreground)]">{formatSize(f.size)}</span>
                </li>
              ))}
            </ul>
          )}
          {preview && preview.skipped.length > 0 && (
            <p className="mt-1 text-xs text-[var(--muted-foreground)]" title={preview.skipped.join("\n")}>
              {preview.skipped.length} left out, larger than an upload may be: {preview.skipped.join(", ")}
            </p>
          )}
        </section>

        <fieldset>
          <legend className="mb-1 text-xs font-medium">The folder</legend>
          <label className="flex items-start gap-2 py-0.5">
            <input
              type="radio"
              className="mt-1"
              name={`${ids}-keep`}
              checked={!move}
              onChange={() => setMove(false)}
            />
            <span>
              Copy
              <span className="block text-xs text-[var(--muted-foreground)]">The folder stays as it is.</span>
            </span>
          </label>
          <label className="flex items-start gap-2 py-0.5">
            <input
              type="radio"
              className="mt-1"
              name={`${ids}-keep`}
              checked={move}
              disabled={!preview?.canMove}
              onChange={() => setMove(true)}
            />
            <span className={preview?.canMove ? "" : "text-[var(--muted-foreground)]"}>
              Move
              <span className="block text-xs text-[var(--muted-foreground)]">
                {preview && !preview.canMove
                  ? "Needs Can edit where the folder is."
                  : "The files it imports leave the folder, keeping their history; files left out stay."}
              </span>
            </span>
          </label>
          <label className="mt-1 flex items-start gap-2 py-0.5">
            <input
              type="checkbox"
              className="mt-1"
              checked={pointer && !!preview?.canPoint}
              disabled={!preview?.canPoint}
              onChange={(e) => setPointer(e.target.checked)}
            />
            <span className={preview?.canPoint ? "" : "text-[var(--muted-foreground)]"}>
              Leave an EXPERIMENT.md in the folder that links to it
              {preview && !preview.canPoint && (
                <span className="block text-xs text-[var(--muted-foreground)]">
                  Needs Can edit where the folder is.
                </span>
              )}
            </span>
          </label>
        </fieldset>

        {error && (
          <p role="alert" className="text-xs text-[var(--destructive)]">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={!preview || !!blocked || busy}>
            {busy ? "Importing…" : move ? "Move into an Experiment" : "Import"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
