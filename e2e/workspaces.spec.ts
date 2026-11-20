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
    await expect.poll(() => from("default").find((r) => r.path === "/api/chat/models")?.ws).toBe(home.id);
    expect(from("default").length).toBeGreaterThan(0);
    expect(from("default").filter((r) => r.ws !== home.id)).toEqual([]);

    await page.goto(`/w/${other.slug}`);
    await loaded(page);
    await expect(page.getByRole("treeitem", { name: /only-in-research\.md/ })).toBeVisible();
    await expect(page.getByRole("treeitem", { name: /only-in-default\.md/ })).toHaveCount(0);
    expect(from(other.slug).some((r) => r.path === "/api/files")).toBe(true);
    await expect.poll(() => from(other.slug).find((r) => r.path === "/api/chat/models")?.ws).toBe(other.id);
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
  // One page for both, which names nothing of what was asked for and lists the user's own.
  const refused = page.getByTestId("workspace-no-access");
  await expect(refused).toBeVisible();
  await expect(refused).not.toContainText("no-such-workspace");
  await expect(refused.getByRole("list", { name: "Your workspaces" })).toContainText("My workspace");
  // A request naming a workspace that isn't one answers 404, never the default's.
  const res = await request.get("/api/files", { headers: { [HEADER]: "00000000-0000-4000-8000-000000000000" } });
  expect(res.status()).toBe(404);
});

test("the switcher moves to another workspace, asking first about unsaved edits", async ({ page, request }) => {
  await expect.poll(async () => (await request.get("/api/nodes")).status(), { timeout: 60_000 }).toBe(200);
  const name = `Switch ${Date.now()}`;
  const other: { id: string; slug: string } = await (await request.post("/api/workspaces", { data: { name } })).json();
  const path = `notes/switch-${Date.now()}.md`;

  await page.goto("/w/default");
  await loaded(page);
  const location = page.getByRole("navigation", { name: "Location" });
  await expect(location.getByRole("button", { name: "My workspace", exact: true })).toBeVisible();
  const menu = page.getByRole("menu", { name: "Workspaces" });
  await page.getByRole("button", { name: "Switch workspace" }).click();
  await expect(menu.getByRole("menuitem", { name: /My workspace/ })).toHaveAttribute("aria-current", "page");
  await expect(menu.getByRole("menuitem", { name: new RegExp(name) })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Create workspace" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);

  // An edit that can't save: switching asks first.
  await page.getByRole("button", { name: "New file", exact: true }).click();
  await page.getByRole("textbox", { name: "New file path" }).fill(path);
  await page.getByRole("textbox", { name: "New file path" }).press("Enter");
  await expect.poll(async () => (await request.get(`/api/files/${path}`)).status()).toBe(200);
  await page.route("**/api/files/**", (route) => (route.request().method() === "PUT" ? route.abort() : route.continue()));
  await page.getByTestId("file-editor").fill("# Kept\n\nSaved before the switch.");
  await expect(page.getByRole("status").filter({ hasText: "Not saved" })).toBeVisible();

  const pick = async () => {
    await page.getByRole("button", { name: "Switch workspace" }).click();
    await menu.getByRole("menuitem", { name: new RegExp(name) }).click();
  };
  const prompt = page.getByRole("dialog", { name: "Unsaved edits" });
  await pick();
  await expect(prompt).toBeVisible();
  await prompt.getByRole("button", { name: "Stay" }).click();
  await expect(prompt).toHaveCount(0);
  await expect(page).toHaveURL(/\/w\/default$/);

  // Save tries again; while it still can't, it says so and stays.
  await pick();
  await prompt.getByRole("button", { name: "Save" }).click();
  await expect(prompt.getByRole("alert")).toContainText("haven't saved yet");
  await expect(page).toHaveURL(/\/w\/default$/);
  await page.unroute("**/api/files/**");
  await prompt.getByRole("button", { name: "Save" }).click();
  await expect(page).toHaveURL(new RegExp(`/w/${other.slug}$`));
  await loaded(page);
  await expect(location.getByRole("button", { name, exact: true })).toBeVisible();
  try {
    expect(await (await request.get(`/api/files/${path}`)).text()).toBe("# Kept\n\nSaved before the switch.");
  } finally {
    await request.delete(`/api/files/${path}`);
  }
});

test("an Owner renames, archives and restores a workspace from the switcher", async ({ page, request }) => {
  await expect.poll(async () => (await request.get("/api/nodes")).status(), { timeout: 60_000 }).toBe(200);
  const name = `Settings ${Date.now()}`;
  const renamed = `${name} renamed`;
  const other: { id: string; slug: string } = await (await request.post("/api/workspaces", { data: { name } })).json();
  const location = page.getByRole("navigation", { name: "Location" });
  const menu = page.getByRole("menu", { name: "Workspaces" });
  const settings = page.getByRole("dialog", { name: "Workspace settings" });

  await page.goto(`/w/${other.slug}`);
  await loaded(page);
  await page.getByRole("button", { name: "Switch workspace" }).click();
  // Without login nobody else could take it over: no Leave.
  await expect(menu.getByRole("menuitem", { name: "Leave workspace" })).toHaveCount(0);
  await menu.getByRole("menuitem", { name: "Workspace settings" }).click();
  await settings.getByLabel("Name", { exact: true }).fill(renamed);
  await settings.getByRole("button", { name: "Rename" }).click();
  await expect(settings.getByRole("status")).toContainText("Renamed");
  await expect(location.getByRole("button", { name: renamed, exact: true })).toBeVisible();

  // Archiving asks for its name, as it is now.
  const archive = settings.getByRole("region", { name: "Archive the workspace" });
  await expect(archive.getByRole("button", { name: "Archive" })).toBeDisabled();
  await archive.getByLabel(/to confirm/).fill(name);
  await expect(archive.getByRole("button", { name: "Archive" })).toBeDisabled();
  await archive.getByLabel(/to confirm/).fill(renamed);
  await archive.getByRole("button", { name: "Archive" }).click();
  await expect(page).toHaveURL(/\/w\/default$/);
  await loaded(page);
  expect((await request.get("/api/files", { headers: { [HEADER]: other.id } })).status()).toBe(404);

  // It is gone from the list, and waits under Archived workspaces.
  await page.getByRole("button", { name: "Switch workspace" }).click();
  await expect(menu.getByRole("list", { name: "Archived workspaces" })).toContainText(renamed);
  await expect(menu.locator("a", { hasText: renamed })).toHaveCount(0);
  await menu.getByRole("menuitem", { name: `Restore ${renamed}` }).click();
  await expect(page).toHaveURL(new RegExp(`/w/${other.slug}$`));
  await loaded(page);
  await expect(location.getByRole("button", { name: renamed, exact: true })).toBeVisible();

  // The default workspace can be renamed, never archived.
  await page.goto("/w/default");
  await loaded(page);
  await page.getByRole("button", { name: "Switch workspace" }).click();
  await menu.getByRole("menuitem", { name: "Workspace settings" }).click();
  await expect(settings.getByLabel("Name", { exact: true })).toBeVisible();
  await expect(settings.getByRole("region", { name: "Archive the workspace" })).toHaveCount(0);
});
