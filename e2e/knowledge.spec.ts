import { test, expect, type Page } from "@playwright/test";

/**
 * Server storage and the knowledge tree. Runs when the agent has storage
 * (DATABASE_URL and the S3_* vars, as in CI); see playwright.config.ts.
 * Screenshots continue the numbering of preview.spec.ts.
 */
const SCREENSHOT_DIR = "preview/screenshots";

async function shot(page: Page, name: string) {
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${SCREENSHOT_DIR}/${name}.png` });
}

const TECH = "Etch";
const MODULE = "Module 3";

test.skip(!process.env.DATABASE_URL, "Needs server storage (DATABASE_URL).");

// A local database keeps nodes between runs; start from a tree without them.
test.beforeEach(async ({ request }) => {
  const { nodes } = await (await request.get("/api/nodes")).json();
  for (const node of nodes.filter((n: { parentId: string | null; name: string }) => !n.parentId && n.name === TECH)) {
    await request.delete(`/api/nodes/${node.id}`);
  }
});

test("knowledge tree", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible();

  await page.getByRole("button", { name: "Knowledge", exact: true }).click();
  const tree = page.getByRole("tree", { name: "Knowledge tree" });
  await expect(tree).toBeVisible();
  const node = (name: string) => tree.getByTestId("knowledge-node").filter({ hasText: name });

  // A tech at the top level, then a module under it.
  await tree.getByRole("button", { name: /^New / }).click();
  await page.getByPlaceholder(/^New .* name$/).fill(TECH);
  await page.keyboard.press("Enter");
  await node(TECH).click();
  await expect(page.getByRole("navigation", { name: "Location" })).toContainText(TECH);

  await node(TECH).hover();
  await node(TECH).getByRole("button", { name: `Add module under ${TECH}` }).click();
  await page.getByPlaceholder(/^New .* name$/).fill(MODULE);
  await page.keyboard.press("Enter");
  await node(MODULE).click();
  const location = page.getByRole("navigation", { name: "Location" });
  await expect(location).toContainText(MODULE);
  await shot(page, "14-knowledge-tree");

  // A note written in the module is saved there, not at the workspace root.
  await page.getByRole("button", { name: "Files", exact: true }).click();
  await page.getByRole("button", { name: "New note" }).click();
  await page.getByTestId("file-editor").fill(`# ${MODULE} notes\n\nRecipe changes for this module go here.`);
  await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible();
  await page.getByRole("button", { name: "Knowledge", exact: true }).click();
  await expect(tree.getByRole("treeitem", { name: /untitled-1\.md/ })).toBeVisible();
  await shot(page, "15-knowledge-node-files");

  // Back at the root, the module's note is not listed.
  await location.getByRole("button", { name: "Workspace" }).click();
  await expect(location).not.toContainText(MODULE);
  await expect(tree.getByRole("treeitem", { name: /untitled-1\.md/ })).toHaveCount(0);
});
