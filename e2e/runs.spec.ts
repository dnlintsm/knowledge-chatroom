import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
// The agent's database client: provenance is only written by Claude's tools,
// which the mock agent doesn't run, so this test writes one directly.
import postgres from "../agent/node_modules/postgres";

/** Shows a sidebar view; clicking it while it is already shown would fold the sidebar away. */
async function showView(page: Page, name: "Files" | "Runs") {
  const button = page.getByRole("button", { name, exact: true });
  if ((await button.getAttribute("aria-pressed")) !== "true") await button.click();
}
const showFiles = (page: Page) => showView(page, "Files");

/**
 * Runs are experiments with a report (issue #82). Runs need server storage,
 * so this runs with it (npm run test:e2e:storage). Screenshots continue the
 * numbering of preview.spec.ts.
 */
const SCREENSHOT_DIR = "preview/screenshots";

async function shot(page: Page, name: string) {
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${SCREENSHOT_DIR}/${name}.png` });
}

const reply = { timeout: 90_000 };
const md = { "Content-Type": "text/markdown" };
const ETCH = "runs/etch-2026-10-01";

interface Experiment {
  id: string;
  title: string;
  nodeId: string | null;
}

/** A run at the workspace root, made through the API, with these files. */
async function makeRun(request: APIRequestContext, title: string, files: Record<string, string>) {
  const res = await request.post("/api/experiments", { data: { nodeId: null, title } });
  expect(res.ok()).toBe(true);
  const run = (await res.json()) as Experiment;
  for (const [path, content] of Object.entries(files)) {
    expect((await request.put(`/api/files/${path}?experiment=${run.id}`, { data: content, headers: md })).ok()).toBe(true);
  }
  return run;
}

async function send(page: Page, text: string) {
  await page.getByTestId("copilot-chat-textarea").fill(text);
  await page.getByTestId("copilot-send-button").click();
  await expect(page.getByText(text)).toBeVisible();
}

/** Opens a run by its link and waits for its report. */
async function gotoRun(page: Page, run: Experiment, report: string) {
  await page.goto(`/?experiment=${run.id}`);
  await expect(page.getByRole("navigation", { name: "Location" })).toContainText(run.title);
  await expect(page.getByTestId("file-preview")).toContainText(report);
}

// Each test starts with no runs.
test.beforeEach(async ({ request }) => {
  // The agent's /health answers before storage finishes migrating (503 here).
  await expect.poll(async () => (await request.get("/api/nodes")).status(), { timeout: 60_000 }).toBe(200);
  const { experiments } = await (await request.get("/api/experiments")).json();
  for (const e of experiments as Experiment[]) await request.delete(`/api/experiments/${e.id}`);
});

test("runs: runs open from the Runs view and links", async ({ page, request }) => {
  await makeRun(request, "etch-2026-10-01", {
    "report.md": "# xDOE report: etch rate\n\nRF power dominates etch rate.\n",
    "effects.csv": "term,effect\npower,49.0\n",
  });
  await makeRun(request, "litho-2026-10-03", { "report.md": "# xDOE report: CD vs. dose and focus\n" });
  await page.goto("/");
  await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible();
  await showView(page, "Runs");
  const list = page.getByTestId("run-list");
  await expect(list).toContainText("etch-2026-10-01");
  await expect(list).toContainText("litho-2026-10-03");
  await shot(page, "01-runs");

  // Picking a run moves into it and opens its report.
  await list.getByRole("button").filter({ hasText: "etch-2026-10-01" }).click();
  await expect(page).toHaveURL(/\?experiment=[0-9a-f-]{36}$/);
  await expect(page.getByRole("navigation", { name: "Location" })).toContainText("etch-2026-10-01");
  await expect(page.getByTestId("file-preview")).toContainText("xDOE report: etch rate");
  await expect(page.getByTestId("chat-context-run")).toContainText("etch-2026-10-01");
  const etchUrl = page.url();
  await showFiles(page);
  await expect(page.locator('[role="treeitem"][title="effects.csv"]')).toBeVisible();
  await expect(page.getByTestId("actions")).toBeVisible();
  await expect(page.getByTestId("copilot-suggestion").filter({ hasText: "Analyze the report" })).toBeVisible();
  await shot(page, "02-run");

  // Home: the workspace root's Runs view lists every run.
  await page.getByRole("link", { name: "Knowledge Chatroom" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(list).toContainText("etch-2026-10-01");
  await shot(page, "19-home-link");
  await list.getByRole("button").filter({ hasText: "litho-2026-10-03" }).click();
  await expect(page.getByTestId("file-preview")).toContainText("xDOE report: CD vs. dose and focus");

  // Back and forward move between runs, each with its own report.
  await page.goBack();
  await expect(page).toHaveURL(/\/$/);
  await page.goBack();
  await expect(page).toHaveURL(etchUrl);
  await expect(page.getByTestId("file-preview")).toContainText("xDOE report: etch rate");

  // Compare: one row per run.
  await showView(page, "Runs");
  await page.getByRole("button", { name: "Compare runs" }).click();
  const table = page.getByTestId("runs-panel").getByRole("table");
  await expect(table.locator("tbody tr")).toHaveCount(2);
  await shot(page, "02b-compare-runs");
});

test("runs: a new run at the root starts empty and tracks its state", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible();
  await showView(page, "Runs");
  await page.getByRole("button", { name: "New run in the workspace" }).click();
  await page.getByRole("textbox", { name: "New run title" }).fill("First uploads");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\?experiment=/);
  const panel = page.getByTestId("experiment-panel");
  await expect(panel).toContainText("Run in the workspace");
  await expect(panel).toContainText("It started empty");
  await panel.getByRole("combobox", { name: "Run state" }).selectOption("running");
  await expect(page.getByTestId("run-list").locator('[data-state="running"]')).toBeVisible();
  await shot(page, "02c-run-state");
});

test("a run Claude started shows where it came from", async ({ page, request }) => {
  const first = await makeRun(request, "Wafer analysis, first try", { "report.md": "# First try\n" });
  const run = await makeRun(request, "Wafer analysis", {
    "inputs/wafers.csv": "wafer,dose\n1,30\n",
    "report.md": "# Wafer analysis\n\nDose is on target.\n",
  });
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  try {
    const provenance = {
      startedBy: { id: run.id, name: "Local user" },
      startedAt: "2026-10-21T09:00:00.000Z",
      finishedAt: "2026-10-21T09:02:00.000Z",
      chat: "thread-e2e",
      model: "claude-test",
      skill: { name: "analysis", source: "workspace", sha256: "ab12cd34ef56" },
      tools: { agent: "0.1.1", claudeAgentSdk: "0.3.296" },
      rerunOf: { id: first.id },
      inputs: [
        {
          path: "inputs/wafers.csv",
          from: { node: null, experiment: null, path: "uploads/wafers.csv" },
          version: run.id,
          sha256: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
          size: 18,
        },
      ],
    };
    await sql`UPDATE experiments SET provenance = ${sql.json(provenance)}, state = 'done' WHERE id = ${run.id}`;
  } finally {
    await sql.end();
  }
  await gotoRun(page, run, "Dose is on target.");
  await page.getByRole("navigation", { name: "Location" }).getByRole("button", { name: run.title }).click();
  const provenance = page.getByTestId("run-provenance");
  await expect(provenance).toContainText("Local user");
  await expect(provenance).toContainText("claude-test");
  await expect(provenance).toContainText("analysis · ab12cd34");
  const inputs = page.getByRole("list", { name: "Inputs" });
  await expect(inputs).toContainText("from uploads/wafers.csv · 9f86d081");
  await shot(page, "02d-run-provenance");
  await inputs.getByRole("button", { name: "inputs/wafers.csv" }).click();
  await expect(page.getByTestId("file-preview")).toContainText("dose");

  // A rerun links back to the run it ran again.
  await page.getByRole("navigation", { name: "Location" }).getByRole("button", { name: run.title }).click();
  await provenance.getByRole("button", { name: first.title }).click();
  await expect(page).toHaveURL(new RegExp(`experiment=${first.id}$`));
  await expect(page.getByRole("navigation", { name: "Location" })).toContainText(first.title);
});

test("a link to a missing run, or an old ?run= link, drops out of the URL", async ({ page }) => {
  await page.goto("/?experiment=00000000-0000-4000-8000-000000000000");
  await expect(page.getByTestId("notices")).toContainText("That run isn't there, or isn't shared with you.");
  await expect(page).not.toHaveURL(/experiment=/);
  await page.goto(`/?run=${ETCH}`);
  await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible();
  await expect(page).not.toHaveURL(/run=/);
});

test("the Actions block starts a new chat about the run", async ({ page, request }) => {
  const run = await makeRun(request, "Etch actions", { "report.md": "# Etch actions report\n" });
  await gotoRun(page, run, "Etch actions report");
  await showFiles(page);
  const actions = page.getByTestId("actions");
  await expect(actions).toBeVisible();
  await send(page, "Hello there");
  await expect(page.getByTestId("copilot-assistant-message").first()).toBeVisible(reply);
  await expect(page.getByTestId("copilot-suggestion").first()).toBeVisible(reply);
  await shot(page, "09-actions");

  // A double click starts one new chat, not two (the runner refuses quick repeats).
  await actions.getByRole("button", { name: "New Chat" }).dblclick();
  await expect(page.getByText("Hello there")).toHaveCount(0);
  await expect(page.getByTestId("copilot-chat-textarea")).toBeFocused();
  await expect(page.getByTestId("chat-context-run")).toContainText("Etch actions");

  // The block folds away and stays folded.
  await actions.getByRole("button", { name: "Actions" }).click();
  await expect(actions.getByRole("button", { name: "New Chat" })).toBeHidden();
  await page.reload();
  await expect(page.getByTestId("actions").getByRole("button", { name: "Actions" })).toHaveAttribute(
    "aria-expanded",
    "false",
  );

  // Outside a run there are no actions.
  await page.getByRole("navigation", { name: "Location" }).getByRole("button", { name: "Workspace" }).click();
  await expect(page).not.toHaveURL(/experiment=/);
  await expect(page.getByTestId("actions")).toHaveCount(0);
});

test("Generate Rules writes the run's rules once, read-only, then opens them", async ({ page, request }) => {
  const run = await makeRun(request, "etch-2026-10-01", { "report.md": "# Etch rules report\n" });
  const other = await makeRun(request, "litho-2026-10-03", { "report.md": "# Litho report\n" });
  const apiCalls: string[] = [];
  page.on("request", (req) => {
    if (new URL(req.url()).pathname === "/api/rules") apiCalls.push(req.url());
  });
  await gotoRun(page, run, "Etch rules report");
  await showFiles(page);
  const actions = page.getByTestId("actions");
  const generate = actions.getByRole("button", { name: "Generate Rules" });
  await expect(generate).toBeEnabled();
  // A double click still asks the API once.
  await generate.dblclick();
  const preview = page.getByTestId("file-preview");
  await expect(preview).toContainText("General rules: etch-2026-10-01");
  await expect(page.getByTestId("read-only-badge")).toBeVisible();
  await expect(page.getByRole("group", { name: "View mode" })).toHaveCount(0);
  await expect(page.getByTestId("notices")).toContainText("Generated models/general_rules.md");
  await expect(actions.getByRole("button", { name: "Open Rules" })).toBeVisible();
  const row = page.getByRole("treeitem", { name: /general_rules\.md/ });
  await expect(row).toHaveAttribute("title", "models/general_rules.md");
  await expect(row.getByRole("button", { name: /Delete/ })).toHaveCount(0);
  await shot(page, "10-generated-rules");
  expect(apiCalls).toHaveLength(1);
  const asked = new URL(apiCalls[0]).searchParams;
  expect([asked.get("run"), asked.get("experiment")]).toEqual(["etch-2026-10-01", run.id]);

  // After a reload the rules are there, so the action only opens them.
  await page.reload();
  await page.getByRole("tab", { name: /report\.md/ }).click();
  await page.getByTestId("actions").getByRole("button", { name: "Open Rules" }).click();
  await expect(preview).toContainText("General rules: etch-2026-10-01");
  expect(apiCalls).toHaveLength(1);

  // The other run has no rules yet.
  await gotoRun(page, other, "Litho report");
  await showFiles(page);
  await expect(page.getByTestId("actions").getByRole("button", { name: "Generate Rules" })).toBeVisible();
});

test("Claude runs actions and switches runs through the workbench", async ({ page, request }) => {
  const run = await makeRun(request, "etch-2026-10-01", { "report.md": "# Etch report\n" });
  const other = await makeRun(request, "litho-2026-10-03", { "report.md": "# xDOE report: CD vs. dose\n" });
  await gotoRun(page, run, "Etch report");
  await send(page, "Please generate the rules for this run");
  await expect(page.getByTestId("file-preview")).toContainText("General rules: etch-2026-10-01", reply);
  await expect(page.getByTestId("read-only-badge")).toBeVisible();
  await expect(page.getByText("Generated the run's general rules")).toBeVisible(reply);
  await shot(page, "11-claude-runs-action");

  await send(page, `Now open the run ${other.id}`);
  await expect(page.getByRole("navigation", { name: "Location" })).toContainText("litho-2026-10-03", reply);
  await expect(page.getByTestId("file-preview")).toContainText("xDOE report: CD vs. dose");
  // The conversation carries on in the other run.
  await expect(page.getByText("Switched to the other run.")).toBeVisible(reply);
  await expect(page.getByTestId("chat-context-run")).toContainText("litho-2026-10-03");
  await expect(page).toHaveURL(new RegExp(`experiment=${other.id}$`));
});

test("each chat run in a run tells the agent which run (docs/remote-agent.md)", async ({ page, request }) => {
  const run = await makeRun(request, "Etch props", { "report.md": "# Props report\n", "data/effects.csv": "a,b\n" });
  await gotoRun(page, run, "Props report");
  await showFiles(page);
  await page.getByRole("treeitem", { name: /effects\.csv/ }).click();
  await send(page, "What does this file show?");
  await expect(page.getByTestId("copilot-assistant-message").first()).toBeVisible(reply);

  const lastRun = await (await request.get(`${process.env.LOCAL_AGENT_URL}/last-run`)).json();
  expect(lastRun.forwardedProps.knowledge_chatroom).toEqual({
    version: 2,
    user: { id: "local", email: null, name: null, signed_in: false },
    storage: "server",
    node: null,
    experiment: {
      id: run.id, node_id: null, title: "Etch props", status: "draft", state: "ready", can_change: true, report: "report.md",
    },
    selected_path: "data/effects.csv",
  });
});
