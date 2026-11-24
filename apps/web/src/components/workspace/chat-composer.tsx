"use client";

import type { ComponentProps } from "react";
import { ArrowUp, CornerDownRight, Eye, FileText, FlaskConical, Square, TextSelect } from "lucide-react";
import { useAgent, useSuggestions, UseAgentUpdate } from "@copilotkit/react-core/v2";
import { Chip, chipVariants } from "@/components/ui/chip";
import { IconButton } from "@/components/ui/icon-button";
import { cn } from "@/lib/utils";
import { ChatModelPicker } from "./chat-model";
import { ChatMemoryControl } from "./memory";
import { useWorkspace } from "./store";
import { useToolMenu } from "./tool-menu";
import { fileName } from "./types";
import { useWorkbench } from "./workbench";

export function ChatSuggestions() {
  const { suggestions } = useSuggestions();
  const { fillComposer } = useToolMenu();
  const { chat } = useWorkbench();
  if (!suggestions.length) return null;
  return (
    // Chips size to their labels and wrap, so a label is never cut off: it has to be read before choosing.
    <div className="pointer-events-auto mx-3 mb-1.75 flex flex-wrap gap-1.25" role="group" aria-label="Suggested questions" data-testid="copilot-suggestions">
      {suggestions.map((suggestion, index) => (
        <button key={`${index}-${suggestion.title}`} type="button" title={suggestion.message || suggestion.title}
          data-testid="copilot-suggestion" aria-busy={suggestion.isLoading || undefined} disabled={suggestion.isLoading}
          className={chipVariants({ variant: "suggestion" })}
          onClick={() => {
            fillComposer(suggestion.message);
            chat.focus();
          }}>
          <CornerDownRight aria-hidden="true" /><span>{suggestion.title}</span>
        </button>
      ))}
    </div>
  );
}

export function ChatDraftContext() {
  const { activeFile, selection, experiment } = useWorkspace();
  return (
    <div data-testid="chat-context" className="flex min-w-0 flex-wrap items-center gap-1">
      {/* Labelled, so the chips read as what Claude sees rather than attachments to remove. */}
      <Chip variant="label"><Eye aria-hidden="true" /> Claude sees</Chip>
      {experiment && (
        <Chip data-testid="chat-context-run" title={`Experiment: ${experiment.title}`}>
          <FlaskConical aria-hidden="true" /><span className="truncate">{experiment.title}</span>
        </Chip>
      )}
      {activeFile ? (
        <Chip title={activeFile.path}><FileText aria-hidden="true" /><span className="truncate">{fileName(activeFile.path)}</span></Chip>
      ) : <Chip>Workspace files</Chip>}
      {selection && <Chip><TextSelect aria-hidden="true" /> {selection.length} selected chars</Chip>}
    </div>
  );
}

/** CopilotKit supplies the real send/stop callback and enables the button for the active operation. */
export function ChatSendButton({ className, ...props }: ComponentProps<"button">) {
  const { agent } = useAgent({ updates: [UseAgentUpdate.OnRunStatusChanged] });
  const stopping = agent.isRunning;
  const label = stopping ? "Stop generating" : "Send message";
  return (
    <div className="flex min-w-0 flex-1 items-center justify-end gap-1">
      <ChatMemoryControl />
      <ChatModelPicker disabled={stopping} />
      <IconButton {...props} variant="brand" size="md" aria-label={label} title={label} data-testid="copilot-send-button"
        className={cn("relative", className)} data-running={stopping || undefined}>
        {stopping ? (
          <>
            {/* Progress ring around Stop; still under reduced motion. */}
            <span aria-hidden="true" className="absolute inset-0 m-auto size-5.75 animate-spin rounded-full border-[1.5px] border-current/45 border-t-current motion-reduce:animate-none" />
            <Square aria-hidden="true" className="size-2.5! fill-current" />
          </>
        ) : <ArrowUp aria-hidden="true" />}
      </IconButton>
    </div>
  );
}
