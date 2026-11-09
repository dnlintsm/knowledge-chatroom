"use client";

import { useCallback, useMemo, useState, type Dispatch, type RefObject, type SetStateAction } from "react";
import { readPlaceUi } from "./local-persistence";
import { createPlaceNavigator } from "./place-navigation";
import { experimentOf, experimentPlace, listServerFiles, type PlaceId, type ServerFile } from "./server-files";
import type { StorageMode } from "./save-scheduler";
import { EXPERIMENT_TAB, type WorkspaceFile } from "./types";
import type { PersistedWorkspace } from "./workspace-state";

interface Options {
  mode: RefObject<StorageMode>;
  placeRef: RefObject<PlaceId>;
  files: RefObject<WorkspaceFile[]>;
  setState: Dispatch<SetStateAction<PersistedWorkspace>>;
  flushSaves: () => void;
  resync: (files: ServerFile[]) => Promise<void>;
  resetFocus: () => void;
}

/** Move, restore per-place tabs, and reconcile after capturing the old edits. */
export function usePlaceNavigation({ mode, placeRef, files, setState, flushSaves, resync, resetFocus }: Options) {
  const [place, setPlace] = useState<PlaceId>(null);
  const enterNode = useMemo(() => createPlaceNavigator({
    getMode: () => mode.current,
    getPlace: () => placeRef.current,
    list: listServerFiles,
    apply: async (id, list) => {
      flushSaves();
      placeRef.current = id;
      setPlace(id);
      const ui = readPlaceUi(window.localStorage)[id ?? ""] ?? {
        tabs: experimentOf(id) ? [EXPERIMENT_TAB] : [],
        active: experimentOf(id) ? EXPERIMENT_TAB : null,
      };
      files.current = [];
      setState({ files: [], tabs: ui.tabs, active: ui.active });
      resetFocus();
      await resync(list);
    },
  }), [mode, placeRef, files, setState, flushSaves, resync, resetFocus]);
  const enterExperiment = useCallback((id: string) => enterNode(experimentPlace(id)), [enterNode]);
  return { place, setPlace, enterNode, enterExperiment };
}
