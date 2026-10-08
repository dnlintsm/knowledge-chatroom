"use client";

import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { FlaskConical, Search } from "lucide-react";
import { FileIcon } from "./file-icon";
import { experimentPlace, searchFiles, type SearchHit } from "./server-files";
import { useWorkspace } from "./store";
import { fileName } from "./types";
import { useWorkbench } from "./workbench";

/** Waits this long after typing stops before asking the server. */
const DEBOUNCE_MS = 250;

/** `text` with the query's words marked, case-insensitively. */
function highlight(text: string, query: string): ReactNode {
  const words = query
    .split(/\s+/)
    .map((w) => w.replace(/^[-"]+|"+$/g, ""))
    .filter((w) => w.length > 1 && w.toLowerCase() !== "or")
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (!words.length) return text;
  const parts = text.split(new RegExp(`(${words.join("|")})`, "gi"));
  return parts.map((part, i) =>
    i % 2 === 1 ? (
      <mark key={i} className="rounded-sm bg-amber-200/70 px-0.5 text-inherit dark:bg-amber-500/30">
        {part}
      </mark>
    ) : (
      <Fragment key={i}>{part}</Fragment>
    ),
  );
}

/** A snippet without markdown heading marks, which read as noise in one line. */
const plain = (snippet: string) => snippet.replace(/(^|\s)#{1,6}\s+/g, "$1");

/**
 * Search across every file the user can read: the workspace root, the
 * knowledge tree and the experiments they can see. Results near where the
 * user is come first; a click moves there and opens the file.
 */
export function SearchPanel() {
  const ws = useWorkspace();
  const { open } = useWorkbench().editor;
  const [query, setQuery] = useState("");
  const [here, setHere] = useState(false);
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const near = ws.experiment ? experimentPlace(ws.experiment.id) : ws.node;
  const scope = here ? ws.node : null;
  const scopeName = ws.lineage.at(-1)?.name;
  const server = ws.storageMode === "server";

  useEffect(() => inputRef.current?.focus(), []);

  useEffect(() => {
    const q = query.trim();
    if (!server || !q) {
      setHits(null);
      setError(null);
      setBusy(false);
      return;
    }
    const controller = new AbortController();
    setBusy(true);
    const timer = setTimeout(() => {
      searchFiles(q, { near, scope, signal: controller.signal })
        .then((results) => {
          setHits(results);
          setError(null);
        })
        .catch((err: Error) => {
          if (err.name !== "AbortError") setError(err.message);
        })
        .finally(() => {
          if (!controller.signal.aborted) setBusy(false);
        });
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, near, scope, server]);

  if (!server) {
    return (
      <p className="px-3 py-2 text-[var(--muted-foreground)]">
        Search needs server storage. Set DATABASE_URL for the agent (see the README) to search
        every file in the workspace.
      </p>
    );
  }

  const go = async (hit: SearchHit) => {
    const moving = hit.experiment
      ? hit.experiment !== ws.experiment?.id
      : hit.node !== ws.node || ws.experiment !== null;
    if (moving) {
      const entered = hit.experiment
        ? await ws.enterExperiment(hit.experiment)
        : await ws.enterNode(hit.node);
      if (!entered) {
        setError("That file's place is no longer there.");
        return;
      }
    }
    open(hit.path);
  };

  return (
    <div className="flex flex-col gap-2 px-3">
      <label className="flex items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--card)] px-2 focus-within:ring-2 focus-within:ring-[var(--ring)]">
        <Search className="size-4 shrink-0 text-[var(--muted-foreground)]" />
        <input
          ref={inputRef}
          type="search"
          aria-label="Search files"
          placeholder="Search files"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="h-8 min-w-0 flex-1 bg-transparent text-[13px] outline-none"
        />
      </label>
      {ws.node && (
        <label className="flex items-center gap-2 text-[12px] text-[var(--muted-foreground)]">
          <input type="checkbox" checked={here} onChange={(e) => setHere(e.target.checked)} />
          Only in {scopeName ?? "this node"} and below
        </label>
      )}

      {error && <p className="text-[12px] text-red-600">{error}</p>}
      {hits && !error && (
        <p aria-live="polite" className="text-[12px] text-[var(--muted-foreground)]">
          {hits.length === 0
            ? "No files match."
            : `${hits.length}${hits.length >= 20 ? "+" : ""} ${hits.length === 1 ? "file" : "files"}`}
          {busy && " · searching…"}
        </p>
      )}
      {!query.trim() && (
        <p className="text-[12px] text-[var(--muted-foreground)]">
          Finds words, and passages that mean the same, in every file you can read, including
          other nodes and shared experiments. Use &quot;quotes&quot; for an exact phrase and
          -word to leave a word out.
        </p>
      )}

      <ul aria-label="Search results" className="-mx-3 flex flex-col">
        {hits?.map((hit) => (
          <li key={`${hit.experiment ?? hit.node ?? ""}/${hit.path}`}>
            <button
              type="button"
              data-testid="search-result"
              onClick={() => void go(hit)}
              title={hit.path}
              className="flex w-full cursor-pointer flex-col gap-0.5 px-3 py-1.5 text-left hover:bg-[var(--secondary)]"
            >
              <span className="flex items-center gap-1.5">
                <FileIcon file={hit} className="size-3.5 shrink-0" />
                <span className="truncate font-medium">{highlight(fileName(hit.path), query)}</span>
                {hit.path.includes("/") && (
                  <span className="truncate text-[11px] text-[var(--muted-foreground)]">
                    {hit.path.slice(0, hit.path.lastIndexOf("/"))}
                  </span>
                )}
              </span>
              <span className="flex items-center gap-1 truncate text-[11px] text-[var(--muted-foreground)]">
                {hit.where.length ? hit.where.join(" › ") : "Workspace"}
                {hit.experimentTitle && (
                  <>
                    <span aria-hidden>›</span>
                    <FlaskConical className="size-3 shrink-0" aria-label="Experiment" />
                    <span className="truncate">{hit.experimentTitle}</span>
                  </>
                )}
              </span>
              {hit.match === "meaning" && (
                <span className="w-fit rounded bg-[var(--secondary)] px-1 text-[10px] uppercase tracking-wide text-[var(--muted-foreground)]">
                  Similar meaning
                </span>
              )}
              {hit.snippet && (
                <span className="line-clamp-3 text-[12px] leading-snug text-[var(--foreground)]/80">
                  {highlight(plain(hit.snippet), query)}
                </span>
              )}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
