import { test, expect } from "@playwright/test";
// The agent's database client, to check where the chat was kept.
import postgres from "../agent/node_modules/postgres";

/**
 * Chats are kept per user on the server (issue #91): with server storage, in
 * Postgres through the agent's /chats API, so they outlive the app process.
 * Runs with storage (npm run test:e2e:storage); preview.spec.ts covers the
 * same flow with chats in memory.
 */

const reply = { timeout: 90_000 };

test("a chat is saved to the database and reopens after a reload", async ({ page }) => {
  const question = `Where did the chamber clean notes go? ${Date.now()}`;
  await page.goto("/");
  await page.getByTestId("copilot-chat-textarea").fill(question);
  await page.getByTestId("copilot-send-button").click();
  await expect(page.getByTestId("copilot-assistant-message").first()).toBeVisible(reply);
  await expect(page.getByTestId("copilot-suggestion").first()).toBeVisible(reply);

  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  try {
    await expect
      .poll(async () => (await sql<{ name: string; runs: number }[]>`
        SELECT c.name, (SELECT count(*)::int FROM chat_runs r WHERE r.chat_id = c.id) AS runs
        FROM chats c WHERE c.name = ${question}`)[0] ?? null)
      .toEqual({ name: question, runs: 1 });
  } finally {
    await sql.end();
  }

  await page.reload();
  await expect(page.getByTestId("copilot-chat-textarea")).toBeVisible();
  await page.getByRole("button", { name: "Chat history" }).click();
  const chat = page.getByTestId("chat-history").getByRole("option", { name: question });
  await expect(chat).toBeVisible();
  await chat.click();
  await expect(page.getByText(question)).toBeVisible();
  await expect(page.getByTestId("copilot-assistant-message").first()).toBeVisible();
});
