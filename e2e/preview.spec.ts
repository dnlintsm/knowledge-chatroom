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

async function openHome(page: Page) {
  await page.goto("/");
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
  await openHome(page);
  await expect(page.getByTestId("file-preview")).toContainText("Welcome to Knowledge Chatroom");
  await shot(page, "01-workspace");

  // Selecting text in the preview shows up as chat context.
  await page.getByTestId("file-preview").getByText("This is your personal knowledge container.").selectText();
  await page.getByTestId("file-preview").dispatchEvent("mouseup");
  await expect(page.getByTestId("chat-context")).toContainText("selected chars");

  await send(page, "Summarize this file and save it under artifacts/");
  // The suggestion chips hide while a run streams and come back once it ends.
  await expect(page.getByTestId("copilot-assistant-message").first()).toBeVisible(reply);
  await expect(page.getByTestId("copilot-suggestion").first()).toBeVisible(reply);
  await shot(page, "02-claude-writes-artifact");

  await page.getByRole("treeitem", { name: /reading-list\.md/ }).click();
  await expect(page.getByTestId("file-preview").locator("table")).toBeVisible();
  await shot(page, "03-markdown-preview");

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
  await shot(page, "08-focus-mode");
});

test("selection is dropped when its file closes", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("treeitem", { name: /reading-list\.md/ }).click();
  const preview = page.getByTestId("file-preview");
  await preview.getByRole("heading", { name: "Reading list" }).selectText();
  await preview.dispatchEvent("mouseup");
  const context = page.getByTestId("chat-context");
  await expect(context).toContainText("selected chars");
  await page.getByRole("tab", { name: /reading-list\.md/ }).getByRole("button", { name: "Close tab" }).click();
  await expect(preview).toContainText("Welcome to Knowledge Chatroom");
  await expect(context).not.toContainText("selected chars");
});

test("files and layout survive a reload", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("file-preview")).toBeVisible();
  await page.getByRole("button", { name: "New note" }).click();
  await page.getByTestId("file-editor").fill("# Kept after reload");
  await page.getByRole("button", { name: "Hide chat" }).click();
  await page.reload();
  await expect(page.getByRole("treeitem", { name: /untitled-1\.md/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Show chat" })).toBeVisible();
});

test("dark mode", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await openHome(page);
  await shot(page, "09-dark-mode");
});

test("mobile layout", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.getByTestId("file-preview")).toBeVisible();
  await shot(page, "10-mobile-editor");
  await page.getByRole("button", { name: "Files" }).last().click();
  await shot(page, "11-mobile-files");
  // Tapping the file that is already open still switches to the editor.
  await page.getByRole("treeitem", { name: /welcome\.md/ }).click();
  await expect(page.getByTestId("file-preview")).toBeVisible();
  await page.getByRole("button", { name: "Chat", exact: true }).click();
  await expect(page.getByTestId("copilot-chat-textarea")).toBeVisible();
  await shot(page, "12-mobile-chat");
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
  await shot(page, "13-file-reference");

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
  await page.goto("/");
  await page.getByRole("button", { name: "Files" }).last().click();
  await page.getByRole("treeitem", { name: /reading-list\.md/ }).click();
  await page.getByRole("button", { name: "edit", exact: true }).click();
  await page.getByRole("button", { name: "Chat", exact: true }).click();
  await send(page, citesFiles);
  await fileRef(page, "The Pragmatic Programmer").click(reply);
  // Only possible once the editor pane is on screen.
  await expect(page.getByTestId("file-editor")).toBeFocused();
});
