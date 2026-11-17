import { test, expect } from "@playwright/test";

// Real Python API + Python chat agent + production Next.js. Only the model is
// scripted; no TypeScript agent or mock API server is started for this mode.
test("Python backend serves the workspace and streamed chat without the TypeScript API", async ({ page, request }) => {
  const question = `Hello there ${Date.now()}`;
  const api = `http://localhost:${process.env.E2E_STORAGE_PORT ?? 8001}`;
  expect((await request.get(`${api}/health`)).status()).toBe(200);
  expect((await request.post(`${api}/`)).status()).toBe(404);
  expect((await request.post(`${api}/agent/report`)).status()).toBe(404);
  expect((await request.get(`${api}/tools`)).status()).toBe(200);

  await page.goto("/");
  const input = page.getByTestId("copilot-chat-textarea");
  await expect(input).toBeVisible();
  const workspaces = await request.get("/api/workspaces");
  expect(workspaces.status()).toBe(200);
  const skills = await request.get("/api/skills");
  expect(skills.status()).toBe(200);
  expect(JSON.stringify(await skills.json())).toContain("tldr");

  await input.fill(question);
  await page.getByTestId("copilot-send-button").click();
  await expect(page.getByTestId("copilot-assistant-message").last()).toContainText(
    "Hello from the Python agent", { timeout: 60_000 },
  );
  await expect(page.getByTestId("copilot-send-button")).toBeDisabled({ timeout: 60_000 });
  await expect(page.getByTestId("copilot-suggestion").filter({ hasText: "Check the evidence" })).toBeVisible({ timeout: 30_000 });

  await input.fill("/tldr RF power");
  await page.getByTestId("copilot-send-button").click();
  await expect(page.getByTestId("copilot-assistant-message").last()).toContainText("TL;DR", { timeout: 60_000 });
  await expect(page.getByTestId("skill-used")).toHaveText("/tldr", { timeout: 60_000 });
  await expect(page.getByTestId("copilot-send-button")).toBeDisabled({ timeout: 60_000 });

  // The conversation remains available after reloading through the Python API.
  await page.reload();
  await expect(input).toBeVisible();
  await page.getByRole("button", { name: "Chat history" }).click();
  await page.getByTestId("chat-history").getByRole("option", { name: question }).click();
  await expect(page.getByTestId("copilot-assistant-message").last()).toContainText("TL;DR", { timeout: 30_000 });
});
