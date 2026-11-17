"use client";

import { useCallback, useLayoutEffect, useMemo, useState } from "react";

import { Workspace, WorkspaceProvider } from "@/components/workspace";
import type { StepsMode } from "@/components/workspace/agent-steps";
import { StepsDefaultContext } from "@/components/workspace/agent-steps-view";
import { CurrentWorkspaceContext, RenameWorkspaceContext } from "@/components/workspace/current-workspace";
import { setSavedStateScope } from "@/components/workspace/local-persistence";
import { useGenerativeUIExamples } from "@/hooks";
import { recordVisit } from "@/lib/workspace-choice";
import { DEFAULT_SLUG, WORKSPACE_HEADER, setRequestWorkspace, type WorkspaceInfo } from "@/lib/workspace-request";

import { CopilotChatConfigurationProvider, CopilotKit } from "@copilotkit/react-core/v2";
// A2UI catalog: definitions + renderers in ./declarative-generative-ui/
import { demonstrationCatalog } from "./declarative-generative-ui/renderers";

function Demos() {
  useGenerativeUIExamples();
  return null;
}

/**
 * The app in one workspace (issue #226): the one the page's `/w/<slug>`
 * names, or null when the server has no workspaces. Everything below is
 * mounted again when it changes, so no chat, file or request carries over.
 */
export function Home({
  chatSteps = "compact",
  workspace = null,
  userKey = "local",
}: {
  chatSteps?: StepsMode;
  workspace?: WorkspaceInfo | null;
  /** Whose saved browser state this is: the login subject, "local" without login. */
  userKey?: string;
}) {
  const id = workspace?.id ?? null;
  const isDefault = workspace?.slug === DEFAULT_SLUG;
  // Before anything below fetches or reads saved state (their effects run
  // after this one): requests name this workspace from now on, those still
  // pending for another are cancelled, and saved state is this user's here.
  useLayoutEffect(() => {
    setRequestWorkspace(id);
    setSavedStateScope(id ? { user: userKey, workspace: id, isDefault } : null);
    // For the switcher's recent workspaces.
    if (id) {
      try {
        recordVisit(window.localStorage, userKey, id);
      } catch {
        // Site storage blocked or full: the switcher lists them all, without recent ones.
      }
    }
  }, [id, userKey, isDefault]);
  const headers = useMemo(() => (id ? { [WORKSPACE_HEADER]: id } : undefined), [id]);
  // Its name as shown: a rename (issue #255) changes it in place.
  const [renamed, setRenamed] = useState<{ id: string; name: string } | null>(null);
  const shown = useMemo(
    () => (workspace && renamed?.id === workspace.id ? { ...workspace, name: renamed.name } : workspace),
    [workspace, renamed],
  );
  const rename = useCallback(
    (name: string) => {
      if (id) setRenamed({ id, name });
    },
    [id],
  );

  return (
    <CopilotKit
      key={id ?? "default"}
      runtimeUrl="/api/copilotkit"
      // The chat's runs and history go to this workspace (route.ts, src/lib/chat-runner.ts).
      headers={headers}
      a2ui={{ catalog: demonstrationCatalog }}
      openGenerativeUI={{}}
      useSingleEndpoint={false}
    >
      <CurrentWorkspaceContext.Provider value={shown}>
        <RenameWorkspaceContext.Provider value={rename}>
        {/*
          One UNCONTROLLED CopilotChatConfigurationProvider (no `threadId` prop) owns
          the active thread. The chat pane's history list and its
          "New chat" button drive it directly; a *controlled* provider would
          block "New chat" from resetting the conversation.
        */}
        <CopilotChatConfigurationProvider agentId="default">
          <StepsDefaultContext.Provider value={chatSteps}>
            <WorkspaceProvider>
              <Demos />
              <Workspace />
            </WorkspaceProvider>
          </StepsDefaultContext.Provider>
        </CopilotChatConfigurationProvider>
        </RenameWorkspaceContext.Provider>
      </CurrentWorkspaceContext.Provider>
    </CopilotKit>
  );
}
