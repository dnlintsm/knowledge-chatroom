"use client";

import { useCallback, useSyncExternalStore } from "react";
import { ALL_EXPERIMENTS, listScopeFromSearch, searchWithListScope, type ListScope } from "./runs";

/**
 * The experiment list's scope (#186), read from and written to the URL. A
 * change replaces the current history entry, so back/forward still move
 * between places, each with the scope it had.
 */
const CHANGED = "knowledge-chatroom:list-scope";

function subscribe(onChange: () => void) {
  window.addEventListener("popstate", onChange);
  window.addEventListener(CHANGED, onChange);
  return () => {
    window.removeEventListener("popstate", onChange);
    window.removeEventListener(CHANGED, onChange);
  };
}

const search = () => window.location.search;

/** `keepAll`: all experiments was the user's choice, so it stays in the URL. */
export function writeListScope(scope: ListScope, keepAll = false) {
  const { pathname, hash } = window.location;
  window.history.replaceState(window.history.state, "", pathname + searchWithListScope(search(), scope, keepAll) + hash);
  window.dispatchEvent(new Event(CHANGED));
}

/** The scope in the URL (all experiments when it has none yet) and a setter. */
export function useListScope(): [ListScope, (scope: ListScope, keepAll?: boolean) => void] {
  const current = useSyncExternalStore(subscribe, search, () => "");
  const scope = listScopeFromSearch(current) ?? ALL_EXPERIMENTS;
  const set = useCallback((next: ListScope, keepAll?: boolean) => writeListScope(next, keepAll), []);
  return [scope, set];
}

/** Whether the URL sets the list's scope (a node, or all chosen on purpose). */
export const hasListScope = () => listScopeFromSearch(search()) !== null;
