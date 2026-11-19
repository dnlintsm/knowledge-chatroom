"use client";

import { useMemo, useEffect, useState } from "react";
import { History, MessageSquarePlus, MessagesSquare } from "lucide-react";
import {
  CopilotChat,
  CopilotChatUserMessage,
  useCopilotChatConfiguration,
  type CopilotChatAssistantMessage,
  type CopilotChatAssistantMessageProps,
  type CopilotChatInput,
  type CopilotChatReasoningMessage,
  type CopilotChatUserMessageProps,
  type Message,
} from "@copilotkit/react-core/v2";
import { cn } from "@/lib/utils";
import { ChatStepsProvider, ReasoningStep, StepAssistantMessage, StepsModeButton, stepRows, useChatSteps } from "./agent-steps-view";
import { AnswerSources, useAnswerReferences } from "./chat-answer";
import { ChatHistory } from "./chat-history";
import { SkillChatInput } from "./skills";
import { useWorkbench } from "./workbench";

/** Answers, and narration inside a steps block (agent-steps-view.tsx). */
function AssistantMessage(props: CopilotChatAssistantMessageProps) {
  const content = typeof props.message.content === "string" ? props.message.content : "";
  const { sources, markdownRenderer } = useAnswerReferences(content);
  return <AnswerSources value={sources}><StepAssistantMessage {...props} markdownRenderer={markdownRenderer} /></AnswerSources>;
}

function UserMessage(props: CopilotChatUserMessageProps) {
  return <CopilotChatUserMessage {...props} className={cn("kc-user-row", props.className)} messageRenderer={{ className: "kc-user-bubble" }} />;
}

const groupWhileRunning = (messages: Message[]) => stepRows(messages, true);
const groupWhenIdle = (messages: Message[]) => stepRows(messages, false);
const composerSuggestions = { children: () => null };

export function ChatPane() {
  return (
    <ChatStepsProvider>
      <ChatPaneView />
    </ChatStepsProvider>
  );
}

function ChatPaneView() {
  const { chat } = useWorkbench();
  // Past chats show in place of the conversation (on phones the list slides
  // over it). Picking one, or starting a new one, changes the thread, which
  // brings the conversation back.
  const chatConfig = useCopilotChatConfiguration();
  const history = chatConfig?.drawerOpen ?? false;
  const setHistory = (open: boolean) => chatConfig?.setDrawerOpen(open);
  const threadId = chatConfig?.threadId;
  const [shownThread, setShownThread] = useState(threadId);
  useEffect(() => {
    if (threadId === shownThread) return;
    setShownThread(threadId);
    chatConfig?.setDrawerOpen(false);
  }, [threadId, shownThread, chatConfig]);
  // Each turn's thinking and tool calls fold into one block (issue #154). The
  // grouping only changes when a run starts or ends, so the view is rebuilt then.
  const { running } = useChatSteps();
  const messageView = useMemo(
    () => ({
      // A slot may be any component taking the message's props; the type asks for its statics too.
      assistantMessage: AssistantMessage as typeof CopilotChatAssistantMessage,
      userMessage: UserMessage as typeof CopilotChatUserMessage,
      reasoningMessage: ReasoningStep as typeof CopilotChatReasoningMessage,
      groupMessages: running ? groupWhileRunning : groupWhenIdle,
    }),
    [running],
  );
  const headerButton =
    "flex size-7 items-center justify-center rounded text-[var(--muted-foreground)] hover:bg-[var(--card)] hover:text-[var(--foreground)] cursor-pointer";

  return (
    <section aria-label="Chat" className="kc-chat flex h-full min-h-0 flex-col bg-[var(--background)]">
      {/* Controls stay left: the CopilotKit inspector button floats at the top-right. */}
      <header className="kc-chat-header flex shrink-0 items-center gap-2 border-b border-[var(--border)] px-3">
        <span className="kc-chat-title"><MessagesSquare aria-hidden="true" /> Chat</span>
        <button
          type="button"
          title="New chat"
          aria-label="New chat"
          onClick={() => {
            setHistory(false);
            chat.newThread();
          }}
          className={headerButton}
        >
          <MessageSquarePlus className="size-4" />
        </button>
        <button
          type="button"
          title={history ? "Back to chat" : "Chat history"}
          aria-label="Chat history"
          aria-pressed={history}
          onClick={() => setHistory(!history)}
          className={cn(headerButton, history && "bg-[var(--card)] text-[var(--foreground)] shadow-sm")}
        >
          <History className="size-4" />
        </button>
        <StepsModeButton className={headerButton} />
      </header>

      {history && (
        <div data-testid="chat-history" className="min-h-0 flex-1">
          <ChatHistory onOpen={() => setHistory(false)} />
        </div>
      )}
      {/* Kept mounted under the history so the conversation and its tools survive. */}
      <div className={cn("min-h-0 flex-1", history && "hidden")}>
        <CopilotChat
          attachments={{ enabled: true }}
          // A slot may be any component taking the input's props; the type asks for its statics too.
          input={SkillChatInput as typeof CopilotChatInput}
          messageView={messageView}
          suggestionView={composerSuggestions}
          welcomeScreen={false}
          className="h-full"
        />
      </div>
    </section>
  );
}
