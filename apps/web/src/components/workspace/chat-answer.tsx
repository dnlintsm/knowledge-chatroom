"use client";

import { createContext, useContext, useMemo, useState, type ComponentProps, type ReactNode } from "react";
import { ExternalLink, FileText, MessagesSquare } from "lucide-react";
import { fromMarkdown } from "mdast-util-from-markdown";
import { defaultRehypePlugins } from "streamdown";
import type { CopilotChatAssistantMessageProps } from "@copilotkit/react-core/v2";
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
export function useAnswerReferences(content: string) {
  const { getFile } = useWorkspace();
  return useMemo(() => {
    const isNote = ({ path }: FileRef) => {
      const file = /\.md(?:own)?$|\.markdown$/i.test(path) ? getFile(path) : undefined;
      return Boolean(file && isTextFile(file));
    };
    const sources = answerSources(content, ({ path }) => Boolean(getFile(path)), isNote);
    const noteImages = () => workspaceNoteImages((href) => {
      const ref = parseFileRef(href);
      return ref !== null && isNote(ref);
    });
    const markdownRenderer: CopilotChatAssistantMessageProps["markdownRenderer"] = {
      components: { a: AnswerLink },
      rehypePlugins: [...Object.values(beforeHarden), noteImages, rootRelativeLinks, harden],
    };
    return { sources, markdownRenderer };
  }, [content, getFile]);
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
      onClick={() => open(file.path, lines)} className={number ? "kc-citation" : "kc-citation-link"}>
      {number ? <><span aria-hidden="true">{number}</span><span className="sr-only">{children}</span></> : children}
    </button>
  );
}

export function ChatAnswer({ children, isRunning }: { children: ReactNode; isRunning?: boolean }) {
  const sources = useContext(SourcesContext);
  const [view, setView] = useState<"answer" | "sources">("answer");
  const showSources = sources.length > 0 && view === "sources";
  return (
    <>
      <div className="kc-assistant-heading"><MessagesSquare aria-hidden="true" /> Claude</div>
      {sources.length > 0 && (
        <div role="group" aria-label="Answer view" className="kc-answer-views">
          <button type="button" aria-pressed={!showSources} onClick={() => setView("answer")}>Answer</button>
          <button type="button" aria-pressed={showSources} onClick={() => setView("sources")}>Sources <span>{sources.length}</span></button>
        </div>
      )}
      {showSources ? <ChatSources sources={sources} /> : (
        <div aria-busy={isRunning || undefined} className="cpk:prose cpk:max-w-full cpk:break-words cpk:dark:prose-invert kc-answer-markdown">{children}</div>
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
    <div className="kc-sources" data-testid="chat-sources">
      {sources.map((source, i) => {
        const key = refKey(source);
        const label = lineLabel(source.lines);
        return (
          <button key={key} type="button" aria-expanded={key === selected} className="kc-source-row"
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
        <div className="kc-source-preview">
          <div className="flex items-center justify-between gap-2 text-xs">
            <span className="min-w-0 truncate font-medium" title={ref.path}>{fileName(ref.path)}</span>
            <button type="button" onClick={() => open(file.path, ref.lines)} className="kc-control shrink-0">
              <ExternalLink aria-hidden="true" /> Open in editor
            </button>
          </div>
          {excerpt !== null ? <pre>{excerpt}</pre> : file.unloaded && (
            <p role="status" className="text-xs text-muted-foreground">{failure === selected ? "Couldn't load the excerpt." : "Loading excerpt…"}</p>
          )}
        </div>
      )}
    </div>
  );
}
