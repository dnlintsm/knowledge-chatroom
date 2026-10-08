import { test, expect, type Page } from "@playwright/test";

/**
 * Screens captured for PR previews. Each `shot` lands in preview/screenshots
 * with a numbered name so the PR comment lists them in walkthrough order.
 */
const SCREENSHOT_DIR = "preview/screenshots";

async function shot(page: Page, name: string) {
  // Let animations and streamed text settle before capturing.
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${SCREENSHOT_DIR}/${name}.png` });
}

// A sample run from the seed files (src/components/workspace/seed.ts).
const RUN = "runs/etch-2026-10-01";
const RUN_URL = `/?run=${RUN}`;

/** Opens the sample run and waits until the page has focused it. */
async function gotoRun(page: Page) {
  await page.goto(RUN_URL);
  await expect(page.getByRole("navigation", { name: "Current run" })).toBeVisible();
}

/** Focus mode on the sample run: the only mode with a chat. */
async function openHome(page: Page) {
  await gotoRun(page);
  await expect(page.getByTestId("copilot-chat-textarea")).toBeVisible();
  await expect(page.getByTestId("copilot-suggestion").first()).toBeVisible();
}

// Long timeouts leave room for a real Claude reply when ANTHROPIC_API_KEY is set.
const reply = { timeout: 90_000 };

async function send(page: Page, text: string) {
  await page.getByTestId("copilot-chat-textarea").fill(text);
  await page.getByTestId("copilot-send-button").click();
  await expect(page.getByText(text)).toBeVisible();
}

test("workspace walkthrough", async ({ page }) => {
  // Traverse mode: the runs in the workspace, and no chat.
  await page.goto("/");
  await expect(page.getByTestId("run-list")).toBeVisible();
  await expect(page.getByTestId("copilot-chat-textarea")).toBeHidden();
  await expect(page.getByRole("button", { name: "Show chat" })).toHaveCount(0);
  await shot(page, "01-traverse");

  // Focusing a run opens its report, roots the file tree at it and brings the chat back.
  await page.getByRole("button", { name: /etch-2026-10-01/ }).click();
  await expect(page).toHaveURL(new RegExp(`\\?run=${RUN}$`));
  await expect(page.getByRole("navigation", { name: "Current run" })).toContainText("etch-2026-10-01");
  await expect(page.getByTestId("file-preview")).toContainText("xDOE report: etch rate");
  await expect(page.getByTestId("chat-context-run")).toContainText("etch-2026-10-01");
  await expect(page.getByRole("treeitem", { name: /effects\.csv/ })).toBeVisible();
  await expect(page.getByRole("treeitem", { name: /welcome\.md/ })).toHaveCount(0);
  await expect(page.getByTestId("copilot-suggestion").first()).toBeVisible();
  await shot(page, "02-focus-run");

  // Selecting text in the preview shows up as chat context.
  await page.getByTestId("file-preview").getByText("RF power dominates etch rate").selectText();
  await page.getByTestId("file-preview").dispatchEvent("mouseup");
  await expect(page.getByTestId("chat-context")).toContainText("selected chars");

  await send(page, "Summarize this file and save it under artifacts/");
  // The suggestion chips hide while a run streams and come back once it ends.
  await expect(page.getByTestId("copilot-assistant-message").first()).toBeVisible(reply);
  await expect(page.getByTestId("copilot-suggestion").first()).toBeVisible(reply);
  await shot(page, "03-claude-writes-artifact");

  await page.getByRole("treeitem", { name: /report\.md/ }).click();
  await expect(page.getByTestId("file-preview").locator("table").first()).toBeVisible();
  await page.getByRole("button", { name: "edit", exact: true }).click();
  await expect(page.getByTestId("file-editor")).toBeVisible();
  await shot(page, "04-edit-mode");

  await page.getByRole("button", { name: "Skills", exact: true }).click();
  await page.getByRole("treeitem", { name: /summarize/ }).click();
  await shot(page, "05-skills");

  await page.getByRole("button", { name: "Task board" }).click();
  await expect(page.getByRole("button", { name: "Add a task" })).toBeVisible();
  await page.getByRole("button", { name: "Add a task" }).click();
  await shot(page, "06-task-board");

  await page.getByRole("button", { name: "Chats", exact: true }).click();
  await shot(page, "07-chats-list");

  await page.getByRole("button", { name: "Hide chat" }).click();
  await page.getByRole("button", { name: "Files", exact: true }).click();
  await shot(page, "08-hidden-chat");

  // Leaving the run goes back to Traverse; the browser's back button returns to it.
  await page.getByRole("button", { name: "Leave run" }).click();
  await expect(page.getByTestId("run-list")).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
  await page.goBack();
  await expect(page.getByRole("navigation", { name: "Current run" })).toContainText("etch-2026-10-01");
});

test("links and back/forward show the focused run's own report", async ({ page }) => {
  await gotoRun(page);
  const preview = page.getByTestId("file-preview");
  await expect(preview).toContainText("xDOE report: etch rate");
  await page.getByRole("button", { name: "Traverse", exact: true }).click();
  await page.getByRole("button", { name: /litho-2026-10-03/ }).click();
  await expect(preview).toContainText("xDOE report: CD vs. dose and focus");
  await page.goBack();
  await expect(page.getByRole("navigation", { name: "Current run" })).toContainText("etch-2026-10-01");
  await expect(preview).toContainText("xDOE report: etch rate");
});

test("a link to a missing run falls back to Traverse", async ({ page }) => {
  await page.goto("/?run=runs/nope");
  await expect(page.getByTestId("notices")).toContainText("There is no run at runs/nope.");
  await expect(page.getByTestId("run-list")).toBeVisible();
  await expect(page).not.toHaveURL(/run=/);
});

test("the Actions block starts a new chat about the run", async ({ page }) => {
  await openHome(page);
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
  await expect(page.getByTestId("chat-context-run")).toContainText("etch-2026-10-01");

  // The block folds away and stays folded.
  await actions.getByRole("button", { name: "Actions" }).click();
  await expect(actions.getByRole("button", { name: "New Chat" })).toBeHidden();
  await page.reload();
  await expect(page.getByTestId("actions").getByRole("button", { name: "Actions" })).toHaveAttribute(
    "aria-expanded",
    "false",
  );

  // Traverse mode has no run, so no actions.
  await page.getByRole("button", { name: "Leave run" }).click();
  await page.getByRole("button", { name: "Files", exact: true }).click();
  await expect(page.getByTestId("actions")).toHaveCount(0);
});

test("Generate Rules writes the run's rules once, read-only, then opens them", async ({ page }) => {
  const apiCalls: string[] = [];
  page.on("request", (req) => {
    if (new URL(req.url()).pathname === "/api/rules") apiCalls.push(req.url());
  });
  await gotoRun(page);
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
  await expect(row).toHaveAttribute("title", `${RUN}/models/general_rules.md`);
  await expect(row.getByRole("button", { name: /Delete/ })).toHaveCount(0);
  await shot(page, "10-generated-rules");
  expect(apiCalls).toHaveLength(1);
  expect(apiCalls[0]).toContain(`run=${encodeURIComponent(RUN)}`);

  // After a reload the rules are there, so the action only opens them.
  await page.reload();
  await expect(page.getByRole("navigation", { name: "Current run" })).toBeVisible();
  await page.getByRole("tab", { name: /welcome\.md/ }).click();
  await page.getByTestId("actions").getByRole("button", { name: "Open Rules" }).click();
  await expect(preview).toContainText("General rules: etch-2026-10-01");
  expect(apiCalls).toHaveLength(1);

  // The other run has no rules yet.
  await page.getByRole("button", { name: "Traverse", exact: true }).click();
  await page.getByRole("button", { name: /litho-2026-10-03/ }).click();
  await expect(page.getByTestId("actions").getByRole("button", { name: "Generate Rules" })).toBeVisible();
});

test("selection is dropped when its file closes", async ({ page }) => {
  await gotoRun(page);
  await page.getByRole("treeitem", { name: /report\.md/ }).click();
  const preview = page.getByTestId("file-preview");
  await preview.getByRole("heading", { name: "Findings" }).selectText();
  await preview.dispatchEvent("mouseup");
  const context = page.getByTestId("chat-context");
  await expect(context).toContainText("selected chars");
  await page.getByRole("tab", { name: /report\.md/ }).getByRole("button", { name: "Close tab" }).click();
  await expect(preview).toContainText("Welcome to Knowledge Chatroom");
  await expect(context).not.toContainText("selected chars");
});

test("files and layout survive a reload", async ({ page }) => {
  await gotoRun(page);
  await expect(page.getByTestId("file-preview")).toBeVisible();
  await page.getByRole("button", { name: "New note" }).click();
  await page.getByTestId("file-editor").fill("# Kept after reload");
  await page.getByRole("button", { name: "Hide chat" }).click();
  await page.reload();
  // New notes go into the focused run.
  await expect(page.getByRole("treeitem", { name: /untitled-1\.md/ })).toHaveAttribute(
    "title",
    `${RUN}/untitled-1.md`,
  );
  await expect(page.getByRole("button", { name: "Show chat" })).toBeVisible();
});

test("dark mode", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await openHome(page);
  await shot(page, "11-dark-mode");
});

test("mobile layout", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  // Traverse mode has no Chat tab.
  await page.goto("/");
  await expect(page.getByTestId("run-list")).toBeVisible();
  await expect(page.getByRole("button", { name: "Chat", exact: true })).toHaveCount(0);
  await gotoRun(page);
  await expect(page.getByTestId("file-preview")).toBeVisible();
  await shot(page, "12-mobile-editor");
  await page.getByRole("button", { name: "Files" }).last().click();
  await shot(page, "13-mobile-files");
  // Tapping a file switches to the editor.
  await page.getByRole("treeitem", { name: /report\.md/ }).click();
  await expect(page.getByTestId("file-preview")).toBeVisible();
  await page.getByRole("button", { name: "Chat", exact: true }).click();
  await expect(page.getByTestId("copilot-chat-textarea")).toBeVisible();
  await shot(page, "14-mobile-chat");
});

// The mock agent answers "read next" with references to notes/reading-list.md
// line 7 and uploads/sales.csv lines 3-4; real Claude words its answer freely.
const citesFiles = "Which book should I read next?";
const fileRef = (page: Page, text: string) => page.getByTestId("file-ref").filter({ hasText: text });

test("file references in answers open the cited lines", async ({ page }) => {
  test.skip(Boolean(process.env.ANTHROPIC_API_KEY), "Needs the mock agent's canned answer.");
  await openHome(page);
  await send(page, citesFiles);
  await fileRef(page, "The Pragmatic Programmer").click(reply);

  // The preview switches to the file and highlights the cited table row.
  await expect(page.getByRole("tab", { name: /reading-list\.md/ })).toHaveAttribute("aria-selected", "true");
  const cited = page.getByTestId("file-preview").locator("[data-revealed]");
  await expect(cited).toHaveText(/The Pragmatic Programmer/);
  await expect(cited).toBeInViewport();
  await shot(page, "15-file-reference");

  // The editor selects the same line.
  await page.getByRole("button", { name: "edit", exact: true }).click();
  const editor = page.getByTestId("file-editor");
  await expect(editor).toBeFocused();
  await expect
    .poll(() => editor.evaluate((t: HTMLTextAreaElement) => t.value.slice(t.selectionStart, t.selectionEnd)))
    .toBe("| The Pragmatic Programmer | Craft | Next |");

  // A range highlights each row it covers.
  await fileRef(page, "sales.csv:3-4").click();
  await expect(page.getByTestId("file-preview").locator("tr[data-revealed]")).toHaveText([/2026-08/, /2026-09/]);
});

test("file references on a phone show the editor", async ({ page }) => {
  test.skip(Boolean(process.env.ANTHROPIC_API_KEY), "Needs the mock agent's canned answer.");
  await page.setViewportSize({ width: 390, height: 844 });
  await gotoRun(page);
  await page.getByRole("button", { name: "Files" }).last().click();
  await page.getByRole("button", { name: "Uploads", exact: true }).click();
  await page.getByRole("treeitem", { name: /sales\.csv/ }).click();
  // The CopilotKit inspector sometimes pops open over the editor toolbar on a phone.
  await page.getByRole("button", { name: "edit", exact: true }).dispatchEvent("click");
  await page.getByRole("button", { name: "Chat", exact: true }).click();
  await send(page, citesFiles);
  await fileRef(page, "sales.csv:3-4").click(reply);
  // Only possible once the editor pane is on screen.
  await expect(page.getByTestId("file-editor")).toBeFocused();
});
