"use client";

import { useCallback, useEffect, useState } from "react";
import { listRuns, onRunEvent, type Run } from "./run-records";
import type { Experiment } from "./server-files";

export interface ExperimentRuns {
  /** Newest first; null until loaded. With `archived`, archived ones too. */
  runs: Run[] | null;
  /** Its deleted Runs, for whoever works on it ([] for others). */
  deleted: Run[];
  error: string | null;
  reload: () => Promise<void>;
}

/**
 * An Experiment's Runs, loaded again when one of them changes (here, in
 * another tab, or by Claude) or the Experiment does.
 */
export function useRuns(experiment: Experiment, { archived = false, worker = false } = {}): ExperimentRuns {
  const { id, updatedAt } = experiment;
  const [found, setFound] = useState<{ key: string; runs: Run[]; deleted: Run[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const key = `${id}|${archived}|${worker}`;

  const load = useCallback(async () => {
    try {
      const [runs, deleted] = await Promise.all([
        listRuns(id, archived ? "archived" : "live"),
        worker ? listRuns(id, "deleted").catch(() => []) : Promise.resolve([]),
      ]);
      setFound({ key, runs, deleted });
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [id, archived, worker, key]);

  useEffect(() => {
    let live = true;
    const reload = () => {
      if (live) void load();
    };
    reload();
    const stop = onRunEvent((event) => {
      if (event.experiment === id) reload();
    });
    return () => {
      live = false;
      stop();
    };
    // Again when the Experiment changes: its latest Run's state and results show on it.
  }, [id, load, updatedAt]);

  const current = found?.key === key ? found : null;
  return { runs: current?.runs ?? null, deleted: current?.deleted ?? [], error, reload: load };
}
