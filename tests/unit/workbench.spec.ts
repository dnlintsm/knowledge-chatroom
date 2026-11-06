import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test, expect } from "@playwright/test";
import {
  DEFAULT_LAYOUT,
  isPaneOpen,
  persistedLayout,
  reduceLayout,
  type Layout,
  type LayoutCommand,
} from "../../src/components/workspace/layout";

/**
 * The workbench contract's layout rules (src/components/workspace/layout.ts)
 * as plain functions, no browser needed. preview.spec.ts drives the real UI.
 */

const run = (...commands: LayoutCommand[]) => commands.reduce(reduceLayout, DEFAULT_LAYOUT);

test("shows, hides and toggles panes", () => {
  const hidden = run({ type: "hide", pane: "chat" });
  expect(isPaneOpen(hidden, "chat")).toBe(false);
  expect(isPaneOpen(run({ type: "toggle", pane: "chat" }), "chat")).toBe(false);
  expect(isPaneOpen(run({ type: "hide", pane: "chat" }, { type: "toggle", pane: "chat" }), "chat")).toBe(true);
  expect(isPaneOpen(run({ type: "toggle", pane: "explorer" }), "explorer")).toBe(false);
  // The editor is the main pane and can't be hidden.
  expect(run({ type: "hide", pane: "editor" })).toEqual(DEFAULT_LAYOUT);
  expect(isPaneOpen(run({ type: "toggle", pane: "editor" }), "editor")).toBe(true);
  // Toggling an already hidden pane opens it
  const hiddenExplorer = run({ type: "hide", pane: "explorer" });
  expect(isPaneOpen(hiddenExplorer, "explorer")).toBe(false);
  const toggledOpenExplorer = reduceLayout(hiddenExplorer, { type: "toggle", pane: "explorer" });
  expect(isPaneOpen(toggledOpenExplorer, "explorer")).toBe(true);
});

test("on phones, showing a pane switches to it and hiding it goes back to the editor", () => {
  expect(run({ type: "show", pane: "chat" }).mobilePane).toBe("chat");
  expect(run({ type: "show", pane: "explorer" }).mobilePane).toBe("explorer");
  expect(run({ type: "show", pane: "editor" }).mobilePane).toBe("editor");
  expect(run({ type: "show", pane: "chat" }, { type: "hide", pane: "chat" }).mobilePane).toBe("editor");
  // Hiding another pane leaves the one on screen alone.
  expect(run({ type: "show", pane: "chat" }, { type: "hide", pane: "explorer" }).mobilePane).toBe("chat");
  expect(run({ type: "show", pane: "explorer" }, { type: "hide", pane: "chat" }).mobilePane).toBe("explorer");
});

test("keeps pane widths in range and supports resetting size", () => {
  // Explorer boundaries
  expect(run({ type: "resize", pane: "explorer", width: 50 }).sideWidth).toBe(180);
  expect(run({ type: "resize", pane: "explorer", width: 180 }).sideWidth).toBe(180);
  expect(run({ type: "resize", pane: "explorer", width: 350.6 }).sideWidth).toBe(351);
  expect(run({ type: "resize", pane: "explorer", width: 480 }).sideWidth).toBe(480);
  expect(run({ type: "resize", pane: "explorer", width: 9000 }).sideWidth).toBe(480);
  expect(run({ type: "resize", pane: "explorer", width: 300 }, { type: "resetSize", pane: "explorer" }).sideWidth).toBe(
    DEFAULT_LAYOUT.sideWidth,
  );

  // Chat boundaries
  expect(run({ type: "resize", pane: "chat", width: 100 }).chatWidth).toBe(320);
  expect(run({ type: "resize", pane: "chat", width: 320 }).chatWidth).toBe(320);
  expect(run({ type: "resize", pane: "chat", width: 500.4 }).chatWidth).toBe(500);
  expect(run({ type: "resize", pane: "chat", width: 760 }).chatWidth).toBe(760);
  expect(run({ type: "resize", pane: "chat", width: 1500 }).chatWidth).toBe(760);
  expect(run({ type: "resize", pane: "chat", width: 500 }, { type: "resetSize", pane: "chat" }).chatWidth).toBe(
    DEFAULT_LAYOUT.chatWidth,
  );
});

test("the icon rail collapses the pane when its view is picked again", () => {
  const skills = run({ type: "selectView", view: "skills" });
  expect(skills).toMatchObject({ view: "skills", sideOpen: true });
  expect(reduceLayout(skills, { type: "selectView", view: "skills" }).sideOpen).toBe(false);
  // Selecting when closed opens it to that view
  const closed = reduceLayout(skills, { type: "selectView", view: "skills" });
  expect(reduceLayout(closed, { type: "selectView", view: "skills" }).sideOpen).toBe(true);
  expect(reduceLayout(closed, { type: "selectView", view: "search" })).toMatchObject({
    view: "search",
    sideOpen: true,
  });

  // showView always opens, also on phones.
  const collapsed = reduceLayout(skills, { type: "selectView", view: "skills" });
  expect(reduceLayout(collapsed, { type: "showView", view: "skills" })).toMatchObject({
    view: "skills",
    sideOpen: true,
    mobilePane: "explorer",
  });
});

test("setView switches the view without opening anything", () => {
  const collapsed = run({ type: "hide", pane: "explorer" });
  expect(reduceLayout(collapsed, { type: "setView", view: "runs" })).toEqual({ ...collapsed, view: "runs" });
  const open = run({ type: "show", pane: "explorer" });
  expect(reduceLayout(open, { type: "setView", view: "artifacts" })).toEqual({ ...open, view: "artifacts" });
});

test("restores only well-formed saved values", () => {
  const saved = persistedLayout({ ...DEFAULT_LAYOUT, chatOpen: false, sideWidth: 300 });
  expect(saved).toEqual({ sideOpen: true, chatOpen: false, sideWidth: 300, chatWidth: 420 });
  expect(run({ type: "restore", saved })).toMatchObject({ chatOpen: false, sideWidth: 300 });

  // Junk and edge cases in restore
  const junk: Layout = run({
    type: "restore",
    saved: {
      sideOpen: "yes",
      chatOpen: null,
      chatWidth: 99999,
      sideWidth: null,
      view: "nope",
      mobilePane: "chat",
    },
  });
  expect(junk).toEqual({ ...DEFAULT_LAYOUT, chatWidth: 760 });
  expect(run({ type: "restore", saved: null })).toEqual(DEFAULT_LAYOUT);
  expect(run({ type: "restore", saved: undefined })).toEqual(DEFAULT_LAYOUT);
  expect(run({ type: "restore", saved: { sideWidth: Number.NaN, chatWidth: Number.POSITIVE_INFINITY } })).toEqual(
    DEFAULT_LAYOUT,
  );

  // Restore clamps both sideWidth and chatWidth
  const clampedRestore = run({
    type: "restore",
    saved: { sideWidth: 50, chatWidth: 100 },
  });
  expect(clampedRestore.sideWidth).toBe(180);
  expect(clampedRestore.chatWidth).toBe(320);

  // Restore respects partial updates
  const partial = run({
    type: "restore",
    saved: { sideOpen: false },
  });
  expect(partial.sideOpen).toBe(false);
  expect(partial.chatOpen).toBe(DEFAULT_LAYOUT.chatOpen);
  expect(partial.sideWidth).toBe(DEFAULT_LAYOUT.sideWidth);
  expect(partial.chatWidth).toBe(DEFAULT_LAYOUT.chatWidth);
});

test("reduces complex sequences of layout commands deterministically", () => {
  const complexLayout = run(
    { type: "selectView", view: "search" },
    { type: "resize", pane: "explorer", width: 300 },
    { type: "resize", pane: "chat", width: 600 },
    { type: "hide", pane: "chat" },
    { type: "show", pane: "chat" },
    { type: "selectView", view: "search" }, // collapses search pane
    { type: "setView", view: "memory" }, // switches to memory without opening
    { type: "showView", view: "knowledge" }, // switches and opens on mobile & desktop
    { type: "resetSize", pane: "explorer" },
  );

  expect(complexLayout).toEqual({
    sideOpen: true,
    chatOpen: true,
    sideWidth: DEFAULT_LAYOUT.sideWidth,
    chatWidth: 600,
    view: "knowledge",
    mobilePane: "explorer",
  });
});

test("persistedLayout extracts only the persisted keys", () => {
  const customLayout: Layout = {
    sideOpen: false,
    chatOpen: true,
    sideWidth: 220,
    chatWidth: 500,
    view: "uploads",
    mobilePane: "chat",
  };
  const persisted = persistedLayout(customLayout);
  expect(persisted).toEqual({
    sideOpen: false,
    chatOpen: true,
    sideWidth: 220,
    chatWidth: 500,
  });
  expect(persisted).not.toHaveProperty("view");
  expect(persisted).not.toHaveProperty("mobilePane");
});

test("only the workbench changes pane layout", () => {
  const dir = path.join(__dirname, "../../src");
  const sources = readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((f) => /\.tsx?$/.test(f));
  const owners = sources
    .filter((f) => /\breduceLayout\(|knowledge-chatroom\.layout\./.test(readFileSync(path.join(dir, f), "utf8")))
    // Forward slashes on every platform (readdirSync gives backslashes on Windows).
    .map((f) => `src/${f.split(path.sep).join("/")}`);
  expect(owners.sort()).toEqual([
    "src/components/workspace/layout.ts",
    "src/components/workspace/workbench.tsx",
  ]);
});
