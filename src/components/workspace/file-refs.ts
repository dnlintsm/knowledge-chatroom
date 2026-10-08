/**
 * File references: the contract that lets a chat answer point at a workspace
 * file, or lines in it, so that clicking the reference opens them in the
 * middle pane.
 *
 * A reference is a plain Markdown link whose target is the file's workspace
 * path with an optional GitHub-style line fragment, the format Claude Code
 * uses in IDEs:
 *
 *   [welcome.md](notes/welcome.md)                  the whole file
 *   [welcome.md:12](notes/welcome.md#L12)           line 12
 *   [welcome.md:12-18](notes/welcome.md#L12-L18)    lines 12 to 18
 *
 * Paths are relative to the workspace root, as listWorkspaceFiles returns them
 * (a leading "/" or "./" is fine). Lines are 1-based and inclusive, and match
 * the numbers Claude sees in numberLines() output. The parser also accepts
 * "#L12-18", "#L12C3-L18C1" and an editor-style "notes/welcome.md:12" target.
 * Links with a scheme (https:, mailto:) are ordinary links; any other link
 * names a workspace path, even when no file is there.
 */

export interface LineRange {
  /** First line, 1-based. */
  start: number;
  /** Last line, inclusive. */
  end: number;
}

export interface FileRef {
  path: string;
  lines?: LineRange;
}

const SCHEME = /^[a-z][a-z\d+.-]*:/i;
const LINE_FRAGMENT = /^#L(\d+)(?:C\d+)?(?:-L?(\d+)(?:C\d+)?)?$/i;
const LINE_SUFFIX = /^(.+?):(\d+)(?:-(\d+))?(?::\d+)?$/;

/** Reads a link target as a file reference; null for web links and links without a path. */
export function parseFileRef(href: string | undefined): FileRef | null {
  if (!href || SCHEME.test(href) || href.startsWith("//") || href.startsWith("#")) return null;
  let url: URL;
  try {
    url = new URL(href, "http://workspace/");
  } catch {
    return null;
  }
  let path = decode(url.pathname).slice(1);
  const fragment = LINE_FRAGMENT.exec(url.hash);
  let lines = fragment ? lineRange(fragment[1], fragment[2]) : undefined;
  const suffix = LINE_SUFFIX.exec(path);
  if (suffix) {
    path = suffix[1];
    lines ??= lineRange(suffix[2], suffix[3]);
  }
  if (!path) return null;
  return lines ? { path, lines } : { path };
}

function decode(text: string) {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

function lineRange(start: string, end?: string): LineRange | undefined {
  const a = Number(start);
  const b = end ? Number(end) : a;
  if (!(a >= 1 && b >= 1)) return undefined;
  return { start: Math.min(a, b), end: Math.max(a, b) };
}

/**
 * Prefixes each line with its 1-based number and a tab ("12\tText"), so Claude
 * can cite lines in the content it is given.
 */
export function numberLines(text: string) {
  const lines = text.split(/\r\n|\r|\n/);
  const width = String(lines.length).length;
  return lines.map((line, i) => `${String(i + 1).padStart(width)}\t${line}`).join("\n");
}

/**
 * Character offsets [from, to) spanning `lines` of `text` (with "\n" line
 * breaks, as in textarea.value), or null when they start past its end.
 */
export function lineOffsets(text: string, { start, end }: LineRange): [number, number] | null {
  const starts = [0];
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) starts.push(i + 1);
  if (start > starts.length) return null;
  return [starts[start - 1], end < starts.length ? starts[end] - 1 : text.length];
}

/**
 * Which rendered blocks a line range lands on, given the source lines of each
 * block in document order (an element before the blocks nested in it): the
 * outermost blocks that overlap the range or, for a range on blank lines, the
 * first block after it.
 */
export function blocksForLines(blocks: LineRange[], lines: LineRange): number[] {
  const hits: number[] = [];
  blocks.forEach((block, i) => {
    const overlaps = block.start <= lines.end && block.end >= lines.start;
    const nested = hits.some((h) => blocks[h].start <= block.start && block.end <= blocks[h].end);
    if (overlaps && !nested) hits.push(i);
  });
  if (hits.length) return hits;
  const next = blocks.findIndex((block) => block.start > lines.end);
  return next === -1 ? [] : [next];
}

/** The parts of a hast (HTML syntax tree) node the rehype plugins below use. */
interface HastNode {
  type: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
  position?: { start: { line: number }; end: { line: number } };
}

/** A scheme, "/", "#", "./" or "../": anything but a bare relative path. */
const NOT_BARE_PATH = /^(?:[a-z][a-z\d+.-]*:|\/|#|\.\.?\/)/i;

function rootRelative(node: HastNode) {
  const href = node.tagName === "a" ? node.properties?.href : undefined;
  if (typeof href === "string" && href && !NOT_BARE_PATH.test(href)) node.properties!.href = `/${href}`;
  node.children?.forEach(rootRelative);
}

/**
 * Rehype plugin for chat answers, placed before Streamdown's harden step: that
 * step blocks bare relative links such as notes/welcome.md#L12 but keeps
 * root-relative ones, so this turns the first kind into the second.
 */
export const rootRelativeLinks = () => rootRelative;

/** Block elements a reference can land on in the markdown preview. */
const LINE_TAGS = new Set(["p", "h1", "h2", "h3", "h4", "h5", "h6", "li", "tr", "hr", "pre"]);

function stampLines(parent: HastNode) {
  parent.children?.forEach((node, i) => {
    if (node.type !== "element") return;
    const { position } = node;
    if (position && LINE_TAGS.has(node.tagName!)) {
      const lines = { dataLine: position.start.line, dataLineEnd: position.end.line };
      if (node.tagName === "pre") {
        // Streamdown renders code blocks without passing attributes on, so wrap them.
        parent.children![i] = { type: "element", tagName: "div", properties: lines, children: [node] };
        return;
      }
      node.properties = { ...node.properties, ...lines };
    }
    stampLines(node);
  });
}

/**
 * Rehype plugin for the markdown preview: stamps block elements with the source
 * lines they came from (data-line, data-line-end), so references can find them.
 */
export const sourceLines = () => stampLines;
