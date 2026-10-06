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
  await page.getByRole("button", { name: "Chat", exact: true }).click();
  await expect(page.getByTestId("copilot-chat-textarea")).toBeVisible();
  await shot(page, "12-mobile-chat");
});
