"use client";

import { createContext, useCallback, useContext, useMemo, useState, type ComponentProps, type ReactNode } from "react";
import { ExternalLink, FileText, MessagesSquare, type LucideIcon } from "lucide-react";
import { fromMarkdown } from "mdast-util-from-markdown";
import { defaultRehypePlugins } from "streamdown";
import type { CopilotChatAssistantMessageProps } from "@copilotkit/react-core/v2";
import { buttonVariants } from "@/components/ui/button";
import { SegmentedControl, SegmentedControlItem } from "@/components/ui/segmented-control";
import { cn } from "@/lib/utils";
import { lineOffsets, parseFileRef, rootRelativeLinks, workspaceNoteImages, type FileRef } from "./file-refs";
import { useWorkspace } from "./store";
import { fileName, isTextFile } from "./types";
import { useWorkbench } from "./workbench";

const { harden, ...beforeHarden } = defaultRehypePlugins;
const SourcesContext = createContext<FileRef[]>([]);
const refKey = ({ path, lines }: FileRef) => JSON.stringify([path, lines?.start, lines?.end]);
const lineLabel = (lines: FileRef["lines"]) => !lines ? "" : lines.start === lines.end
  ? `Line ${lines.start}` : `Lines ${lines.start}–${lines.end}`;

type MarkdownNode = { type: string; children?: MarkdownNode[]; identifier?: string; url?: string };

/** The order in the answer, including reference-style Markdown, with repeated citations sharing a number. */
function answerSources(markdown: string, isFile: (ref: FileRef) => boolean, isNote: (ref: FileRef) => boolean) {
  if (!markdown.includes("[")) return [];
  const root = fromMarkdown(markdown);
  const definitions = new Map<string, string>();
  function definitionsIn(node: MarkdownNode) {
    if (node.type === "definition" && node.url && node.identifier && !definitions.has(node.identifier)) {
      definitions.set(node.identifier, node.url);
    }
    node.children?.forEach(definitionsIn);
  }
  definitionsIn(root);
  const refs = new Map<string, FileRef>();
  function collect(node: MarkdownNode, insideLink = false) {
    const link = node.type === "link" || node.type === "linkReference";
    const image = !insideLink && (node.type === "image" || node.type === "imageReference");
    if (link || image) {
      const ref = parseFileRef(node.url ?? definitions.get(node.identifier ?? ""));
      if (ref && (image ? isNote(ref) : isFile(ref))) refs.set(refKey(ref), ref);
    }
    node.children?.forEach((child) => collect(child, insideLink || link));
  }
  collect(root);
  return [...refs.values()];
}

/** Share the same reference order between inline markers and the Sources view. */
export function useAnswerReferences(content: string, streaming: boolean) {
  const { getFile } = useWorkspace();
  const isNote = useCallback(({ path }: FileRef) => {
    const file = /\.md(?:own)?$|\.markdown$/i.test(path) ? getFile(path) : undefined;
    return Boolean(file && isTextFile(file));
  }, [getFile]);
  // Streamdown can render clickable links as they arrive. Number and index
  // references once the message settles to avoid parsing the full answer per delta.
  const settledContent = streaming ? "" : content;
  const sources = useMemo(
    () => answerSources(settledContent, ({ path }) => Boolean(getFile(path)), isNote),
    [settledContent, getFile, isNote],
  );
  const markdownRenderer = useMemo<CopilotChatAssistantMessageProps["markdownRenderer"]>(() => {
    const noteImages = () => workspaceNoteImages((href) => {
      const ref = parseFileRef(href);
      return ref !== null && isNote(ref);
    });
    return {
      components: { a: AnswerLink },
      rehypePlugins: [...Object.values(beforeHarden), noteImages, rootRelativeLinks, harden],
    };
  }, [isNote]);
  return { sources, markdownRenderer };
}

export const AnswerSources = SourcesContext.Provider;

function AnswerLink({ href, className, children, node: _node, ...props }: ComponentProps<"a"> & { node?: unknown }) {
  const fileRef = parseFileRef(href);
  return fileRef ? <FileRefLink fileRef={fileRef}>{children}</FileRefLink> : (
    <a data-streamdown="link" href={href} rel="noreferrer" target="_blank" {...props}
      className={cn("wrap-anywhere font-medium text-primary underline", className)}>{children}</a>
  );
}

function FileRefLink({ fileRef, children }: { fileRef: FileRef; children: ReactNode }) {
  const sources = useContext(SourcesContext);
  const { getFile } = useWorkspace();
  const { open } = useWorkbench().editor;
  const { path, lines } = fileRef;
  const file = getFile(path);
  const label = [path, lineLabel(lines)].filter(Boolean).join(" · ");
  const number = sources.findIndex((source) => refKey(source) === refKey(fileRef)) + 1;
  if (!file) return <span title={`${label} (not a file in your workspace)`} className="text-muted-foreground underline decoration-dashed">{children}</span>;
  return (
    <button type="button" data-testid="file-ref" title={label} aria-label={`Open ${label}`}
      onClick={() => open(file.path, lines)}
      className="group/cite cursor-pointer text-brand-text underline decoration-current/40 underline-offset-2 wrap-anywhere hover:decoration-current">
      {/* The link text is often a noun the sentence needs, so it stays visible; the number matches Sources. */}
      {children}{number > 0 && (
        <span data-testid="citation-number" aria-hidden="true"
          className="ms-0.75 inline-grid h-4 min-w-4 place-items-center rounded bg-brand-tint px-0.75 align-super text-[.625rem] leading-none font-semibold group-hover/cite:outline group-hover/cite:outline-brand group-focus-visible/cite:outline group-focus-visible/cite:outline-brand">
          {number}
        </span>
      )}
    </button>
  );
}

/** An icon on a brand tint: marks the chat and Claude's answers. */
export function BrandMark({ icon: Icon }: { icon: LucideIcon }) {
  return <Icon aria-hidden="true" className="box-content size-3.5 rounded-lg bg-brand-tint p-1.25 text-brand-text" />;
}

/**
 * Copy and the like, small, at the end of a header row. Keeps CopilotKit's
 * toolbar test id so the buttons are found the same way as before.
 */
function AnswerActions({ children }: { children: ReactNode }) {
  return (
    <div data-testid="copilot-assistant-toolbar"
      className="ms-auto flex shrink-0 items-center gap-0.5 font-normal [&_button]:size-6! [&_button]:rounded-md! [&_svg]:size-3.5!">
      {children}
    </div>
  );
}

export function ChatAnswer({ children, isRunning, actions }: { children: ReactNode; isRunning?: boolean; actions?: ReactNode }) {
  const sources = useContext(SourcesContext);
  const [view, setView] = useState<"answer" | "sources">("answer");
  const showSources = sources.length > 0 && view === "sources";
  const tools = actions ? <AnswerActions>{actions}</AnswerActions> : null;
  return (
    <>
      <div className="mb-2.5 flex items-center gap-2 text-body font-semibold">
        <BrandMark icon={MessagesSquare} /> Claude
        {sources.length === 0 && tools}
      </div>
      {sources.length > 0 && (
        <div className="mb-2.5 flex items-center gap-2 border-b border-[var(--border)] pb-1">
          <SegmentedControl aria-label="Answer view" className="border-0 pb-0">
            <SegmentedControlItem selected={!showSources} onClick={() => setView("answer")}>Answer</SegmentedControlItem>
            <SegmentedControlItem selected={showSources} onClick={() => setView("sources")}>Sources <span>{sources.length}</span></SegmentedControlItem>
          </SegmentedControl>
          {tools}
        </div>
      )}
      {showSources ? <ChatSources sources={sources} /> : (
        <div aria-busy={isRunning || undefined} className="cpk:prose cpk:max-w-full cpk:break-words cpk:dark:prose-invert min-w-0 wrap-anywhere!">{children}</div>
      )}
    </>
  );
}

function ChatSources({ sources }: { sources: FileRef[] }) {
  const { getFile, loadFile } = useWorkspace();
  const { open } = useWorkbench().editor;
  const [selected, setSelected] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const ref = sources.find((source) => refKey(source) === selected);
  const file = ref && getFile(ref.path);
  const text = file && isTextFile(file) && !file.unloaded ? file.content.replace(/\r\n?/g, "\n") : null;
  const offsets = text !== null && ref?.lines ? lineOffsets(text, ref.lines) : null;
  const excerpt = text === null ? null : (offsets ? text.slice(offsets[0], offsets[1]) : text).slice(0, 1600);

  return (
    <div className="grid gap-1.5" data-testid="chat-sources">
      {sources.map((source, i) => {
        const key = refKey(source);
        const label = lineLabel(source.lines);
        return (
          <button key={key} type="button" aria-expanded={key === selected}
            className="flex cursor-pointer items-center gap-2 rounded-lg border border-[var(--border)] px-2.5 py-2 text-start text-body hover:bg-surface-raised hover:text-brand-text aria-expanded:bg-surface-raised aria-expanded:text-brand-text [&_svg]:size-4 [&_svg]:shrink-0"
            onClick={() => {
              setSelected(key === selected ? null : key);
              if (key === selected) return;
              setFailure(null);
              void loadFile(source.path).catch(() => setFailure(key));
            }}>
            <span aria-hidden="true">{i + 1}</span><FileText aria-hidden="true" />
            <span className="min-w-0"><span className="block truncate font-medium" title={source.path}>{fileName(source.path)}</span>
              {label && <small className="block text-muted-foreground">{label}</small>}
            </span>
          </button>
        );
      })}
      {ref && file && (
        <div className="rounded-lg bg-surface-raised p-2.5">
          <div className="flex items-center justify-between gap-2 text-label">
            <span className="min-w-0 truncate font-medium" title={ref.path}>{fileName(ref.path)}</span>
            <button type="button" onClick={() => open(file.path, ref.lines)}
              className={cn(buttonVariants({ variant: "quiet", size: "xs" }), "shrink-0")}>
              <ExternalLink aria-hidden="true" /> Open in editor
            </button>
          </div>
          {excerpt !== null ? <pre className="mt-1.5 max-h-48 overflow-auto text-label whitespace-pre-wrap wrap-anywhere">{excerpt}</pre> : file.unloaded && (
            <p role="status" className="text-xs text-muted-foreground">{failure === selected ? "Couldn't load the excerpt." : "Loading excerpt…"}</p>
          )}
        </div>
      )}
    </div>
  );
}
