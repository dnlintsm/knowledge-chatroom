import { expect, type Page } from "@playwright/test";

/** Wait for bytes on the real server, rather than an optimistic UI status. */
export async function expectStoredNote(page: Page, nodeName: string, content: string) {
  const response = await page.request.get("/api/nodes");
  expect(response.ok()).toBe(true);
  const { nodes } = await response.json();
  const node = nodes.find((item: { name: string }) => item.name === nodeName);
  expect(node).toBeTruthy();
  await expect.poll(async () => {
    const saved = await page.request.get(`/api/files/notes/untitled-1.md?node=${encodeURIComponent(node.id)}`);
    return saved.ok() ? saved.text() : `HTTP ${saved.status()}`;
  }).toBe(content);
}
