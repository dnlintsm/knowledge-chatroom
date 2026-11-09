"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { BookOpen, Database, Globe, Search, Wrench, X, type LucideIcon } from "lucide-react";
import { useCopilotChatConfiguration } from "@copilotkit/react-core/v2";
import { chipsOn, readChips, setChip, writeChips, type ChipsByChat, type ToolMenuItem } from "./tool-chips";

/**
 * The chat's "+" menu of outside tools (issue #151). The agent lists the MCP
 * servers that have a `ui` block (GET /api/tools); picking one turns its chip
 * on for this chat, and the chips go out with every run as
 * forwardedProps.knowledge_chatroom.tools (use-chatroom-props.ts), so Claude
 * answers with that server's tools. Buttons in the chat (paper cards) call a
 * server's tools directly through `callTool`.
 */

export interface ToolMenu {
  menu: ToolMenuItem[];
  /** Servers whose chip is on in this chat. */
  chips: string[];
  setChip: (server: string, on: boolean) => void;
  /** Calls one of a server's `callable` tools as the signed-in user; throws with the server's reason. */
  callTool: (server: string, tool: string, args: Record<string, unknown>) => Promise<unknown>;
  /** Puts text in the message box, for the user to edit and send. */
  fillComposer: (text: string) => void;
  /** The message box registers how to fill it. */
  registerComposer: (fill: ((text: string) => void) | null) => void;
}

const ToolMenuContext = createContext<ToolMenu | null>(null);

const NO_MENU: ToolMenu = {
  menu: [],
  chips: [],
  setChip: () => {},
  callTool: async () => {
    throw new Error("Tools aren't available here");
  },
  fillComposer: () => {},
  registerComposer: () => {},
};

/** Outside the provider (e.g. tests of single components) there is no menu. */
export function useToolMenu(): ToolMenu {
  return useContext(ToolMenuContext) ?? NO_MENU;
}

const browserStorage = () => {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
};

export function ToolMenuProvider({ children }: { children: ReactNode }) {
  const [menu, setMenu] = useState<ToolMenuItem[]>([]);
  const [all, setAll] = useState<ChipsByChat>({});
  const threadId = useCopilotChatConfiguration()?.threadId;
  const composer = useRef<((text: string) => void) | null>(null);

  useEffect(() => {
    setAll(readChips(browserStorage()));
    let live = true;
    fetch("/api/tools", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : { tools: [] }))
      .then((body: { tools?: ToolMenuItem[] }) => {
        if (live) setMenu(Array.isArray(body.tools) ? body.tools : []);
      })
      // No agent server, or an older one: no "+" menu tools.
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  const chips = useMemo(() => chipsOn(all, threadId, menu), [all, threadId, menu]);

  const toggle = useCallback(
    (server: string, on: boolean) => {
      if (!threadId) return;
      setAll((current) => {
        const next = setChip(current, threadId, server, on);
        writeChips(browserStorage(), next);
        return next;
      });
    },
    [threadId],
  );

  const callTool = useCallback(async (server: string, tool: string, args: Record<string, unknown>) => {
    const res = await fetch(`/api/tools/${encodeURIComponent(server)}/${encodeURIComponent(tool)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ arguments: args }),
    });
    const body = (await res.json().catch(() => ({}))) as { result?: unknown; error?: string };
    if (!res.ok) throw new Error(body.error || `${tool} failed (${res.status})`);
    return body.result;
  }, []);

  const value = useMemo<ToolMenu>(
    () => ({
      menu,
      chips,
      setChip: toggle,
      callTool,
      fillComposer: (text) => composer.current?.(text),
      registerComposer: (fill) => {
        composer.current = fill;
      },
    }),
    [menu, chips, toggle, callTool],
  );
  return <ToolMenuContext.Provider value={value}>{children}</ToolMenuContext.Provider>;
}

const ICONS: Record<string, LucideIcon> = {
  "book-open": BookOpen,
  book: BookOpen,
  papers: BookOpen,
  globe: Globe,
  web: Globe,
  search: Search,
  database: Database,
};

export const toolIcon = (name: string | null): LucideIcon => (name && ICONS[name]) || Wrench;

/** The "+" menu's entries: one per tool server, checked while its chip is on. */
export function toolsMenuItems({ menu, chips, setChip }: Pick<ToolMenu, "menu" | "chips" | "setChip">) {
  return menu.map((item) => {
    const on = chips.includes(item.server);
    return { label: `${on ? "✓ " : ""}${item.label}`, action: () => setChip(item.server, !on) };
  });
}

/** The chips that are on, above the message box; × turns one off. */
export function ToolChipRow() {
  const { menu, chips, setChip } = useToolMenu();
  if (!chips.length) return null;
  return (
    <div data-testid="tool-chips" className="pointer-events-none relative z-20 mx-auto flex max-w-3xl flex-wrap gap-1.5 px-4 pb-1.5 @3xl:px-0">
      {chips.map((server) => {
        const item = menu.find((m) => m.server === server)!;
        const Icon = toolIcon(item.icon);
        return (
          <span
            key={server}
            data-tool-chip={server}
            title={`${item.label} is on for this chat: Claude answers with it`}
            className="pointer-events-auto flex items-center gap-1 rounded-full border border-[var(--border)] bg-[var(--accent)] py-0.5 pl-2 pr-1 text-xs font-medium text-[var(--accent-foreground)] shadow-sm"
          >
            <Icon className="size-3.5 shrink-0" />
            {item.chip}
            <button
              type="button"
              aria-label={`Turn off ${item.label}`}
              onClick={() => setChip(server, false)}
              className="flex size-4 items-center justify-center rounded-full hover:bg-black/10 dark:hover:bg-white/15 cursor-pointer"
            >
              <X className="size-3" />
            </button>
          </span>
        );
      })}
    </div>
  );
}
