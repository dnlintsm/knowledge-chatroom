import { test, expect } from "@playwright/test";

import {
  RECENT_KEY,
  isSlug,
  readRecent,
  recordVisit,
  slugify,
  switcherSections,
  workspacePath,
} from "../../apps/web/src/lib/workspace-choice";
import type { WorkspaceInfo } from "../../apps/web/src/lib/workspace-request";

/** Choosing a workspace: the switcher's lists and a new workspace's address (docs/workspaces.md, "Screens"). */

class FakeStorage {
  readonly items = new Map<string, string>();
  getItem = (key: string) => this.items.get(key) ?? null;
  setItem = (key: string, value: string) => void this.items.set(key, value);
}

const ws = (n: number, role: WorkspaceInfo["role"] = "member"): WorkspaceInfo => ({
  id: `id-${n}`,
  slug: `w${n}`,
  name: `Workspace ${n}`,
  role,
});

test("a new workspace's address is made from its name as the API server makes it", () => {
  expect(slugify("Etch Research")).toBe("etch-research");
  expect(slugify("  Café — Ørsted 2026!  ")).toBe("cafe-rsted-2026");
  expect(slugify("naïve\tidea")).toBe("naive-idea");
  expect(slugify("研究")).toBe("");
  const long = slugify(`${"a".repeat(47)} b`);
  expect(long).toBe("a".repeat(47));
  expect(isSlug(long)).toBe(true);
  for (const good of ["lab", "lab-2", "the-lab-2026", "a".repeat(48)]) expect(isSlug(good), good).toBe(true);
  for (const bad of ["", "Lab", "lab_1", "-lab", "lab-", "a--b", "a b", "a".repeat(49)]) expect(isSlug(bad), bad).toBe(false);
  expect(workspacePath("the lab")).toBe("/w/the%20lab");
});

test("the workspaces opened last are kept per user, the last first, without repeats", () => {
  const storage = new FakeStorage();
  expect(readRecent(storage, "alice")).toEqual([]);
  recordVisit(storage, "alice", "a");
  recordVisit(storage, "alice", "b");
  recordVisit(storage, "alice", "a");
  recordVisit(storage, "bob", "c");
  expect(readRecent(storage, "alice")).toEqual(["a", "b"]);
  expect(readRecent(storage, "bob")).toEqual(["c"]);
  for (let i = 0; i < 20; i++) recordVisit(storage, "alice", `x${i}`);
  expect(readRecent(storage, "alice")).toHaveLength(8);
  storage.setItem(`${RECENT_KEY}@alice`, "not json");
  expect(readRecent(storage, "alice")).toEqual([]);
});

test("the switcher lists recent workspaces first, only when the list is long", () => {
  const few = [ws(1), ws(2), ws(3)];
  expect(switcherSections(few, ["id-2", "id-1"], "id-1")).toEqual({ recent: [], all: few });
  const many = [1, 2, 3, 4, 5, 6, 7].map((n) => ws(n));
  // Not the current one, not one they left, at most three.
  const { recent, all } = switcherSections(many, ["id-1", "id-9", "id-5", "id-3", "id-2", "id-4"], "id-1");
  expect(recent.map((w) => w.id)).toEqual(["id-5", "id-3", "id-2"]);
  expect(all).toEqual(many);
});
