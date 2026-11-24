"use client";

import { useMemo, useEffect, useState } from "react";
import { History, MessageSquarePlus, MessagesSquare } from "lucide-react";
import {
  CopilotChat,
  CopilotChatUserMessage,
  useAgent,
  useCopilotChatConfiguration,
  UseAgentUpdate,
  type CopilotChatAssistantMessage,
  type CopilotChatAssistantMessageProps,
  type CopilotChatInput,
  type CopilotChatReasoningMessage,
  type CopilotChatUserMessageProps,
  type Message,
} from "@copilotkit/react-core/v2";
import { IconButton } from "@/components/ui/icon-button";
import { cn } from "@/lib/utils";
import { ChatStepsProvider, ReasoningStep, StepAssistantMessage, StepsModeButton, stepRows, useChatSteps } from "./agent-steps-view";
import { AnswerSources, BrandMark, useAnswerReferences } from "./chat-answer";
import { ChatHistory } from "./chat-history";
import { useMemory } from "./memory";
import { SkillChatInput } from "./skills";
import { useWorkbench } from "./workbench";

/** Answers, and narration inside a steps block (agent-steps-view.tsx). */
function AssistantMessage(props: CopilotChatAssistantMessageProps) {
  const content = typeof props.message.content === "string" ? props.message.content : "";
  const { sources, markdownRenderer } = useAnswerReferences(content, Boolean(props.isRunning && props.isLatest));
  return <AnswerSources value={sources}><StepAssistantMessage {...props} markdownRenderer={markdownRenderer} /></AnswerSources>;
}

// The toolbar (copy, edit) shows on hover or focus, and always on touch screens,
// which have no hover. It is CopilotKit's, so it is found by its test ID.
// `!` wins over CopilotKit's classes on the same element.
const userRow = [
  "items-end! pt-4.5!",
  "[&_[data-testid=copilot-user-toolbar]]:visible! [&_[data-testid=copilot-user-toolbar]]:pointer-events-none! [&_[data-testid=copilot-user-toolbar]]:opacity-0!",
  "hover:[&_[data-testid=copilot-user-toolbar]]:pointer-events-auto! hover:[&_[data-testid=copilot-user-toolbar]]:opacity-100!",
  "[&_[data-testid=copilot-user-toolbar]]:focus-within:pointer-events-auto! [&_[data-testid=copilot-user-toolbar]]:focus-within:opacity-100!",
  "hover-none:[&_[data-testid=copilot-user-toolbar]]:pointer-events-auto! hover-none:[&_[data-testid=copilot-user-toolbar]]:opacity-100!",
].join(" ");
const userBubble = "max-w-[90%]! wrap-anywhere! bg-brand-tint! text-[var(--foreground)]! rounded-[.875rem_.875rem_.25rem_.875rem]! px-3! py-2!";

function UserMessage(props: CopilotChatUserMessageProps) {
  return <CopilotChatUserMessage {...props} className={cn(userRow, props.className)} messageRenderer={{ className: userBubble }} />;
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
  // Each turn's thinking and tool calls fold into one block. The
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
  return (
    <section aria-label="Chat" className="flex h-full min-h-0 flex-col bg-[var(--background)]">
      {/* Controls stay left: the CopilotKit inspector button floats at the top-right. */}
      <header className="flex min-h-11 shrink-0 items-center gap-2 border-b border-[var(--border)] px-3">
        <span className="flex items-center gap-2 text-body font-semibold"><BrandMark icon={MessagesSquare} /> Chat</span>
        <IconButton
          title="New chat"
          aria-label="New chat"
          onClick={() => {
            setHistory(false);
            chat.newThread();
          }}
        >
          <MessageSquarePlus />
        </IconButton>
        <IconButton
          title={history ? "Back to chat" : "Chat history"}
          aria-label="Chat history"
          aria-pressed={history}
          onClick={() => setHistory(!history)}
        >
          <History />
        </IconButton>
        <StepsModeButton />
      </header>

      {history && (
        <div data-testid="chat-history" className="min-h-0 flex-1">
          <ChatHistory onOpen={() => setHistory(false)} />
        </div>
      )}
      {/* Kept mounted under the history so the conversation and its tools survive. */}
      <div className={cn("relative min-h-0 flex-1", history && "hidden")}>
        <CopilotChat
          attachments={{ enabled: true }}
          // A slot may be any component taking the input's props; the type asks for its statics too.
          input={SkillChatInput as typeof CopilotChatInput}
          messageView={messageView}
          suggestionView={composerSuggestions}
          welcomeScreen={false}
          className="h-full"
        />
        <ChatEmptyState />
      </div>
    </section>
  );
}

/** A new chat says what Claude can work with, above the suggestions and the composer. */
function ChatEmptyState() {
  const { agent } = useAgent({ updates: [UseAgentUpdate.OnMessagesChanged, UseAgentUpdate.OnRunStatusChanged] });
  const { status, mode, incognito } = useMemory();
  if (agent.messages.length > 0 || agent.isRunning) return null;
  const remembers = status === "ready" && mode !== "off" && !incognito;
  return (
    // Over the empty message list, under CopilotKit's input overlay (z-20).
    <div data-testid="chat-empty"
      className="pointer-events-none absolute inset-x-0 top-0 z-10 grid gap-1.5 px-6 pt-[12%] text-center text-body text-[var(--muted-foreground)]">
      <p className="text-title font-semibold text-[var(--foreground)]">Ask Claude about your workspace</p>
      <p>
        Claude sees the file you have open and any text you select, and can read, create and edit files here.
        {remembers && " It remembers what helps across chats."}
      </p>
      <p>Pick a suggestion below, or type <kbd className="rounded border border-[var(--border)] px-1.25 font-[family-name:var(--font-code)] text-label">/</kbd> to run a skill.</p>
    </div>
  );
}
