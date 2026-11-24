"use client";

import { useEffect, useState } from "react";
import { ChevronRight, RotateCcw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ago, cn } from "@/lib/utils";
import { placeName } from "./experiment-panel";
import { deletedDetail } from "./runs";
import { listDeletedExperiments, type DeletedExperiment } from "./server-files";
import { useWorkspace } from "./store";
import { useWorkbench } from "./workbench";

/**
 * The end of the Experiments view: the deleted experiments you may restore
 * (docs/run-evidence.md, "Recovering a deleted Experiment"), behind a
 * "Recently deleted" link that shows only when there are some.
 */
export function RecentlyDeleted() {
  const ws = useWorkspace();
  const { notify } = useWorkbench();
  const [deleted, setDeleted] = useState<DeletedExperiment[]>([]);
  const [open, setOpen] = useState(false);
  const [restoring, setRestoring] = useState<string | null>(null);
  // A delete or a restore, here or by someone else, refreshes the experiment
  // list, so this list follows it.
  useEffect(() => {
    let current = true;
    void listDeletedExperiments().then((list) => {
      if (current && list) setDeleted(list);
    });
    return () => {
      current = false;
    };
  }, [ws.experiments]);
  if (deleted.length === 0) return null;

  const restore = async (e: DeletedExperiment) => {
    setRestoring(e.id);
    try {
      await ws.restoreExperiment(e.id);
      notify(`Restored ${e.title}`, "success", { label: "Open", run: () => void ws.enterExperiment(e.id) });
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), "error");
    } finally {
      setRestoring(null);
    }
  };
  return (
    <section aria-label="Recently deleted" className="mt-2 border-t border-[var(--border)] pt-1">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-[var(--muted-foreground)] hover:text-[var(--foreground)] cursor-pointer"
      >
        <Trash2 className="size-3.5 shrink-0" />
        <span className="flex-1">Recently deleted</span>
        <span className="tabular-nums">{deleted.length}</span>
        <ChevronRight className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")} />
      </button>
      {open && (
        <ul data-testid="deleted-experiments" className="pb-1">
          {deleted.map((e) => {
            const { detail, note } = deletedDetail(e, placeName(ws.nodes, e.nodeId));
            return (
              <li key={e.id} data-testid="deleted-experiment" className="px-3 py-1.5">
                <span className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate font-medium" title={e.title}>
                    {e.title}
                  </span>
                  {e.restorable && (
                    <Button
                      variant="quiet"
                      size="xs"
                      aria-label={`Restore ${e.title}`}
                      disabled={restoring !== null}
                      onClick={() => void restore(e)}
                      className="shrink-0"
                    >
                      <RotateCcw /> Restore
                    </Button>
                  )}
                </span>
                <span className="block text-xs text-[var(--muted-foreground)]">
                  <time dateTime={e.deletedAt} title={new Date(e.deletedAt).toLocaleString()}>
                    {ago(e.deletedAt)}
                  </time>
                  {" · "}
                  {detail}
                </span>
                {note && <span className="block text-xs text-[var(--muted-foreground)]">{note}</span>}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
