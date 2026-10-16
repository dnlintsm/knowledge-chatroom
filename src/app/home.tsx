"use client";

import { Workspace, WorkspaceProvider } from "@/components/workspace";
import { useGenerativeUIExamples } from "@/hooks";

import { CopilotChatConfigurationProvider } from "@copilotkit/react-core/v2";

function Demos() {
  useGenerativeUIExamples();
  return null;
}

export function Home() {
  return (
    /*
      One UNCONTROLLED CopilotChatConfigurationProvider (no `threadId` prop) owns
      the active thread. The chat pane's history list and its
      "New chat" button drive it directly; a *controlled* provider would
      block "New chat" from resetting the conversation.
    */
    <CopilotChatConfigurationProvider agentId="default">
      <WorkspaceProvider>
        <Demos />
        <Workspace />
      </WorkspaceProvider>
    </CopilotChatConfigurationProvider>
  );
}
