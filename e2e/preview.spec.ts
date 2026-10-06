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

test("chat and app walkthrough", async ({ page }) => {
  await openHome(page);
  await shot(page, "01-chat-welcome");

  await page.getByTestId("copilot-chat-textarea").fill("Hello! What can you do?");
  await shot(page, "02-chat-typing");
  await page.getByTestId("copilot-send-button").click();

  await expect(page.getByText("Hello! What can you do?")).toBeVisible();
  // The suggestion chips hide while a run streams and come back once it ends,
  // so they mark the reply as complete. Long timeouts leave room for a real
  // Claude reply when ANTHROPIC_API_KEY is set.
  const reply = { timeout: 90_000 };
  await expect(page.getByTestId("copilot-assistant-message").first()).toBeVisible(reply);
  await expect(page.getByTestId("copilot-suggestion").first()).toBeVisible(reply);
  await shot(page, "03-chat-reply");

  await page.getByRole("button", { name: "App", exact: true }).click();
  await expect(page.getByRole("button", { name: "Add a task" })).toBeVisible();
  await shot(page, "04-app-mode");

  await page.getByRole("button", { name: "Add a task" }).click();
  await shot(page, "05-app-add-task");
});

test("dark mode", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await openHome(page);
  await shot(page, "06-dark-mode");
});

test("mobile layout", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openHome(page);
  await shot(page, "07-mobile");
});
