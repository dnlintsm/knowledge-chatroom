"use client";

import type { ComponentProps, ReactNode } from "react";
import { FileText, MessageSquarePlus, TextSelect } from "lucide-react";
import { CopilotChat, useCopilotChatConfiguration } from "@copilotkit/react-core/v2";
import { defaultRehypePlugins } from "streamdown";
import { cn } from "@/lib/utils";
import { FileIcon } from "./file-icon";
import { parseFileRef, rootRelativeLinks, type FileRef } from "./file-refs";
import { useWorkspace } from "./store";
import { fileName } from "./types";

// Streamdown's harden step drops bare relative links such as notes/welcome.md#L12,
// so rootRelativeLinks rewrites them into a form it keeps, just before it runs.
const { harden, ...beforeHarden } = defaultRehypePlugins;

/** Defined once: CopilotKit memoizes chat slots by identity. */
const MESSAGE_VIEW = {
  assistantMessage: {
    markdownRenderer: {
      components: { a: AnswerLink },
      rehypePlugins: [...Object.values(beforeHarden), rootRelativeLinks, harden],
    },
  },
};

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
          messageView={MESSAGE_VIEW}
          className="h-full"
        />
      </div>
    </section>
  );
}

/** Answer links: file references (file-refs.ts) open in the middle pane, the rest on the web. */
function AnswerLink({ href, className, children, node: _node, ...props }: ComponentProps<"a"> & { node?: unknown }) {
  const fileRef = parseFileRef(href);
  if (fileRef) return <FileRefLink fileRef={fileRef}>{children}</FileRefLink>;
  // As Streamdown's own link, which this replaces.
  return (
    <a
      data-streamdown="link"
      href={href}
      rel="noreferrer"
      target="_blank"
      {...props}
      className={cn("wrap-anywhere font-medium text-primary underline", className)}
    >
      {children}
    </a>
  );
}

function FileRefLink({ fileRef: { path, lines }, children }: { fileRef: FileRef; children: ReactNode }) {
  const { getFile, open } = useWorkspace();
  const file = getFile(path);
  const where = !lines
    ? path
    : lines.start === lines.end
      ? `${path}, line ${lines.start}`
      : `${path}, lines ${lines.start}–${lines.end}`;
  if (!file) {
    return (
      <span title={`${where} (not a file in your workspace)`} className="text-[var(--muted-foreground)] underline decoration-dashed">
        {children}
      </span>
    );
  }
  return (
    <button
      type="button"
      data-testid="file-ref"
      title={`Open ${where}`}
      onClick={() => open(file.path, lines)}
      className="rounded bg-[var(--secondary)] px-1 font-medium text-[var(--foreground)] underline decoration-[var(--muted-foreground)] underline-offset-2 hover:bg-[var(--accent)] cursor-pointer"
    >
      <FileIcon file={file} className="mr-1 inline size-3.5 align-[-2px]" />
      {children}
    </button>
  );
}
