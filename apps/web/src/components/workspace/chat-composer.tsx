"use client";

import type { ComponentProps } from "react";
import { ArrowUp, CornerDownRight, FileText, FlaskConical, Square, TextSelect } from "lucide-react";
import { useSuggestions } from "@copilotkit/react-core/v2";
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
    <div className="kc-suggestions" role="group" aria-label="Suggested questions" data-testid="copilot-suggestions">
      {suggestions.map((suggestion, index) => (
        <button key={`${index}-${suggestion.title}`} type="button" title={suggestion.message || suggestion.title}
          data-testid="copilot-suggestion" aria-busy={suggestion.isLoading || undefined} disabled={suggestion.isLoading}
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
    <div data-testid="chat-context" aria-label="Available to Claude" className="kc-draft-context">
      {experiment && (
        <span data-testid="chat-context-run" title={`Experiment: ${experiment.title}`}>
          <FlaskConical aria-hidden="true" /><span className="truncate">{experiment.title}</span>
        </span>
      )}
      {activeFile ? (
        <span title={activeFile.path}><FileText aria-hidden="true" /><span className="truncate">{fileName(activeFile.path)}</span></span>
      ) : <span>Workspace files</span>}
      {selection && <span><TextSelect aria-hidden="true" /> {selection.length} selected chars</span>}
    </div>
  );
}

/** CopilotKit supplies the real send/stop callback and enables the button for the active operation. */
export function ChatSendButton({ children, className, ...props }: ComponentProps<"button">) {
  const stopping = Boolean(children);
  const label = stopping ? "Stop generating" : "Send message";
  return (
    <div className="kc-send-controls">
      <ChatMemoryControl />
      <ChatModelPicker disabled={stopping} />
      <button {...props} type="button" aria-label={label} title={label} data-testid="copilot-send-button"
        className={cn("kc-send", className)} data-running={stopping || undefined}>
        {stopping ? <Square aria-hidden="true" /> : <ArrowUp aria-hidden="true" />}
      </button>
    </div>
  );
}
