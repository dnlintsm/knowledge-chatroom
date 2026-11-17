"use client";

import { createContext, useContext } from "react";

import type { WorkspaceInfo } from "@/lib/workspace-request";

/**
 * The workspace the page is in (issue #226): the one its `/w/<slug>` names,
 * or null when the server has no workspaces (the agent server alone, which
 * serves the default workspace). Set by src/app/home.tsx, which mounts the
 * whole workspace again when it changes.
 */
export const CurrentWorkspaceContext = createContext<WorkspaceInfo | null>(null);

export function useCurrentWorkspace(): WorkspaceInfo | null {
  return useContext(CurrentWorkspaceContext);
}

/**
 * Shows a new name for the current workspace once it is renamed (issue #255),
 * without loading the page again. Set by src/app/home.tsx.
 */
export const RenameWorkspaceContext = createContext<(name: string) => void>(() => {});

export function useRenameWorkspace(): (name: string) => void {
  return useContext(RenameWorkspaceContext);
}
