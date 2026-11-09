/**
 * The chat's tool chips, per chat, kept in the browser (issue #151): which
 * "+" menu tools the user turned on in each conversation. Pure functions so
 * they are unit-tested; the React side is tool-menu.tsx.
 */

export const TOOL_CHIPS_KEY = "knowledge-chatroom.chat.tool-chips.v1";
/** Chats remembered; the oldest are forgotten first. */
const MAX_CHATS = 100;

/** One server in the "+" menu, as the agent's GET /tools lists it (apps/agent/src/tools-api.ts). */
export interface ToolMenuItem {
  server: string;
  label: string;
  chip: string;
  description: string | null;
  icon: string | null;
  mode: "auto" | "manual";
  callable: string[];
}

/** { [threadId]: servers whose chip is on }, oldest chat first. */
export type ChipsByChat = Record<string, string[]>;

type BrowserStorage = Pick<Storage, "getItem" | "setItem">;

export function readChips(storage: BrowserStorage | null): ChipsByChat {
  try {
    const all = JSON.parse(storage?.getItem(TOOL_CHIPS_KEY) ?? "null") as unknown;
    if (!all || typeof all !== "object" || Array.isArray(all)) return {};
    return Object.fromEntries(
      Object.entries(all as Record<string, unknown>).flatMap(([thread, chips]) =>
        Array.isArray(chips) && chips.every((c) => typeof c === "string") && chips.length ? [[thread, chips as string[]]] : [],
      ),
    );
  } catch {
    return {};
  }
}

export function writeChips(storage: BrowserStorage | null, all: ChipsByChat) {
  try {
    storage?.setItem(TOOL_CHIPS_KEY, JSON.stringify(all));
  } catch {
    // Private mode or a full store: chips just aren't remembered.
  }
}

/** The chats' chips with `server` turned on or off in `thread`; that chat moves to the newest. */
export function setChip(all: ChipsByChat, thread: string, server: string, on: boolean): ChipsByChat {
  const current = all[thread] ?? [];
  const next = on ? [...new Set([...current, server])] : current.filter((s) => s !== server);
  const rest = Object.entries(all).filter(([t]) => t !== thread);
  const kept = next.length ? [...rest, [thread, next] as [string, string[]]] : rest;
  return Object.fromEntries(kept.slice(-MAX_CHATS));
}

/** The chips on in a chat, in menu order, for servers still in the menu. */
export function chipsOn(all: ChipsByChat, thread: string | undefined, menu: ToolMenuItem[]): string[] {
  const on = new Set(thread ? (all[thread] ?? []) : []);
  return menu.filter((item) => on.has(item.server)).map((item) => item.server);
}

/**
 * The server and tool of an outside tool call as Claude names it,
 * mcp__<server>__<tool>; null for other names.
 */
export function splitToolName(name: string): { server: string; tool: string } | null {
  const match = /^mcp__([A-Za-z0-9_-]+?)__([A-Za-z0-9_-]+)$/.exec(name);
  return match ? { server: match[1], tool: match[2] } : null;
}

/** A paper as the paper tools return it (services/papers-mcp/papers_mcp/models.py). */
export interface PaperInfo {
  id: string;
  title: string;
  authors: { name: string; id?: string | null }[];
  author_count: number;
  year: number | null;
  venue: string | null;
  abstract: string | null;
  url: string;
  pdf_url: string | null;
  citation_count: number | null;
  open_access: boolean;
}

export type PaperToolResult =
  | { kind: "papers"; query: string; papers: PaperInfo[]; total: number | null }
  | { kind: "error"; message: string };

const isPaper = (value: unknown): value is PaperInfo =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as PaperInfo).id === "string" &&
  typeof (value as PaperInfo).title === "string" &&
  typeof (value as PaperInfo).url === "string" &&
  Array.isArray((value as PaperInfo).authors);

/**
 * A paper tool's result as the chat receives it: the JSON the tool returned
 * (or a list of MCP text blocks holding it), or an error. null when it isn't
 * a paper result, so the plain tool line shows instead.
 */
export function parsePaperResult(result: string | undefined): PaperToolResult | null {
  if (!result) return null;
  let value: unknown;
  try {
    value = JSON.parse(result);
  } catch {
    return null;
  }
  if (Array.isArray(value)) {
    const text = value.find((b) => b && typeof b === "object" && b.type === "text" && typeof b.text === "string")?.text;
    return text === undefined ? null : parsePaperResult(text);
  }
  if (!value || typeof value !== "object") return null;
  const body = value as Record<string, unknown>;
  if (body.error === true) {
    const message = typeof body.content === "string" ? body.content : "The paper search failed.";
    return { kind: "error", message: message.replace(/^Error executing tool [\w-]+: /, "") };
  }
  if (Array.isArray(body.results)) {
    return {
      kind: "papers",
      query: typeof body.query === "string" ? body.query : "",
      papers: body.results.filter(isPaper),
      total: typeof body.total === "number" ? body.total : null,
    };
  }
  if (isPaper(body)) return { kind: "papers", query: "", papers: [body], total: 1 };
  return null;
}

/** The paper tools whose results show as cards; their server can be named anything. */
export const PAPER_CARD_TOOLS = new Set(["search_papers", "related_papers", "get_paper"]);
