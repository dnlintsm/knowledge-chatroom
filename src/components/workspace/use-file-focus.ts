"use client";

import { useCallback, useEffect, useReducer } from "react";
import { INITIAL_FILE_FOCUS, reduceFileFocus } from "./file-focus";
import type { LineRange } from "./file-refs";
import type { TabId } from "./types";

export function useFileFocus(active: TabId | null) {
  const [state, dispatch] = useReducer(reduceFileFocus, INITIAL_FILE_FOCUS);
  // Covers open/close/delete/resync; a selection must not pair with another file.
  useEffect(() => dispatch({ type: "activate" }), [active]);
  const setSelection = useCallback((text: string) => dispatch({ type: "selection", text }), []);
  const open = useCallback((tab: TabId, lines?: LineRange) => dispatch({ type: "open", tab, lines }), []);
  const edit = useCallback((path: string) => dispatch({ type: "edit", path }), []);
  const reset = useCallback(() => dispatch({ type: "reset" }), []);
  return { ...state, setSelection, open, edit, reset };
}
