import { test, expect, type Page } from "@playwright/test";

/** Shows the Files view; clicking it while it is already shown would fold the sidebar away. */
async function showFiles(page: Page) {
  const files = page.getByRole("button", { name: "Files", exact: true });
  if ((await files.getAttribute("aria-pressed")) !== "true") await files.click();
}

const path = "notes/multi-tab.md";
const url = `/api/files/${path}`;
const headers = { "Content-Type": "text/markdown" };

async function openEditor(page: Page) {
  await page.goto("/");
  await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible();
  await showFiles(page);
  await page.getByRole("treeitem", { name: /multi-tab\.md/ }).click();
  await page.getByRole("button", { name: "edit", exact: true }).dispatchEvent("click");
  await expect(page.getByTestId("file-editor")).toHaveValue("# Initial shared note");
}

test("two tabs synchronize saved edits and deletion through the real storage stream", async ({ page, context, request }) => {
  await expect.poll(async () => (await request.get("/api/nodes")).status(), { timeout: 60_000 }).toBe(200);
  expect((await request.put(url, { data: "# Initial shared note", headers })).ok()).toBe(true);
  const second = await context.newPage();
  try {
    await openEditor(page);
    await openEditor(second);
    await page.getByTestId("file-editor").fill("# Written in the first tab");
    await expect.poll(async () => (await request.get(url)).text()).toBe("# Written in the first tab");
    await expect(second.getByTestId("file-editor")).toHaveValue("# Written in the first tab");
    await second.getByTestId("file-editor").fill("# Written in the second tab");
    await expect.poll(async () => (await request.get(url)).text()).toBe("# Written in the second tab");
    await expect(page.getByTestId("file-editor")).toHaveValue("# Written in the second tab");
    expect((await request.delete(url)).ok()).toBe(true);
    await expect.poll(async () => (await request.get(url)).status()).toBe(404);
    for (const tab of [page, second]) {
      await expect(tab.getByRole("treeitem", { name: /multi-tab\.md/ })).toHaveCount(0);
      await expect(tab.getByRole("tab", { name: /multi-tab\.md/ })).toHaveCount(0);
    }
  } finally {
    await second.close();
    await request.delete(url);
  }
});

test("a page load lists the files and fetches a text file only when it is opened", async ({ page, request }) => {
  await expect.poll(async () => (await request.get("/api/nodes")).status(), { timeout: 60_000 }).toBe(200);
  const lazy = ["notes/lazy-a.md", "notes/lazy-b.md"];
  for (const p of lazy) {
    expect((await request.put(`/api/files/${p}`, { data: `# ${p}`, headers })).ok()).toBe(true);
  }
  const fetched: string[] = [];
  page.on("request", (req) => {
    const { pathname } = new URL(req.url());
    if (req.method() === "GET" && pathname.startsWith("/api/files/")) fetched.push(pathname.slice("/api/files/".length));
  });
  try {
    await page.goto("/");
    await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible();
    await showFiles(page);
    await expect(page.getByRole("treeitem", { name: /lazy-b\.md/ })).toBeVisible();
    expect(fetched.filter((p) => lazy.includes(p))).toEqual([]);

    await page.getByRole("treeitem", { name: /lazy-a\.md/ }).click();
    await expect(page.getByTestId("file-preview")).toContainText("notes/lazy-a.md");
    expect(fetched.filter((p) => lazy.includes(p))).toEqual(["notes/lazy-a.md"]);
  } finally {
    for (const p of lazy) await request.delete(`/api/files/${p}`);
  }
});

test("refresh lists files the live updates missed", async ({ page, request }) => {
  await expect.poll(async () => (await request.get("/api/nodes")).status(), { timeout: 60_000 }).toBe(200);
  const missed = "notes/missed-update.md";
  // No live updates: the file below only shows after a refresh.
  await page.route(
    (u) => u.pathname === "/api/files" && u.searchParams.has("watch"),
    (route) => route.abort(),
  );
  try {
    await page.goto("/");
    await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible();
    await showFiles(page);
    await expect(page.getByRole("treeitem").first()).toBeVisible();
    expect((await request.put(`/api/files/${missed}`, { data: "# Missed", headers })).ok()).toBe(true);
    await expect(page.getByRole("treeitem", { name: /missed-update\.md/ })).toHaveCount(0);
    await page.getByRole("button", { name: "Refresh files" }).click();
    await expect(page.getByRole("treeitem", { name: /missed-update\.md/ })).toBeVisible();
  } finally {
    await request.delete(`/api/files/${missed}`);
  }
});

test("a save over someone else's newer version asks which one to keep", async ({ page, request }) => {
  await expect.poll(async () => (await request.get("/api/nodes")).status(), { timeout: 60_000 }).toBe(200);
  const shared = "/api/files/notes/conflict.md";
  expect((await request.put(shared, { data: "# Shared\n\noriginal line", headers })).ok()).toBe(true);
  // This page's saves wait until the other person's save has landed, as when both typed at once.
  let theirsSaved = Promise.resolve();
  await page.route(
    (u) => u.pathname === shared,
    async (route) => {
      if (route.request().method() === "PUT") await theirsSaved;
      await route.continue();
    },
  );
  const editor = page.getByTestId("file-editor");
  const conflict = page.getByTestId("save-conflict");
  const someoneElseSaves = async (mine: string, theirs: string) => {
    let landed!: () => void;
    theirsSaved = new Promise<void>((resolve) => { landed = resolve; });
    await editor.fill(mine);
    expect((await request.put(shared, { data: theirs, headers })).ok()).toBe(true);
    landed();
  };
  try {
    await page.goto("/");
    await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible();
    await showFiles(page);
    await page.getByRole("treeitem", { name: /conflict\.md/ }).click();
    await page.getByRole("button", { name: "edit", exact: true }).dispatchEvent("click");
    await expect(editor).toHaveValue("# Shared\n\noriginal line");

    // Their save is not overwritten, and mine is not lost: the editor asks.
    await someoneElseSaves("# Shared\n\nmy line", "# Shared\n\ntheir line");
    await expect(conflict).toContainText("Someone else changed this file while you were editing it");
    await expect(page.getByRole("status").filter({ hasText: "Not saved" })).toBeVisible();
    expect(await (await request.get(shared)).text()).toBe("# Shared\n\ntheir line");
    await expect(editor).toHaveValue("# Shared\n\nmy line");
    await conflict.getByRole("button", { name: "Compare" }).click();
    const diff = page.getByTestId("save-conflict-diff");
    await expect(diff.locator('[data-change="removed"]')).toContainText("their line");
    await expect(diff.locator('[data-change="added"]')).toContainText("my line");

    // Keep mine: saved over theirs, which stays in the history.
    await conflict.getByRole("button", { name: "Keep mine" }).click();
    await expect(conflict).toHaveCount(0);
    await expect.poll(async () => (await request.get(shared)).text()).toBe("# Shared\n\nmy line");
    await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible();
    const versions = (await (await request.get(`${shared}?versions`)).json()).versions as unknown[];
    expect(versions).toHaveLength(3);

    // Use theirs: my edit is dropped, and the next one saves as usual.
    await someoneElseSaves("# Shared\n\nmy second line", "# Shared\n\ntheir second line");
    await expect(conflict).toBeVisible();
    await conflict.getByRole("button", { name: "Use theirs" }).click();
    await expect(conflict).toHaveCount(0);
    await expect(editor).toHaveValue("# Shared\n\ntheir second line");
    expect(await (await request.get(shared)).text()).toBe("# Shared\n\ntheir second line");
    await editor.fill("# Shared\n\nafter the conflict");
    await expect.poll(async () => (await request.get(shared)).text()).toBe("# Shared\n\nafter the conflict");
    await expect(conflict).toHaveCount(0);
  } finally {
    await request.delete(shared);
  }
});

test("accepting a proposal that was revised after its diff loaded is refused until it is looked at again", async ({ page, request }) => {
  await expect.poll(async () => (await request.get("/api/nodes")).status(), { timeout: 60_000 }).toBe(200);
  const file = "/api/files/notes/reviewed.md";
  expect((await request.put(file, { data: "# Recipe\n\npower: 300 W", headers })).ok()).toBe(true);
  const proposed = await request.put(`${file}?propose`, { data: "# Recipe\n\npower: 350 W", headers });
  expect(proposed.status()).toBe(201);
  const { id } = (await proposed.json()) as { id: string };
  // No live updates, so this page keeps showing the first version of the proposal.
  await page.route(
    (u) => u.pathname === "/api/files" && u.searchParams.has("watch"),
    (route) => route.abort(),
  );
  try {
    await page.goto("/");
    await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible();
    await page.getByRole("navigation", { name: "Location" }).getByRole("button", { name: /to review/ }).click();
    const card = page.getByTestId("review-panel").getByRole("article", { name: "Proposed change to notes/reviewed.md" });
    await expect(card.locator('[data-change="added"]')).toContainText("power: 350 W");

    // Its proposer revises it; the reviewer accepts what is still on screen.
    expect((await request.put(`${file}?propose`, { data: "# Recipe\n\npower: 900 W", headers })).status()).toBe(201);
    await card.getByRole("button", { name: "Accept" }).click();
    await expect(card.getByRole("alert")).toContainText("revised after you opened it");
    expect(await (await request.get(file)).text()).toBe("# Recipe\n\npower: 300 W");
    // The card now shows the revision, and accepting that goes through.
    await expect(card.locator('[data-change="added"]')).toContainText("power: 900 W");
    await card.getByRole("button", { name: "Accept" }).click();
    await expect(card).toHaveCount(0);
    expect(await (await request.get(file)).text()).toBe("# Recipe\n\npower: 900 W");
  } finally {
    await request.post(`/api/proposals/${id}/withdraw`);
    await request.delete(file);
  }
});
