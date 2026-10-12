import { test, expect, type Page } from "@playwright/test";

const path = "notes/multi-tab.md";
const url = `/api/files/${path}`;
const headers = { "Content-Type": "text/markdown" };

async function openEditor(page: Page) {
  await page.goto("/");
  await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible();
  await page.getByRole("button", { name: "Files", exact: true }).click();
  await page.getByRole("treeitem", { name: /multi-tab\.md/ }).click();
  await page.getByRole("button", { name: "edit", exact: true }).dispatchEvent("click");
  await expect(page.getByTestId("file-editor")).toHaveValue("# Initial shared note");
}

test("two tabs synchronize saved edits and deletion through the real storage stream", async ({ page, context, request }) => {
  await expect.poll(async () => (await request.get("/api/nodes")).status(), { timeout: 60_000 }).toBe(200);
  expect((await request.put(url, { data: "# Initial shared note", headers })).ok()).toBe(true);
  const second = await context.newPage();
  try {
    await openEditor(page);
    await openEditor(second);
    await page.getByTestId("file-editor").fill("# Written in the first tab");
    await expect.poll(async () => (await request.get(url)).text()).toBe("# Written in the first tab");
    await expect(second.getByTestId("file-editor")).toHaveValue("# Written in the first tab");
    await second.getByTestId("file-editor").fill("# Written in the second tab");
    await expect.poll(async () => (await request.get(url)).text()).toBe("# Written in the second tab");
    await expect(page.getByTestId("file-editor")).toHaveValue("# Written in the second tab");
    expect((await request.delete(url)).ok()).toBe(true);
    await expect.poll(async () => (await request.get(url)).status()).toBe(404);
    for (const tab of [page, second]) {
      await expect(tab.getByRole("treeitem", { name: /multi-tab\.md/ })).toHaveCount(0);
      await expect(tab.getByRole("tab", { name: /multi-tab\.md/ })).toHaveCount(0);
    }
  } finally {
    await second.close();
    await request.delete(url);
  }
});
