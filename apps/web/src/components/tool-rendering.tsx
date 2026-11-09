"use client";

/**
 * A tool call as one step of a turn (issue #154): a line in plain words
 * ("Read notes/x.md"), opening into the tool's name, arguments and result.
 * Inside a closed steps block it renders nothing; the block's header says
 * what is happening instead (src/components/workspace/agent-steps-view.tsx).
 * Detailed mode opens each step's details by default.
 *
 * Styled with Tailwind utility classes, compiled through `@import "tailwindcss"`
 * in `src/app/globals.css`.
 */

import { useState, useId } from "react";
import { Wrench, Check, ChevronRight } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { parseArgs, stepLabel } from "@/components/workspace/agent-steps";
import { useStepHidden, useStepsView } from "@/components/workspace/agent-steps-view";
import { cn } from "@/lib/utils";

interface ToolReasoningProps {
  name: string;
  args?: unknown;
  status: string;
  result?: string;
}

/** Results longer than this are cut in the details. */
const RESULT_CHARS = 2000;

function formatValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.length} items]`;
  if (typeof value === "object" && value !== null)
    return `{${Object.keys(value).length} keys}`;
  if (typeof value === "string") return `"${value}"`;
  return String(value);
}

export function ToolReasoning({ name, args, status, result }: ToolReasoningProps) {
  const hidden = useStepHidden();
  const { detailed } = useStepsView();
  const [open, setOpen] = useState<boolean | null>(null);
  const id = useId();
  if (hidden) return null;

  const isRunning = status === "executing" || status === "inProgress";
  const parsed = parseArgs(args);
  const entries = Object.entries(parsed);
  const label = stepLabel(name, parsed, isRunning ? "running" : "done");
  const shown = open ?? detailed;
  const shownResult = result && result.length > RESULT_CHARS ? `${result.slice(0, RESULT_CHARS)}…` : result;

  return (
    <div data-testid="agent-step" data-step="tool" data-tool={name} className="my-1">
      <button
        type="button"
        aria-expanded={shown}
        aria-controls={id}
        onClick={() => setOpen(!shown)}
        className="flex w-full min-w-0 items-center gap-2 text-left text-sm text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition-colors cursor-pointer"
      >
        {isRunning ? <Spinner size="sm" className="h-3 w-3 shrink-0" /> : <Check className="h-3 w-3 shrink-0 text-emerald-500" />}
        <span className="min-w-0 truncate">{isRunning ? `${label}…` : label}</span>
        <ChevronRight className={cn("h-3 w-3 shrink-0 transition-transform", shown && "rotate-90")} />
      </button>
      {shown && (
        <div
          id={id}
          data-testid="agent-step-details"
          className="ml-5 mt-1.5 space-y-1 rounded-md bg-[var(--secondary)] px-3 py-2 text-xs"
          style={{ fontFamily: "var(--font-code)" }}
        >
          <div className="flex items-center gap-2 text-[var(--muted-foreground)]">
            <Wrench className="h-3 w-3 shrink-0" />
            <span className="truncate text-[var(--foreground)]">{name}</span>
          </div>
          {entries.map(([key, value]) => (
            <div key={key} className="flex min-w-0 gap-2">
              <span className="shrink-0 text-[var(--muted-foreground)]">{key}:</span>
              <span className="truncate text-[var(--foreground)]">{formatValue(value)}</span>
            </div>
          ))}
          {shownResult && (
            <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words border-t border-[var(--border)] pt-1 text-[var(--muted-foreground)]">
              {shownResult}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
