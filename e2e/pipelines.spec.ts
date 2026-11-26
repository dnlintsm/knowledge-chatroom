import { test, expect, type Page } from "@playwright/test";

/**
 * Pipelines (docs/pipeline-identities.md, "Screens"): made from the workspace
 * switcher, used from a script with their key, shown on the Runs they start,
 * and revoked. Storage mode, with api-py serving pipelines (PIPELINES=on).
 * Screenshots continue runs.spec.ts's numbering.
 */
const SCREENSHOT_DIR = "preview/screenshots";

async function shot(page: Page, name: string) {
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${SCREENSHOT_DIR}/${name}.png` });
}

async function openPipelines(page: Page) {
  await page.getByRole("button", { name: "Switch workspace" }).click();
  await page.getByRole("menuitem", { name: "Pipelines" }).click();
  return page.getByRole("dialog", { name: "Pipelines" });
}

test("a pipeline is made with its places and operations, runs with its key, says so on its Run, and stops when revoked", async ({
  page,
  request,
}) => {
  await expect.poll(async () => (await request.get("/api/nodes")).status(), { timeout: 60_000 }).toBe(200);
  const name = `Etch ${Date.now()}`;
  const made = await request.post("/api/nodes", { data: { parentId: null, name } });
  expect(made.status()).toBe(201);
  const etch = (await made.json()) as { id: string };

  await page.goto("/");
  let dialog = await openPipelines(page);
  await dialog.getByRole("button", { name: "New pipeline" }).click();
  const form = dialog.getByRole("form", { name: "New pipeline" });
  await form.getByRole("textbox", { name: "Name" }).fill("Nightly etch import");
  await form.getByRole("radio", { name: /Only the nodes and Experiments I choose/ }).check();
  await form.getByRole("textbox", { name: "Find a place" }).fill(name);
  await form.getByRole("checkbox", { name }).click();
  await form.getByRole("checkbox", { name: /^Runs/ }).click();
  await shot(page, "02j-new-pipeline");
  await form.getByRole("button", { name: "Make pipeline" }).click();

  // The key, once.
  const reveal = dialog.getByRole("region", { name: "The key for Nightly etch import" });
  await expect(reveal).toContainText("You won't see this key again");
  const secret = (await reveal.getByTestId("pipeline-secret").textContent())!.trim();
  expect(secret).toMatch(/^kcp_[A-Za-z0-9_-]{43}$/);
  await shot(page, "02k-pipeline-key");
  await reveal.getByRole("button", { name: "Done" }).click();

  // A script uses it: in its place, an Experiment and a Run; elsewhere, nothing.
  const bearer = { Authorization: `Bearer ${secret}` };
  const exp = await request.post("/api/experiments", { headers: bearer, data: { nodeId: etch.id, title: "Overnight sweep" } });
  expect(exp.status()).toBe(201);
  const experiment = (await exp.json()) as { id: string };
  expect((await request.post(`/api/experiments/${experiment.id}/runs`, { headers: bearer, data: {} })).status()).toBe(201);
  expect((await request.get("/api/files", { headers: bearer })).status()).toBe(403);
  expect((await request.get("/api/memory", { headers: bearer })).status()).toBe(401);

  // The list shows what it reaches and that its key was used.
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  dialog = await openPipelines(page);
  const card = dialog.getByRole("listitem", { name: "Nightly etch import" });
  await expect(card).toContainText(name);
  await expect(card).toContainText("read, runs");
  await expect(card).toContainText("last used");
  await shot(page, "02l-pipelines");

  // Revoked: the next request with its key is refused.
  await card.getByRole("button", { name: "Revoke", exact: true }).click();
  await expect(card.getByRole("group", { name: "Revoke Nightly etch import" })).toContainText("A request already running ends");
  await card.getByRole("button", { name: "Revoke pipeline" }).click();
  await expect(card).toContainText("Revoked");
  expect((await request.get(`/api/experiments/${experiment.id}`, { headers: bearer })).status()).toBe(401);
  await page.keyboard.press("Escape");

  // Its Run says what it ran as, and that its pipeline was revoked while it ran.
  await page.goto(`/?experiment_id=${experiment.id}`);
  await page.getByRole("navigation", { name: "Location" }).getByRole("button", { name: "Overnight sweep", exact: true }).click();
  const panel = page.getByTestId("experiment-panel");
  await panel.getByRole("list", { name: "Runs" }).getByRole("button", { name: /^Run 1/ }).click();
  const view = panel.getByTestId("run-view");
  await expect(view).toContainText(/Pipeline Nightly etch import, key …\S{4}, for /);
  await expect(view).toContainText(`access, narrowed to ${name}: read, runs`);
  await expect(view).toContainText("Its pipeline was revoked while it ran");
  await shot(page, "02m-run-ran-as");
});
