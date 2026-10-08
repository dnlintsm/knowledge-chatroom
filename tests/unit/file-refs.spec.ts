import { test, expect } from "@playwright/test";
import { parseCsv } from "../../src/components/workspace/csv";
import {
  blocksForLines,
  lineOffsets,
  numberLines,
  parseFileRef,
  rootRelativeLinks,
  sourceLines,
} from "../../src/components/workspace/file-refs";

/**
 * The file reference contract (src/components/workspace/file-refs.ts) as plain
 * functions, no browser needed. preview.spec.ts clicks references in the app.
 */

test("reads file references", () => {
  const lines = (start: number, end = start) => ({ start, end });
  expect(parseFileRef("notes/welcome.md")).toEqual({ path: "notes/welcome.md" });
  expect(parseFileRef("notes/welcome.md#L12")).toEqual({ path: "notes/welcome.md", lines: lines(12) });
  expect(parseFileRef("notes/welcome.md#L12-L18")).toEqual({ path: "notes/welcome.md", lines: lines(12, 18) });
  // Root-relative targets (what the chat passes on), dot paths and other line forms.
  expect(parseFileRef("/notes/welcome.md#L12-18")).toEqual({ path: "notes/welcome.md", lines: lines(12, 18) });
  expect(parseFileRef("./uploads/sales.csv#L3C2-L4C1")).toEqual({ path: "uploads/sales.csv", lines: lines(3, 4) });
  expect(parseFileRef("notes/welcome.md:7")).toEqual({ path: "notes/welcome.md", lines: lines(7) });
  expect(parseFileRef("notes/welcome.md:7-9")).toEqual({ path: "notes/welcome.md", lines: lines(7, 9) });
  expect(parseFileRef("/notes/my%20note.md#L18-L12")).toEqual({ path: "notes/my note.md", lines: lines(12, 18) });
  // Fragments that name no lines just open the file.
  expect(parseFileRef("notes/welcome.md#try-it")).toEqual({ path: "notes/welcome.md" });
  expect(parseFileRef("notes/welcome.md#L0")).toEqual({ path: "notes/welcome.md" });
  // A folder is still a workspace path; the chat shows it as text, as no file is there.
  expect(parseFileRef("notes/")).toEqual({ path: "notes/" });
});

test("leaves other links alone", () => {
  for (const href of [
    undefined,
    "",
    "/",
    "#L3",
    "https://example.com/notes/a.md",
    "mailto:me@example.com",
    "//example.com/a.md",
    "streamdown:incomplete-link",
  ]) {
    expect(parseFileRef(href), String(href)).toBeNull();
  }
});

test("numbers lines and finds them again", () => {
  expect(numberLines("# Title\r\n\nText")).toBe("1\t# Title\n2\t\n3\tText");
  expect(numberLines(Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n"))).toMatch(/^ 1\tline 1\n/);

  const text = "one\ntwo\nthree";
  const select = (start: number, end: number) => {
    const range = lineOffsets(text, { start, end });
    return range && text.slice(...range);
  };
  expect(select(2, 2)).toBe("two");
  expect(select(2, 9)).toBe("two\nthree");
  expect(select(4, 4)).toBeNull();
});

test("lands on the outermost blocks a range touches", () => {
  // A heading (1), a paragraph (3-4), and list items (6; 7-8 holding a nested 8).
  const blocks = [
    { start: 1, end: 1 },
    { start: 3, end: 4 },
    { start: 6, end: 6 },
    { start: 7, end: 8 },
    { start: 8, end: 8 },
  ];
  expect(blocksForLines(blocks, { start: 4, end: 4 })).toEqual([1]);
  expect(blocksForLines(blocks, { start: 6, end: 8 })).toEqual([2, 3]);
  expect(blocksForLines(blocks, { start: 8, end: 8 })).toEqual([3]);
  // A blank line lands on the block after it; past the last block, on nothing.
  expect(blocksForLines(blocks, { start: 2, end: 2 })).toEqual([1]);
  expect(blocksForLines(blocks, { start: 9, end: 12 })).toEqual([]);
});

test("CSV rows keep their source lines", () => {
  const rows = parseCsv('name,note\n\nada,"two\nlines"\r\nbob,x\n');
  expect(rows.map((row) => row.lines)).toEqual([
    { start: 1, end: 1 },
    { start: 3, end: 4 },
    { start: 5, end: 5 },
  ]);
  expect(rows[1].cells).toEqual(["ada", "two\nlines"]);
});

type Node = {
  type: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: Node[];
  position?: { start: { line: number }; end: { line: number } };
};

const element = (tagName: string, start: number, end = start, children: Node[] = [], href?: string): Node => ({
  type: "element",
  tagName,
  properties: href ? { href } : {},
  children,
  position: { start: { line: start }, end: { line: end } },
});

test("chat links become root-relative, so Streamdown keeps them", () => {
  const targets = ["notes/a.md#L2", ".github/ci.yml", "./b.md", "/c.md", "#top", "https://example.com"];
  const tree: Node = { type: "root", children: targets.map((href) => element("a", 1, 1, [], href)) };
  rootRelativeLinks()(tree);
  expect(tree.children!.map((a) => a.properties!.href)).toEqual([
    "/notes/a.md#L2",
    "/.github/ci.yml",
    "./b.md",
    "/c.md",
    "#top",
    "https://example.com",
  ]);
});

test("preview blocks carry their source lines", () => {
  const code = element("pre", 5, 7);
  const tree: Node = { type: "root", children: [element("h1", 1), element("ul", 3, 3, [element("li", 3)]), code] };
  sourceLines()(tree);
  const [heading, list, wrapper] = tree.children!;
  expect(heading.properties).toEqual({ dataLine: 1, dataLineEnd: 1 });
  expect(list.properties).toEqual({});
  expect(list.children![0].properties).toEqual({ dataLine: 3, dataLineEnd: 3 });
  // Code blocks get a wrapper, as Streamdown drops their attributes.
  expect(wrapper).toEqual({ type: "element", tagName: "div", properties: { dataLine: 5, dataLineEnd: 7 }, children: [code] });
});
