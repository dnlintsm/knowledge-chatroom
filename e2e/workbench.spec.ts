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
} from "../src/components/workspace/layout";

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
});

test("on phones, showing a pane switches to it and hiding it goes back to the editor", () => {
  expect(run({ type: "show", pane: "chat" }).mobilePane).toBe("chat");
  expect(run({ type: "show", pane: "explorer" }).mobilePane).toBe("explorer");
  expect(run({ type: "show", pane: "chat" }, { type: "hide", pane: "chat" }).mobilePane).toBe("editor");
  // Hiding another pane leaves the one on screen alone.
  expect(run({ type: "show", pane: "chat" }, { type: "hide", pane: "explorer" }).mobilePane).toBe("chat");
});

test("keeps pane widths in range", () => {
  expect(run({ type: "resize", pane: "explorer", width: 50 }).sideWidth).toBe(180);
  expect(run({ type: "resize", pane: "explorer", width: 9000 }).sideWidth).toBe(480);
  expect(run({ type: "resize", pane: "chat", width: 500.4 }).chatWidth).toBe(500);
  expect(run({ type: "resize", pane: "chat", width: 500 }, { type: "resetSize", pane: "chat" }).chatWidth).toBe(
    DEFAULT_LAYOUT.chatWidth,
  );
});

test("the icon rail collapses the pane when its view is picked again", () => {
  const skills = run({ type: "selectView", view: "skills" });
  expect(skills).toMatchObject({ view: "skills", sideOpen: true });
  expect(reduceLayout(skills, { type: "selectView", view: "skills" }).sideOpen).toBe(false);
  // showView always opens, also on phones.
  const collapsed = reduceLayout(skills, { type: "selectView", view: "skills" });
  expect(reduceLayout(collapsed, { type: "showView", view: "skills" })).toMatchObject({
    view: "skills",
    sideOpen: true,
    mobilePane: "explorer",
  });
});

test("restores only well-formed saved values", () => {
  const saved = persistedLayout({ ...DEFAULT_LAYOUT, chatOpen: false, sideWidth: 300 });
  expect(saved).toEqual({ sideOpen: true, chatOpen: false, sideWidth: 300, chatWidth: 420 });
  expect(run({ type: "restore", saved })).toMatchObject({ chatOpen: false, sideWidth: 300 });
  const junk: Layout = run({
    type: "restore",
    saved: { sideOpen: "yes", chatWidth: 99999, sideWidth: null, view: "nope", mobilePane: "chat" },
  });
  expect(junk).toEqual({ ...DEFAULT_LAYOUT, chatWidth: 760 });
  expect(run({ type: "restore", saved: null })).toEqual(DEFAULT_LAYOUT);
});

test("only the workbench changes pane layout", () => {
  const dir = path.join(__dirname, "../src");
  const sources = readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((f) => /\.tsx?$/.test(f))
    .map((f) => path.join("src", f));
  const owners = sources.filter((f) =>
    /\breduceLayout\(|knowledge-chatroom\.layout\./.test(readFileSync(path.join(__dirname, "..", f), "utf8")),
  );
  expect(owners.sort()).toEqual([
    "src/components/workspace/layout.ts",
    "src/components/workspace/workbench.tsx",
  ]);
});
