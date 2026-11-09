"use client";

import { useState } from "react";
import { BookOpen, Check, ExternalLink, FileText, MessageSquareQuote, Save } from "lucide-react";
import { ToolReasoning } from "@/components/tool-rendering";
import { Spinner } from "@/components/ui/spinner";
import { useStepHidden } from "./agent-steps-view";
import { cn } from "@/lib/utils";
import { useWorkspace } from "./store";
import { parsePaperResult, splitToolName, PAPER_CARD_TOOLS, type PaperInfo } from "./tool-chips";
import { useToolMenu } from "./tool-menu";
import { useWorkbench } from "./workbench";

/**
 * Paper search results in the chat (issue #151): what search_papers,
 * related_papers and get_paper return, from any server that follows the paper
 * tool contract (services/papers-mcp). Each card can save the paper into the
 * workspace, put a question about it in the message box, or open it.
 */

interface ToolCallView {
  name: string;
  status: string;
  parameters: unknown;
  result: string | undefined;
}

/** A card for a paper tool's call, or null for other tools. */
export function renderPaperTool(call: ToolCallView) {
  const split = splitToolName(call.name);
  if (!split || !PAPER_CARD_TOOLS.has(split.tool)) return null;
  return <PaperToolCard server={split.server} tool={split.tool} {...call} />;
}

const plural = (n: number, word: string) => `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;

function PaperToolCard({ server, tool, name, status, parameters, result }: ToolCallView & { server: string; tool: string }) {
  const args = (parameters && typeof parameters === "object" ? parameters : {}) as Record<string, unknown>;
  const query = typeof args.query === "string" ? args.query : "";
  // In a closed steps block, the block's header says it is searching (issue #154).
  const hidden = useStepHidden();
  if (status !== "complete") {
    if (hidden) return null;
    const doing =
      tool === "search_papers" ? `Searching papers${query ? ` for “${query}”` : ""}…` : tool === "get_paper" ? "Looking up the paper…" : "Finding related papers…";
    return (
      <div data-testid="paper-search-running" className="my-1.5 flex items-center gap-2 text-sm text-[var(--muted-foreground)]">
        <Spinner size="sm" className="h-3 w-3" />
        <BookOpen className="h-3.5 w-3.5" />
        {doing}
      </div>
    );
  }
  const parsed = parsePaperResult(result);
  if (!parsed) return <ToolReasoning name={name} status={status} args={parameters} result={result} />;
  if (parsed.kind === "error") {
    return (
      <div className="my-1.5 flex items-start gap-2 text-sm text-[var(--muted-foreground)]">
        <BookOpen className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>Paper search failed: {parsed.message}</span>
      </div>
    );
  }
  const heading =
    tool === "search_papers"
      ? `${parsed.total !== null && parsed.total > parsed.papers.length ? `${parsed.papers.length} of ${parsed.total.toLocaleString()}` : parsed.papers.length} papers${parsed.query ? ` for “${parsed.query}”` : ""}`
      : tool === "related_papers"
        ? `${plural(parsed.papers.length, "related paper")}`
        : "Paper";
  return (
    <section
      data-testid="paper-results"
      aria-label={heading}
      className="my-2 overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--card)]"
    >
      <header className="flex items-center gap-2 border-b border-[var(--border)] px-3 py-1.5 text-xs font-medium text-[var(--muted-foreground)]">
        <BookOpen className="size-3.5 shrink-0" />
        <span className="truncate">{heading}</span>
      </header>
      {parsed.papers.length === 0 ? (
        <p className="px-3 py-2 text-sm text-[var(--muted-foreground)]">No papers found.</p>
      ) : (
        <ul className="divide-y divide-[var(--border)]">
          {parsed.papers.map((paper) => (
            <PaperCard key={paper.id} paper={paper} server={server} />
          ))}
        </ul>
      )}
    </section>
  );
}

type SaveState = { state: "idle" } | { state: "saving" } | { state: "saved"; path: string; proposed: boolean } | { state: "failed"; message: string };

function PaperCard({ paper, server }: { paper: PaperInfo; server: string }) {
  const { menu, callTool, fillComposer } = useToolMenu();
  const ws = useWorkspace();
  const { open } = useWorkbench().editor;
  const [expanded, setExpanded] = useState(false);
  const [save, setSave] = useState<SaveState>({ state: "idle" });
  // Saving goes through the storage API, so it needs server storage and a server that allows it.
  const canSave = ws.storageMode === "server" && Boolean(menu.find((m) => m.server === server)?.callable.includes("save_paper"));

  const authors = paper.authors.slice(0, 3).map((a) => a.name).join(", ") + (paper.author_count > 3 ? " et al." : "");
  const meta = [authors, paper.venue, paper.year].filter(Boolean).join(" · ");

  const onSave = async () => {
    setSave({ state: "saving" });
    try {
      const saved = (await callTool(server, "save_paper", {
        id: paper.id,
        ...(ws.node ? { node: ws.node } : {}),
        ...(ws.experiment ? { experiment: ws.experiment.id } : {}),
      })) as { path?: string; proposed?: boolean } | null;
      setSave({ state: "saved", path: saved?.path ?? "papers/", proposed: Boolean(saved?.proposed) });
    } catch (err) {
      setSave({ state: "failed", message: err instanceof Error ? err.message : String(err) });
    }
  };

  const savedFile = save.state === "saved" && !save.proposed ? ws.getFile(save.path) : undefined;
  const button =
    "flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-[var(--muted-foreground)] hover:bg-[var(--secondary)] hover:text-[var(--foreground)] cursor-pointer disabled:cursor-default disabled:opacity-60";

  return (
    <li data-testid="paper-card" data-paper={paper.id} className="px-3 py-2">
      <a
        href={paper.url}
        target="_blank"
        rel="noreferrer"
        className="text-sm font-medium leading-snug text-[var(--foreground)] hover:underline"
      >
        {paper.title}
      </a>
      <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-[var(--muted-foreground)]">
        {meta && <span className="min-w-0">{meta}</span>}
        {paper.citation_count !== null && <span>{plural(paper.citation_count, "citation")}</span>}
        {paper.open_access && (
          <span className="rounded bg-emerald-100 px-1 text-[10px] font-medium text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200">
            Open access
          </span>
        )}
      </div>
      {paper.abstract && (
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          aria-expanded={expanded}
          title={expanded ? "Show less" : "Show the whole abstract"}
          className={cn("mt-1 block text-left text-xs leading-relaxed text-[var(--foreground)]/80 cursor-pointer", !expanded && "line-clamp-2")}
        >
          {paper.abstract}
        </button>
      )}
      <div className="mt-1 flex flex-wrap items-center gap-1">
        {canSave && (
          <button
            type="button"
            data-testid="paper-save"
            onClick={() => void onSave()}
            disabled={save.state === "saving" || save.state === "saved"}
            className={button}
          >
            {save.state === "saving" ? (
              <Spinner size="sm" className="h-3 w-3" />
            ) : save.state === "saved" ? (
              <Check className="size-3 text-emerald-600" />
            ) : (
              <Save className="size-3" />
            )}
            {save.state === "saved" ? (save.proposed ? "Proposed for review" : "Saved") : "Save to workspace"}
          </button>
        )}
        <button
          type="button"
          data-testid="paper-ask"
          onClick={() => fillComposer(`Tell me more about [${paper.title}](${paper.url}): `)}
          className={button}
        >
          <MessageSquareQuote className="size-3" />
          Ask about this
        </button>
        {paper.pdf_url && (
          <a href={paper.pdf_url} target="_blank" rel="noreferrer" className={button}>
            <FileText className="size-3" />
            PDF
          </a>
        )}
        <a href={paper.url} target="_blank" rel="noreferrer" className={button}>
          <ExternalLink className="size-3" />
          Page
        </a>
      </div>
      {save.state === "saved" && (
        <p className="mt-1 text-xs text-[var(--muted-foreground)]">
          {save.proposed ? "Proposed " : "Saved to "}
          {savedFile ? (
            <button type="button" onClick={() => open(savedFile.path)} className="underline cursor-pointer">
              {save.path}
            </button>
          ) : (
            <code>{save.path}</code>
          )}
          {save.proposed && " for an editor of this node to accept."}
        </p>
      )}
      {save.state === "failed" && <p className="mt-1 text-xs text-red-600 dark:text-red-400">Couldn&apos;t save: {save.message}</p>}
    </li>
  );
}
