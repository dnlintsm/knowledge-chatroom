import { test, expect, type Page } from "@playwright/test";

/**
 * Server storage and the knowledge tree. Runs when the agent has storage
 * (npm run test:e2e:storage); prerequisites are enforced by the config.
 * Screenshots continue the numbering of preview.spec.ts.
 */
const SCREENSHOT_DIR = "preview/screenshots";

async function shot(page: Page, name: string) {
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${SCREENSHOT_DIR}/${name}.png` });
}

const TECH = "Etch";
const MODULE = "Module 3";


// A local database keeps nodes between runs; start from a tree without them.
test.beforeEach(async ({ request }) => {
  // The agent's /health answers before storage finishes migrating (503 here).
  await expect.poll(async () => (await request.get("/api/nodes")).status(), { timeout: 60_000 }).toBe(200);
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

test("experiments", async ({ page, request }) => {
  await page.goto("/");
  await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible();
  await page.getByRole("button", { name: "Knowledge", exact: true }).click();
  const tree = page.getByRole("tree", { name: "Knowledge tree" });
  const node = (name: string) => tree.getByTestId("knowledge-node").filter({ hasText: name });
  const location = page.getByRole("navigation", { name: "Location" });

  // Etch › Module 3 › Endpoint › Main etch, the process the experiments run on.
  await tree.getByRole("button", { name: /^New / }).click();
  await page.getByPlaceholder(/^New .* name$/).fill(TECH);
  await page.keyboard.press("Enter");
  let parent = TECH;
  for (const [level, name] of [["module", MODULE], ["loop", "Endpoint"], ["process", "Main etch"]]) {
    await node(parent).hover();
    await node(parent).getByRole("button", { name: `Add ${level} under ${parent}` }).click();
    await page.getByPlaceholder(/^New .* name$/).fill(name);
    await page.keyboard.press("Enter");
    parent = name;
  }
  await node("Main etch").click();
  await expect(location).toContainText("Main etch");
  await page.getByRole("button", { name: "Files", exact: true }).click();
  await page.getByRole("button", { name: "New note" }).click();
  await page.getByTestId("file-editor").fill("# Main etch recipe\n\nRF power: 300 W\nPressure: 30 mTorr");
  await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible();

  // Fork the process into an experiment; it opens on its details.
  const panel = page.getByTestId("experiment-panel");
  const startExperiment = async (title: string) => {
    // Clicking the open view's button would close the sidebar.
    if (!(await tree.isVisible())) await page.getByRole("button", { name: "Knowledge", exact: true }).click();
    await node("Main etch").hover();
    await node("Main etch").getByRole("button", { name: "New experiment on Main etch" }).click();
    await page.getByPlaceholder("New experiment title").fill(title);
    await page.keyboard.press("Enter");
    await expect(location).toContainText(title);
    await expect(panel.getByLabel("Title")).toHaveValue(title);
  };
  const record = async (section: "Parameters" | "Results", name: string, value: string) => {
    const singular = section === "Parameters" ? "parameter" : "result";
    await panel.getByRole("button", { name: `Add ${singular}` }).click();
    await panel.getByLabel(`${singular} name`).last().fill(name);
    await panel.getByLabel(`${name} value`).fill(value);
  };
  const saved = (title: string, check: (e: { params: object; results: object; status: string }) => boolean) =>
    expect
      .poll(async () => {
        const { experiments } = await (await request.get("/api/experiments")).json();
        const e = experiments.find((x: { title: string }) => x.title === title);
        return Boolean(e && check(e));
      })
      .toBe(true);

  await startExperiment("Higher RF power");
  await expect(tree.getByTestId("experiment-node").filter({ hasText: "Higher RF power" })).toContainText("Draft");
  await panel.getByLabel("Hypothesis").fill("More RF power raises the etch rate without hurting uniformity.");
  await record("Parameters", "rf_power_W", "350");
  await record("Results", "etch_rate_nm_min", "412");
  await panel.getByLabel("Hypothesis").click(); // Leaving the rows saves them.
  await saved("Higher RF power", (e) => JSON.stringify(e.params) === '{"rf_power_W":350}');

  // Its files are a copy: editing the recipe here leaves the process alone.
  await tree.getByRole("treeitem", { name: /untitled-1\.md/ }).click();
  await page.getByRole("button", { name: "edit", exact: true }).click();
  await page.getByTestId("file-editor").fill("# Main etch recipe\n\nRF power: 350 W\nPressure: 30 mTorr");
  await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible();

  await page.getByRole("tab", { name: "Experiment" }).click();
  await panel.getByRole("button", { name: "Share" }).click();
  await expect(tree.getByTestId("experiment-node").filter({ hasText: "Higher RF power" })).toContainText("Shared");
  await page.mouse.move(900, 700);
  await shot(page, "18-experiment");

  // A second experiment on the same process; the two compare side by side.
  await startExperiment("Lower pressure");
  await record("Parameters", "pressure_mTorr", "20");
  await record("Results", "etch_rate_nm_min", "385");
  await panel.getByLabel("Hypothesis").click();
  await saved("Lower pressure", (e) => JSON.stringify(e.results) === '{"etch_rate_nm_min":385}');
  const compare = panel.getByRole("table", { name: "Experiments on Main etch" });
  await expect(compare).toContainText("Higher RF power");
  await expect(compare).toContainText("412");
  await compare.scrollIntoViewIfNeeded();
  await shot(page, "19-experiment-compare");

  // Back on the process, its recipe is unchanged.
  await location.getByRole("button", { name: "Main etch" }).click();
  await expect(location).not.toContainText("Lower pressure");
  await tree.getByRole("treeitem", { name: /untitled-1\.md/ }).click();
  // Still in edit mode from the experiment's copy of this path.
  await expect(page.getByTestId("file-editor")).toHaveValue(/RF power: 300 W/);
});
