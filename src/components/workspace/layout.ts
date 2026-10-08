/**
 * Pane layout as plain data, plus the commands that change it. Only the
 * workbench (workbench.tsx) applies them, so every pane change, whether from a
 * button, an action or Claude, goes through this one reducer.
 */

export type PaneId = "explorer" | "editor" | "chat";

export type SidebarView = "files" | "knowledge" | "skills" | "uploads" | "artifacts" | "chats";

export interface Layout {
  sideOpen: boolean;
  chatOpen: boolean;
  sideWidth: number;
  chatWidth: number;
  /** Which view the explorer pane shows (picked on the icon rail). */
  view: SidebarView;
  /** Below 1024px one pane shows at a time; this is the one. */
  mobilePane: PaneId;
}

export const DEFAULT_LAYOUT: Layout = {
  sideOpen: true,
  chatOpen: true,
  sideWidth: 260,
  chatWidth: 420,
  view: "files",
  mobilePane: "editor",
};

export type ResizablePane = Exclude<PaneId, "editor">;

export const PANE_WIDTHS: Record<ResizablePane, { min: number; max: number }> = {
  explorer: { min: 180, max: 480 },
  chat: { min: 320, max: 760 },
};

/** What survives a reload; the view and the phone pane start fresh. */
export const PERSISTED_KEYS = ["sideOpen", "chatOpen", "sideWidth", "chatWidth"] as const;

export type LayoutCommand =
  | { type: "show"; pane: PaneId }
  | { type: "hide"; pane: PaneId }
  | { type: "toggle"; pane: PaneId }
  | { type: "resize"; pane: ResizablePane; width: number }
  | { type: "resetSize"; pane: ResizablePane }
  /** An icon rail click: picking the view already shown collapses the pane. */
  | { type: "selectView"; view: SidebarView }
  | { type: "showView"; view: SidebarView }
  /** Saved layout from an earlier visit; unknown or malformed values are ignored. */
  | { type: "restore"; saved: unknown };

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

/** The editor is the main pane and is always open. */
export function isPaneOpen(layout: Layout, pane: PaneId): boolean {
  if (pane === "explorer") return layout.sideOpen;
  if (pane === "chat") return layout.chatOpen;
  return true;
}

function setOpen(layout: Layout, pane: PaneId, open: boolean): Layout {
  if (pane === "explorer") return { ...layout, sideOpen: open };
  if (pane === "chat") return { ...layout, chatOpen: open };
  return layout;
}

export function reduceLayout(layout: Layout, command: LayoutCommand): Layout {
  switch (command.type) {
    case "show":
      return setOpen({ ...layout, mobilePane: command.pane }, command.pane, true);
    case "hide": {
      if (command.pane === "editor") return layout;
      const next = setOpen(layout, command.pane, false);
      return next.mobilePane === command.pane ? { ...next, mobilePane: "editor" } : next;
    }
    case "toggle":
      return reduceLayout(layout, {
        type: isPaneOpen(layout, command.pane) ? "hide" : "show",
        pane: command.pane,
      });
    case "resize": {
      const { min, max } = PANE_WIDTHS[command.pane];
      const width = clamp(Math.round(command.width), min, max);
      return command.pane === "explorer" ? { ...layout, sideWidth: width } : { ...layout, chatWidth: width };
    }
    case "resetSize":
      return command.pane === "explorer"
        ? { ...layout, sideWidth: DEFAULT_LAYOUT.sideWidth }
        : { ...layout, chatWidth: DEFAULT_LAYOUT.chatWidth };
    case "selectView":
      return { ...layout, view: command.view, sideOpen: !(layout.sideOpen && layout.view === command.view) };
    case "showView":
      return { ...layout, view: command.view, sideOpen: true, mobilePane: "explorer" };
    case "restore": {
      const saved = (command.saved ?? {}) as Partial<Record<string, unknown>>;
      let next = layout;
      if (typeof saved.sideOpen === "boolean") next = { ...next, sideOpen: saved.sideOpen };
      if (typeof saved.chatOpen === "boolean") next = { ...next, chatOpen: saved.chatOpen };
      if (typeof saved.sideWidth === "number" && Number.isFinite(saved.sideWidth)) {
        next = reduceLayout(next, { type: "resize", pane: "explorer", width: saved.sideWidth });
      }
      if (typeof saved.chatWidth === "number" && Number.isFinite(saved.chatWidth)) {
        next = reduceLayout(next, { type: "resize", pane: "chat", width: saved.chatWidth });
      }
      return next;
    }
  }
}

export function persistedLayout(layout: Layout) {
  return Object.fromEntries(PERSISTED_KEYS.map((key) => [key, layout[key]]));
}
