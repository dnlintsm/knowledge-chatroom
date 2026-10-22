"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Download, ExternalLink, Maximize2, Minimize2, TriangleAlert } from "lucide-react";
import { Streamdown } from "streamdown";
import { cn } from "@/lib/utils";
import { codeLanguage, fileName, type PreviewKind, type WorkspaceFile } from "./types";

/**
 * Viewers for files the editor pane can't edit as text: images, PDFs, audio
 * and video, plus highlighted code and rendered HTML. Binary content is a
 * URL: /api/files/… (a redirect to the object store at S3_PUBLIC_URL) with
 * server storage, or a data: URL for files kept in this browser.
 */

type MediaKind = Extract<PreviewKind, "image" | "pdf" | "audio" | "video">;

// Big files are shown as plain text: highlighting them would stall the page.
const MAX_HIGHLIGHT_CHARS = 200_000;

const CHECKERBOARD = {
  background: "repeating-conic-gradient(rgb(128 128 128 / 0.15) 0% 25%, transparent 0% 50%) 50% / 16px 16px",
};

/**
 * A URL the browser can open in a frame or a new tab. Browsers refuse
 * data: URLs there (and they are slow for big media), so those become blob: URLs.
 */
function useOpenableUrl(content: string) {
  const isData = content.startsWith("data:");
  const [url, setUrl] = useState<string | null>(isData ? null : content);
  useEffect(() => {
    if (!isData) {
      setUrl(content);
      return;
    }
    let made: string | null = null;
    let live = true;
    fetch(content)
      .then((res) => res.blob())
      .then((blob) => {
        made = URL.createObjectURL(blob);
        if (live) setUrl(made);
        else URL.revokeObjectURL(made);
      })
      .catch(() => live && setUrl(content));
    return () => {
      live = false;
      if (made) URL.revokeObjectURL(made);
    };
  }, [content, isData]);
  return url;
}

export function MediaPreview({ file, kind }: { file: WorkspaceFile; kind: MediaKind }) {
  const url = useOpenableUrl(file.content);
  const [failed, setFailed] = useState(false);
  if (!url) return null;
  if (failed) return <LoadError file={file} url={url} kind={kind} />;
  const onError = () => setFailed(true);
  switch (kind) {
    case "image":
      return <ImageView file={file} url={url} onError={onError} />;
    case "pdf":
      return (
        <iframe
          data-testid="pdf-preview"
          title={file.path}
          src={url}
          className="block h-full w-full border-0 bg-[var(--secondary)]"
        />
      );
    case "audio":
      return (
        <div className="flex h-full flex-col items-center justify-center gap-4 p-8">
          <p className="text-sm text-[var(--muted-foreground)]">{fileName(file.path)}</p>
          <audio data-testid="audio-preview" controls preload="metadata" src={url} onError={onError} className="w-full max-w-lg" />
        </div>
      );
    case "video":
      return (
        <div className="flex h-full items-center justify-center bg-black/90 p-4">
          <video data-testid="video-preview" controls preload="metadata" src={url} onError={onError} className="max-h-full max-w-full" />
        </div>
      );
  }
}

function ImageView({ file, url, onError }: { file: WorkspaceFile; url: string; onError: () => void }) {
  const [actualSize, setActualSize] = useState(false);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-9 shrink-0 items-center gap-3 border-b border-[var(--border)] px-4 text-xs text-[var(--muted-foreground)]">
        {size && (
          <span data-testid="image-size">
            {size.width} × {size.height}
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          <ToolbarButton onClick={() => setActualSize((v) => !v)}>
            {actualSize ? <Minimize2 className="size-3" /> : <Maximize2 className="size-3" />}
            {actualSize ? "Fit" : "Actual size"}
          </ToolbarButton>
          <OpenLink url={url} />
        </div>
      </div>
      <div className="flex min-h-0 flex-1 overflow-auto p-6">
        <img
          data-testid="image-preview"
          src={url}
          alt={file.path}
          onLoad={(e) => setSize({ width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight })}
          onError={onError}
          onClick={() => setActualSize((v) => !v)}
          style={CHECKERBOARD}
          className={cn(
            // Auto margins center it without clipping when it is bigger than the pane.
            "m-auto rounded-lg shadow",
            actualSize ? "max-w-none cursor-zoom-out" : "max-h-full max-w-full object-contain cursor-zoom-in",
          )}
        />
      </div>
    </div>
  );
}

function LoadError({ file, url, kind }: { file: WorkspaceFile; url: string; kind: MediaKind }) {
  const stored = url.startsWith("/api/files/");
  return (
    <Centered>
      <TriangleAlert className="mx-auto mb-2 size-5 text-amber-500" />
      <p data-testid="preview-error" className="mb-1 text-base font-semibold text-[var(--foreground)]">
        Couldn&apos;t show this {kind === "pdf" ? "PDF" : kind}
      </p>
      <p className="mb-4">
        Your browser may not support its format{kind === "image" ? " (HEIC and TIFF, for example)" : ""}
        {stored
          ? ", or it can't reach the file store. Files on the server load from S3_PUBLIC_URL, which must be reachable from this browser (and be https when the app is)."
          : "."}
      </p>
      <div className="flex justify-center gap-2">
        <OpenLink url={url} />
        <DownloadLink file={file} url={url} />
      </div>
    </Centered>
  );
}

/** Files with no viewer: say so, and offer the file itself. */
export function NoPreview({ file }: { file: WorkspaceFile }) {
  const url = useOpenableUrl(file.content);
  return (
    <Centered>
      <p className="mb-4">No preview for this file type yet. Claude can still see that it exists.</p>
      {url && (
        <div className="flex justify-center">
          <DownloadLink file={file} url={url} />
        </div>
      )}
    </Centered>
  );
}

/** HTML rendered in a sandbox: no scripts, forms or access to this app. */
export function HtmlPreview({ file }: { file: WorkspaceFile }) {
  return (
    <iframe
      data-testid="html-preview"
      title={file.path}
      sandbox=""
      srcDoc={file.content}
      className="block h-full w-full border-0 bg-white"
    />
  );
}

/** Source with syntax highlighting, as a fenced block in the markdown renderer. */
export function CodePreview({ file }: { file: WorkspaceFile }) {
  const text = file.content;
  if (text.length > MAX_HIGHLIGHT_CHARS) {
    return <pre className="whitespace-pre-wrap font-[family-name:var(--font-code)] text-[13px] leading-6">{text}</pre>;
  }
  // A fence longer than any backtick run inside, so the file can't close it early.
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return (
    <div data-testid="code-preview" className="[&_pre]:text-[13px]">
      <Streamdown mode="static">{`${fence}${codeLanguage(file.path) ?? ""}\n${text}\n${fence}`}</Streamdown>
    </div>
  );
}

function ToolbarButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-1 rounded px-2 py-0.5 hover:bg-[var(--secondary)] hover:text-[var(--foreground)] cursor-pointer"
    >
      {children}
    </button>
  );
}

const linkClass =
  "flex items-center gap-1 rounded-md border border-[var(--border)] px-2 py-0.5 text-xs hover:bg-[var(--secondary)] hover:text-[var(--foreground)]";

function OpenLink({ url }: { url: string }) {
  return (
    <a href={url} target="_blank" rel="noreferrer" className={linkClass}>
      <ExternalLink className="size-3" /> Open
    </a>
  );
}

function DownloadLink({ file, url }: { file: WorkspaceFile; url: string }) {
  return (
    <a href={url} download={fileName(file.path)} className={linkClass}>
      <Download className="size-3" /> Download
    </a>
  );
}

export function Centered({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center p-8 text-center text-sm text-[var(--muted-foreground)]">
      <div className="max-w-sm">{children}</div>
    </div>
  );
}
