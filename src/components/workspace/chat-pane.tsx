"use client";

import { FileText, MessageSquarePlus, TextSelect } from "lucide-react";
import { CopilotChat, useCopilotChatConfiguration } from "@copilotkit/react-core/v2";
import { useWorkspace } from "./store";
import { fileName } from "./types";

export function ChatPane() {
  const { activeFile, selection } = useWorkspace();
  const chatConfig = useCopilotChatConfiguration();

  return (
    <section aria-label="Chat" className="flex h-full min-h-0 flex-col bg-[var(--background)]">
      {/* Controls stay left: the CopilotKit inspector button floats at the top-right. */}
      <header className="flex h-10 shrink-0 items-center gap-2 border-b border-[var(--border)] bg-[var(--secondary)] px-3">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-[var(--muted-foreground)]">
          Claude
        </span>
        <button
          type="button"
          title="New chat"
          aria-label="New chat"
          onClick={() => chatConfig?.startNewThread()}
          className="flex size-7 items-center justify-center rounded text-[var(--muted-foreground)] hover:bg-[var(--card)] hover:text-[var(--foreground)] cursor-pointer"
        >
          <MessageSquarePlus className="size-4" />
        </button>
      </header>

      {/* What Claude can see right now, so "this file" never feels like magic. */}
      <div
        data-testid="chat-context"
        className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-[var(--border)] px-3 py-2 text-xs text-[var(--muted-foreground)]"
      >
        <span>Claude sees:</span>
        {activeFile ? (
          <span className="flex max-w-full items-center gap-1 rounded-full bg-[var(--secondary)] px-2 py-0.5 text-[var(--foreground)]">
            <FileText className="size-3 shrink-0" />
            <span className="truncate">{fileName(activeFile.path)}</span>
          </span>
        ) : (
          <span>your file list</span>
        )}
        {selection && (
          <span className="flex items-center gap-1 rounded-full bg-[var(--accent)] px-2 py-0.5 text-[var(--accent-foreground)]">
            <TextSelect className="size-3" /> {selection.length} selected chars
          </span>
        )}
      </div>

      <div className="min-h-0 flex-1">
        <CopilotChat
          attachments={{ enabled: true }}
          input={{ disclaimer: () => null, className: "pb-4" }}
          className="h-full"
        />
      </div>
    </section>
  );
}
