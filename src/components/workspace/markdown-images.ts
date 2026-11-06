/**
 * Images in the Markdown preview that point at workspace files, such as
 * `![plot](./uploads/plot.png)` in notes/report.md. Like on GitHub, the path
 * is read relative to the document's folder.
 */

/**
 * The workspace path an image `src` in the document at `docPath` points at,
 * or null for anything else: URLs (http:, data:, ...), absolute paths,
 * fragments, and paths that climb out of the workspace.
 */
export function workspaceImagePath(docPath: string, src: unknown): string | null {
  if (typeof src !== "string") return null;
  const raw = src.trim();
  if (!raw || /^(?:[a-z][a-z\d+.-]*:|\/|#)/i.test(raw)) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw.replace(/[?#].*$/, ""));
  } catch {
    return null;
  }
  const segments = decoded.replace(/\\/g, "/").split("/");
  // A folder (ending in /, . or ..) is never an image.
  if (["", ".", ".."].includes(segments.at(-1)!)) return null;
  const parts = docPath.split("/").slice(0, -1);
  for (const segment of segments) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (!parts.length) return null;
      parts.pop();
    } else {
      parts.push(segment);
    }
  }
  return parts.length ? parts.join("/") : null;
}

interface HastNode {
  type: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

export interface WorkspaceImagesOptions {
  /**
   * Streamdown caches its processors by plugin name and JSON options, so this
   * must change whenever `url` would answer differently (the document, the
   * image files), or an older document's lookup is reused.
   */
  key: string;
  /** The URL to show for an image `src`, or null to leave it alone. */
  url: (src: string) => string | null;
}

/**
 * Rehype plugin for the Markdown preview, used as `[workspaceImages, options]`
 * before Streamdown's harden step (which blocks bare relative image paths and
 * turns ./ and ../ ones into root paths): points each image that
 * `options.url` knows at the file's own URL.
 */
export function workspaceImages(options: WorkspaceImagesOptions) {
  const visit = (node: HastNode) => {
    const src = node.tagName === "img" ? node.properties?.src : undefined;
    if (typeof src === "string") {
      const found = options.url(src);
      if (found) node.properties!.src = found;
    }
    node.children?.forEach(visit);
  };
  return visit;
}
