import { test, expect } from "@playwright/test";
import {
  TOOL_CHIPS_KEY,
  chipsOn,
  parsePaperResult,
  readChips,
  setChip,
  splitToolName,
  writeChips,
  type ToolMenuItem,
} from "../../apps/web/src/components/workspace/tool-chips";

const item = (server: string): ToolMenuItem => ({
  server, label: server, chip: server, description: null, icon: null, mode: "auto", callable: [],
});
const MENU = [item("papers"), item("patents")];

function memoryStorage(initial: Record<string, string> = {}) {
  const data = { ...initial };
  return {
    data,
    getItem: (key: string) => data[key] ?? null,
    setItem: (key: string, value: string) => void (data[key] = value),
  };
}

test("chips are per chat, in menu order, only for servers still in the menu", () => {
  let all = setChip({}, "t1", "patents", true);
  all = setChip(all, "t1", "papers", true);
  all = setChip(all, "t1", "gone", true);
  all = setChip(all, "t2", "papers", true);
  expect(chipsOn(all, "t1", MENU)).toEqual(["papers", "patents"]);
  expect(chipsOn(all, "t2", MENU)).toEqual(["papers"]);
  expect(chipsOn(all, "t3", MENU)).toEqual([]);
  expect(chipsOn(all, undefined, MENU)).toEqual([]);
  // Turning the last chip off forgets the chat.
  expect(setChip(all, "t2", "papers", false)).not.toHaveProperty("t2");
});

test("only the newest 100 chats keep their chips", () => {
  let all = {};
  for (let i = 0; i < 105; i++) all = setChip(all, `t${i}`, "papers", true);
  expect(Object.keys(all)).toHaveLength(100);
  expect(all).not.toHaveProperty("t0");
  // Touching an old chat makes it the newest.
  all = setChip(all, "t5", "patents", true);
  all = setChip(all, "new", "papers", true);
  expect(all).toHaveProperty("t5");
  expect(all).not.toHaveProperty("t6");
});

test("chips survive a reload, and bad saved data is ignored", () => {
  const storage = memoryStorage();
  writeChips(storage, { t1: ["papers"] });
  expect(readChips(storage)).toEqual({ t1: ["papers"] });
  expect(readChips(memoryStorage({ [TOOL_CHIPS_KEY]: "{not json" }))).toEqual({});
  expect(readChips(memoryStorage({ [TOOL_CHIPS_KEY]: JSON.stringify({ a: "papers", b: [1], c: [], d: ["ok"] }) }))).toEqual({ d: ["ok"] });
  expect(readChips(null)).toEqual({});
  const full = { getItem: () => null, setItem: () => { throw new Error("quota"); } };
  expect(() => writeChips(full, { t1: ["papers"] })).not.toThrow();
});

test("tool names split into server and tool", () => {
  expect(splitToolName("mcp__papers__search_papers")).toEqual({ server: "papers", tool: "search_papers" });
  expect(splitToolName("mcp__my_papers__get_paper")).toEqual({ server: "my_papers", tool: "get_paper" });
  expect(splitToolName("search_papers")).toBeNull();
  expect(splitToolName("mcp__copilotkit__")).toBeNull();
});

const paper = {
  id: "openalex:W1", title: "RAG", authors: [{ name: "Patrick Lewis" }], author_count: 12, year: 2020,
  venue: "arXiv", abstract: "We combine.", url: "https://arxiv.org/abs/2005.11401", pdf_url: null,
  citation_count: 4473, open_access: true,
};

test("paper results parse from the tool's JSON, MCP text blocks, or an error", () => {
  const search = JSON.stringify({ query: "rag", results: [paper, { id: "broken" }], total: 1200, next_cursor: "x" });
  expect(parsePaperResult(search)).toEqual({ kind: "papers", query: "rag", papers: [paper], total: 1200 });
  expect(parsePaperResult(JSON.stringify([{ type: "text", text: search }]))).toMatchObject({ kind: "papers", query: "rag" });
  // get_paper returns one paper.
  expect(parsePaperResult(JSON.stringify({ ...paper, bibtex: "@misc{}" }))).toMatchObject({ kind: "papers", papers: [{ id: "openalex:W1" }] });
  expect(parsePaperResult(JSON.stringify({ error: true, content: "Error executing tool search_papers: Couldn't reach OpenAlex" }))).toEqual({
    kind: "error",
    message: "Couldn't reach OpenAlex",
  });
  // Anything else falls back to the plain tool line.
  for (const other of [undefined, "", "plain text", "42", JSON.stringify({ ok: true }), JSON.stringify([{ type: "image" }])]) {
    expect(parsePaperResult(other)).toBeNull();
  }
});
