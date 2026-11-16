import { test, expect, type Page } from "@playwright/test";

/**
 * The app in a chosen workspace (issue #226, docs/workspaces.md, rollout step
 * 5): pages at /w/<slug>, every request naming the page's workspace, and
 * saved state kept per workspace. Storage mode, with the API server (api-py).
 */

const HEADER = "x-knowledge-workspace";
const markdown = { "Content-Type": "text/markdown" };

async function showFiles(page: Page) {
  const files = page.getByRole("button", { name: "Files", exact: true });
  if ((await files.getAttribute("aria-pressed")) !== "true") await files.click();
}

async function loaded(page: Page) {
  await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible();
  await showFiles(page);
}

test("each workspace has its own page, files and saved state", async ({ page, request }) => {
  await expect.poll(async () => (await request.get("/api/nodes")).status(), { timeout: 60_000 }).toBe(200);
  const listed = await (await request.get("/api/workspaces")).json();
  const home = listed.workspaces.find((w: { slug: string }) => w.slug === "default");
  expect(home).toBeTruthy();
  const created = await request.post("/api/workspaces", { data: { name: `Research ${Date.now()}` } });
  expect(created.status()).toBe(201);
  const other: { id: string; slug: string } = await created.json();

  const inDefault = "notes/only-in-default.md";
  const inOther = "notes/only-in-research.md";
  expect((await request.put(`/api/files/${inDefault}`, { data: "# Default", headers: markdown })).ok()).toBe(true);
  expect(
    (await request.put(`/api/files/${inOther}`, { data: "# Research", headers: { ...markdown, [HEADER]: other.id } })).ok(),
  ).toBe(true);

  // Every /api call from the page names its workspace: fetches by header,
  // the change stream and file links by ?workspace=. Each is checked against
  // the page that sent it (its Referer): one the page before a navigation
  // sends late is that page's own.
  const named: { path: string; page: string; ws: string | null }[] = [];
  page.on("request", (req) => {
    const url = new URL(req.url());
    if (!url.pathname.startsWith("/api/") || url.pathname.startsWith("/api/auth/")) return;
    const from = req.headers()["referer"];
    named.push({
      path: url.pathname,
      page: from ? new URL(from).pathname : "",
      ws: req.headers()[HEADER] ?? url.searchParams.get("workspace"),
    });
  });
  const from = (slug: string) => named.filter((r) => r.page === `/w/${slug}`);

  try {
    // A URL without a workspace goes to the default one, keeping its query.
    await page.goto("/?list=all");
    await expect(page).toHaveURL(/\/w\/default\?list=all$/);
    await loaded(page);
    await expect(page.getByRole("treeitem", { name: /only-in-default\.md/ })).toBeVisible();
    await expect(page.getByRole("treeitem", { name: /only-in-research\.md/ })).toHaveCount(0);
    expect(from("default").length).toBeGreaterThan(0);
    expect(from("default").filter((r) => r.ws !== home.id)).toEqual([]);

    await page.goto(`/w/${other.slug}`);
    await loaded(page);
    await expect(page.getByRole("treeitem", { name: /only-in-research\.md/ })).toBeVisible();
    await expect(page.getByRole("treeitem", { name: /only-in-default\.md/ })).toHaveCount(0);
    expect(from(other.slug).some((r) => r.path === "/api/files")).toBe(true);
    expect(from(other.slug).filter((r) => r.ws !== other.id)).toEqual([]);
    expect(named.filter((r) => r.page !== "/w/default" && r.page !== `/w/${other.slug}`)).toEqual([]);

    // The tabs it opened are kept for this user in this workspace.
    await page.getByRole("treeitem", { name: /only-in-research\.md/ }).click();
    await expect(page.getByTestId("file-preview")).toContainText("Research");
    const keys = await page.evaluate(() => Object.keys(window.localStorage));
    expect(keys).toContain(`knowledge-chatroom.workspace.place-ui.v1@local/${other.id}`);
    expect(keys).not.toContain("knowledge-chatroom.workspace.place-ui.v1");

    // Back in the default workspace, none of that shows.
    await page.goto("/w/default");
    await loaded(page);
    await expect(page.getByRole("treeitem", { name: /only-in-default\.md/ })).toBeVisible();
    await expect(page.getByRole("tab", { name: /only-in-research\.md/ })).toHaveCount(0);
  } finally {
    await request.delete(`/api/files/${inDefault}`);
    await request.delete(`/api/files/${inOther}`, { headers: { [HEADER]: other.id } });
  }
});

test("a workspace that isn't yours, or doesn't exist, doesn't open", async ({ page, request }) => {
  await expect.poll(async () => (await request.get("/api/nodes")).status(), { timeout: 60_000 }).toBe(200);
  await page.goto("/w/no-such-workspace");
  await expect(page.getByTestId("workspace-not-found")).toBeVisible();
  // A request naming a workspace that isn't one answers 404, never the default's.
  const res = await request.get("/api/files", { headers: { [HEADER]: "00000000-0000-4000-8000-000000000000" } });
  expect(res.status()).toBe(404);
});
