"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Bot, Eye, ListTodo, Lock, Pencil, X } from "lucide-react";
import { defaultRehypePlugins, Streamdown } from "streamdown";
import { ExampleCanvas } from "@/components/example-canvas";
import { cn } from "@/lib/utils";
import { parseCsv } from "./csv";
import { FileIcon } from "./file-icon";
import { blocksForLines, lineOffsets, sourceLines, type LineRange } from "./file-refs";
import { useWorkspace } from "./store";
import { extension, fileName, isMarkdown, isTextFile, TASKS_TAB, type WorkspaceFile } from "./types";

type Mode = "preview" | "edit";

const PREVIEW_REHYPE_PLUGINS = [...Object.values(defaultRehypePlugins), sourceLines];

function canPreview(file: WorkspaceFile) {
  return isMarkdown(file) || extension(file.path) === "csv";
}

export function EditorPane() {
  const { tabs, active, activeFile, getFile, open, close } = useWorkspace();
  // Remembered per file; empty files start in edit mode so new notes are typeable.
  const [modes, setModes] = useState<Record<string, Mode>>({});
  const tabsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    tabsRef.current
      ?.querySelector('[aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [active]);
  const readOnly = Boolean(activeFile?.readOnly);
  // Read-only files that can be previewed only ever show the preview.
  const mode: Mode | null =
    activeFile && canPreview(activeFile)
      ? readOnly
        ? "preview"
        : (modes[activeFile.path] ?? (activeFile.content ? "preview" : "edit"))
      : null;

  return (
    <section aria-label="Editor" className="flex h-full min-h-0 min-w-0 flex-col bg-[var(--background)]">
      <div className="flex h-10 shrink-0 items-stretch border-b border-[var(--border)] bg-[var(--secondary)]">
        <div ref={tabsRef} role="tablist" className="flex min-w-0 flex-1 overflow-x-auto">
          {tabs.map((tab) => {
            const file = tab === TASKS_TAB ? null : getFile(tab);
            const selected = tab === active;
            return (
              <div
                key={tab}
                role="tab"
                aria-selected={selected}
                tabIndex={0}
                title={tab === TASKS_TAB ? "Task board" : tab}
                onClick={() => open(tab)}
                onKeyDown={(e) => e.key === "Enter" && open(tab)}
                onAuxClick={(e) => e.button === 1 && close(tab)}
                className={cn(
                  "group flex shrink-0 cursor-pointer items-center gap-1.5 border-r border-[var(--border)] pl-3 pr-1.5 text-[13px]",
                  selected
                    ? "bg-[var(--background)] text-[var(--foreground)] shadow-[inset_0_2px_0_var(--cpk-lilac-400)]"
                    : "text-[var(--muted-foreground)] hover:text-[var(--foreground)]",
                )}
              >
                {tab === TASKS_TAB ? (
                  <ListTodo className="size-3.5" />
                ) : file ? (
                  <FileIcon file={file} className="size-3.5" />
                ) : null}
                <span className="max-w-[180px] truncate">{tab === TASKS_TAB ? "Task board" : fileName(tab)}</span>
                <button
                  type="button"
                  aria-label="Close tab"
                  onClick={(e) => {
                    e.stopPropagation();
                    close(tab);
                  }}
                  className={cn(
                    "flex size-5 items-center justify-center rounded hover:bg-[var(--muted)] cursor-pointer",
                    selected ? "opacity-100" : "opacity-0 group-hover:opacity-100",
                  )}
                >
                  <X className="size-3.5" />
                </button>
              </div>
            );
          })}
        </div>
      </div>

      {activeFile && (
        <div className="flex h-9 shrink-0 items-center gap-3 border-b border-[var(--border)] px-4 text-xs text-[var(--muted-foreground)]">
          <span className="truncate font-[family-name:var(--font-code)]">{activeFile.path}</span>
          {activeFile.author === "agent" && (
            <span className="flex items-center gap-1 rounded-full bg-[var(--accent)] px-2 py-0.5 text-[var(--accent-foreground)]">
              <Bot className="size-3" /> Written by Claude
            </span>
          )}
          {readOnly && (
            <span
              data-testid="read-only-badge"
              title="This file can't be edited or deleted"
              className="flex shrink-0 items-center gap-1 rounded-full bg-[var(--secondary)] px-2 py-0.5 text-[var(--foreground)]"
            >
              <Lock className="size-3" /> Read-only
            </span>
          )}
          <span className="ml-auto shrink-0 max-sm:hidden">
            {new Date(activeFile.updatedAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}
          </span>
          {mode && !readOnly && (
            <div role="group" aria-label="View mode" className="flex shrink-0 rounded-md border border-[var(--border)] p-0.5">
              {(["preview", "edit"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  aria-pressed={mode === m}
                  onClick={() => setModes((s) => ({ ...s, [activeFile.path]: m }))}
                  className={cn(
                    "flex items-center gap-1 rounded px-2 py-0.5 capitalize cursor-pointer",
                    mode === m && "bg-[var(--secondary)] text-[var(--foreground)]",
                  )}
                >
                  {m === "preview" ? <Eye className="size-3" /> : <Pencil className="size-3" />}
                  {m}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto">
        {active === TASKS_TAB ? (
          <ExampleCanvas />
        ) : activeFile ? (
          <FileView key={activeFile.path} file={activeFile} mode={mode} />
        ) : (
          <EmptyState />
        )}
      </div>
    </section>
  );
}

function FileView({ file, mode }: { file: WorkspaceFile; mode: Mode | null }) {
  const { write, setSelection, reveal } = useWorkspace();
  const previewRef = useRef<HTMLElement>(null);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const lines = reveal?.path === file.path ? reveal.lines : null;

  // Lines a chat reference points at (file-refs.ts): highlighted in the preview,
  // selected in the editor. Switching modes shows them again in the new view.
  useEffect(() => {
    if (!lines) return;
    if (previewRef.current) return highlightLines(previewRef.current, lines);
    if (editorRef.current) selectLines(editorRef.current, lines);
  }, [lines, mode]);

  const captureSelection = () => setSelection(window.getSelection()?.toString().trim() ?? "");

  if (file.mime.startsWith("image/")) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        {/* eslint-disable-next-line @next/next/no-img-element -- data: URL from an upload */}
        <img src={file.content} alt={file.path} className="max-h-full max-w-full rounded-lg shadow" />
      </div>
    );
  }

  if (!isTextFile(file)) {
    return (
      <Centered>
        No preview for this file type yet. Claude can still see that it exists.
      </Centered>
    );
  }

  if (mode === "preview") {
    return (
      <article
        ref={previewRef}
        data-testid="file-preview"
        onMouseUp={captureSelection}
        onKeyUp={captureSelection}
        className="mx-auto max-w-3xl px-8 py-8 text-[15px] leading-relaxed"
      >
        {isMarkdown(file) ? <Markdown text={file.content} /> : <CsvTable text={file.content} />}
      </article>
    );
  }

  return (
    <textarea
      ref={editorRef}
      data-testid="file-editor"
      aria-label={`Edit ${file.path}`}
      value={file.content}
      readOnly={file.readOnly}
      spellCheck={isMarkdown(file)}
      autoFocus={!file.content}
      placeholder="Start typing…"
      onChange={(e) => {
        if (!file.readOnly) write(file.path, e.target.value);
      }}
      onSelect={(e) => {
        const t = e.currentTarget;
        setSelection(t.value.slice(t.selectionStart, t.selectionEnd).trim());
      }}
      className="block h-full w-full resize-none bg-transparent px-8 py-6 font-[family-name:var(--font-code)] text-[13px] leading-6 outline-none"
    />
  );
}

/** Markdown with YAML front matter (as in SKILL.md) shown as a metadata card. */
function Markdown({ text }: { text: string }) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  const frontMatter = match?.[0] ?? "";
  const meta = match?.[1]
    .split(/\r?\n/)
    .map((line) => /^([\w-]+):\s*(.*)$/.exec(line))
    .filter((m): m is RegExpExecArray => Boolean(m));
  return (
    <>
      {meta && meta.length > 0 && (
        <dl
          data-line={1}
          data-line-end={frontMatter.trimEnd().split(/\r?\n/).length}
          className="mb-6 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-lg border border-[var(--border)] bg-[var(--secondary)] px-4 py-3 text-sm"
        >
          {meta.map(([, key, value]) => (
            <div key={key} className="contents">
              <dt className="font-[family-name:var(--font-code)] text-[var(--muted-foreground)]">{key}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      )}
      {/* Static mode parses the whole text at once, so source positions are file
          lines; blanking the front matter (not cutting it) keeps them that way. */}
      <Streamdown mode="static" rehypePlugins={PREVIEW_REHYPE_PLUGINS}>
        {frontMatter.replace(/[^\r\n]/g, "") + text.slice(frontMatter.length)}
      </Streamdown>
    </>
  );
}

function CsvTable({ text }: { text: string }) {
  const [head, ...body] = parseCsv(text);
  return (
    <table className="w-full border-collapse text-sm">
      <thead>
        <tr data-line={head?.lines.start} data-line-end={head?.lines.end}>
          {head?.cells.map((cell, i) => (
            <th key={i} className="border-b-2 border-[var(--border)] px-3 py-2 text-left font-semibold">
              {cell}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {body.map((row, r) => (
          <tr key={r} data-line={row.lines.start} data-line-end={row.lines.end}>
            {row.cells.map((cell, i) => (
              <td key={i} className="whitespace-pre-line border-b border-[var(--border)] px-3 py-2">
                {cell}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Marks the preview blocks `lines` came from and centers the first; returns the undo. */
function highlightLines(root: HTMLElement, lines: LineRange) {
  const blocks = Array.from(root.querySelectorAll<HTMLElement>("[data-line]"));
  const spans = blocks.map((el) => ({ start: Number(el.dataset.line), end: Number(el.dataset.lineEnd) }));
  const hits = blocksForLines(spans, lines).map((i) => blocks[i]);
  hits.forEach((el) => (el.dataset.revealed = ""));
  hits[0]?.scrollIntoView({ block: "center" });
  return () => hits.forEach((el) => delete el.dataset.revealed);
}

/** Selects `lines` in the editor and scrolls them a third of the way down. */
function selectLines(textarea: HTMLTextAreaElement, lines: LineRange) {
  const range = lineOffsets(textarea.value, lines);
  if (!range) return;
  textarea.focus({ preventScroll: true });
  textarea.setSelectionRange(...range);
  textarea.scrollTop = lineTop(textarea, range[0]) - textarea.clientHeight / 3;
}

const MIRRORED_STYLES = [
  "fontFamily", "fontSize", "fontStyle", "fontWeight", "letterSpacing", "lineHeight",
  "tabSize", "wordSpacing", "paddingTop", "paddingRight", "paddingLeft",
] as const;

/** How far below the top of the textarea's content the line holding `index` starts, wrapping included. */
function lineTop(textarea: HTMLTextAreaElement, index: number) {
  const style = getComputedStyle(textarea);
  const mirror = document.createElement("div");
  for (const prop of MIRRORED_STYLES) mirror.style[prop] = style[prop];
  Object.assign(mirror.style, {
    position: "absolute",
    visibility: "hidden",
    boxSizing: "border-box",
    width: `${textarea.clientWidth}px`,
    whiteSpace: "pre-wrap",
    overflowWrap: "break-word",
  });
  mirror.textContent = textarea.value.slice(0, index);
  const marker = mirror.appendChild(document.createElement("span"));
  marker.textContent = "\u200b";
  document.body.append(mirror);
  const top = marker.offsetTop;
  mirror.remove();
  return top;
}

function Centered({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center p-8 text-center text-sm text-[var(--muted-foreground)]">
      <div className="max-w-sm">{children}</div>
    </div>
  );
}

function EmptyState() {
  return (
    <Centered>
      <p className="mb-1 text-base font-semibold text-[var(--foreground)]">No file open</p>
      Pick a file on the left, drop one in to upload, or ask Claude to write something.
    </Centered>
  );
}
