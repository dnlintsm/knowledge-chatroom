"use client";

import { Workspace, WorkspaceProvider } from "@/components/workspace";
import { useGenerativeUIExamples, useExampleSuggestions } from "@/hooks";

import { CopilotChatConfigurationProvider } from "@copilotkit/react-core/v2";

function Demos() {
  useGenerativeUIExamples();
  useExampleSuggestions();
  return null;
}

export function Home() {
  return (
    /*
      One UNCONTROLLED CopilotChatConfigurationProvider (no `threadId` prop) owns
      the active thread. The threads list in the sidebar's Chats view and the
      chat's "New chat" button drive it directly; a *controlled* provider would
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
