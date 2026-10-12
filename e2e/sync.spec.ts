import { test, expect, type Page } from "@playwright/test";
import type { ServerEvent, ServerFile } from "../src/components/workspace/server-files";

const PATH = "notes/sync.md";
const otherNode = "other-node";

function gate() {
  let release!: () => void;
  const ready = new Promise<void>((resolve) => { release = resolve; });
  return { ready, release };
}

// Exercise the real provider/UI against controlled transport failures and delays.
// No database or timing-dependent external SSE connection is needed.
async function storage(page: Page) {
  const files = new Map<string, { info: ServerFile; content: string }>();
  let revision = 0;
  const put = (content: string, node = "", path = PATH) => {
    const info: ServerFile = {
      path, kind: "note", mime: "text/markdown", size: content.length,
      sha256: String(++revision), updatedAt: new Date().toISOString(), author: "user",
    };
    files.set(`${node}\n${path}`, { info, content });
    return info;
  };
  put("# Original");
  put("# Other place", otherNode);
  const writes: string[] = [];
  const transport = {
    beforeWrite: async (_content: string) => {},
    beforeRead: async () => {},
    failWrite: false,
    reads: 0,
  };
  await page.addInitScript(() => {
    class ControlledEvents {
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: (() => void) | null = null;
      onopen: (() => void) | null = null;
      message = (event: Event) => this.onmessage?.(new MessageEvent("message", {
        data: JSON.stringify((event as CustomEvent).detail),
      }));
      reconnect = () => { this.onerror?.(); this.onopen?.(); };
      constructor() {
        window.addEventListener("test-storage-message", this.message);
        window.addEventListener("test-storage-reconnect", this.reconnect);
      }
      close() {
        window.removeEventListener("test-storage-message", this.message);
        window.removeEventListener("test-storage-reconnect", this.reconnect);
      }
    }
    Object.defineProperty(window, "EventSource", { value: ControlledEvents });
  });
  await page.route(/\/api\/(files|nodes|experiments|auth\/me)([/?]|$)/, async (route) => {
    const url = new URL(route.request().url());
    const node = url.searchParams.get("node") ?? "";
    if (url.pathname === "/api/auth/me") return route.fulfill({ json: { login: false, user: null } });
    if (url.pathname === "/api/experiments") return route.fulfill({ json: { experiments: [] } });
    if (url.pathname === "/api/nodes") return route.fulfill({ json: {
      types: [{ name: "tech", depth: 1 }], rootRole: "owner",
      nodes: [{ id: otherNode, parentId: null, type: "tech", depth: 1, name: "Other",
        fileCount: 1, updatedAt: new Date().toISOString(), role: "owner" }],
    } });
    if (url.pathname === "/api/files") {
      transport.reads++;
      return route.fulfill({ json: { files: [...files].filter(([key]) => key.startsWith(`${node}\n`)).map(([, file]) => file.info) } });
    }
    const path = decodeURIComponent(url.pathname.slice("/api/files/".length));
    if (route.request().method() === "PUT") {
      const content = route.request().postData() ?? "";
      writes.push(content);
      await transport.beforeWrite(content);
      if (transport.failWrite) return route.fulfill({ status: 500, json: { error: "Controlled write failure" } });
      return route.fulfill({ json: put(content, node, path) });
    }
    // Capture before delaying, so this response can really become stale.
    const file = files.get(`${node}\n${path}`);
    await transport.beforeRead();
    return route.fulfill({ status: file ? 200 : 404, body: file?.content ?? "", contentType: "text/markdown" });
  });
  await page.goto("/");
  await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible();
  await page.getByRole("treeitem", { name: /sync\.md/ }).click();
  await expect(page.getByTestId("file-preview")).toContainText("Original");
  await page.getByRole("button", { name: "edit", exact: true }).click();
  return { files, put, writes, transport };
}

async function event(page: Page, change: ServerEvent) {
  await page.evaluate((detail) => window.dispatchEvent(new CustomEvent("test-storage-message", { detail })), change);
}

test("overlapping saves remain ordered when leaving a place", async ({ page }) => {
  const backend = await storage(page);
  const first = gate();
  backend.transport.beforeWrite = async (content) => { if (content === "# First") await first.ready; };
  const firstResponse = page.waitForResponse((response) =>
    response.request().method() === "PUT" && response.request().postData() === "# First");
  try {
    await page.getByTestId("file-editor").fill("# First");
    await expect.poll(() => backend.writes).toEqual(["# First"]);
    await page.getByTestId("file-editor").fill("# Latest");
    await page.getByRole("button", { name: "Knowledge", exact: true }).click();
    await page.getByTestId("knowledge-node").filter({ hasText: "Other" }).click();
    await expect(page.getByRole("navigation", { name: "Location" })).toContainText("Other");
    first.release();
    await (await firstResponse).finished();
    await expect.poll(() => backend.files.get(`\n${PATH}`)?.content).toBe("# Latest");
    expect(backend.files.get(`${otherNode}\n${PATH}`)?.content).toBe("# Other place");
  } finally { first.release(); }
});

test("failed writes retain local edits and recover on the next edit", async ({ page }) => {
  const backend = await storage(page);
  backend.transport.failWrite = true;
  await page.getByTestId("file-editor").fill("# Keep this edit");
  await expect(page.getByRole("status").filter({ hasText: "Not saved" })).toBeVisible();
  await expect(page.getByTestId("file-editor")).toHaveValue("# Keep this edit");
  expect(backend.files.get(`\n${PATH}`)?.content).toBe("# Original");
  backend.transport.failWrite = false;
  await page.getByTestId("file-editor").fill("# Recovered");
  await expect.poll(() => backend.files.get(`\n${PATH}`)?.content).toBe("# Recovered");
  await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible();
});

test("a delayed remote update cannot overwrite an edit made while loading", async ({ page }) => {
  const backend = await storage(page);
  const read = gate();
  let loading = false;
  backend.transport.beforeRead = async () => { loading = true; await read.ready; };
  try {
    const info = backend.put("# Remote");
    await event(page, { op: "write", node: null, path: PATH, sha256: info.sha256, author: "user" });
    await expect.poll(() => loading).toBe(true);
    await page.getByTestId("file-editor").fill("# My newer edit");
    read.release();
    await expect.poll(() => backend.files.get(`\n${PATH}`)?.content).toBe("# My newer edit");
    await expect(page.getByTestId("file-editor")).toHaveValue("# My newer edit");
  } finally { read.release(); }
});

test("SSE reconnect catches up on a deletion missed while disconnected", async ({ page }) => {
  const backend = await storage(page);
  backend.files.delete(`\n${PATH}`);
  const before = backend.transport.reads;
  await page.evaluate(() => window.dispatchEvent(new Event("test-storage-reconnect")));
  await expect.poll(() => backend.transport.reads).toBeGreaterThan(before);
  await expect(page.getByRole("treeitem", { name: /sync\.md/ })).toHaveCount(0);
  await expect(page.getByRole("tab", { name: /sync\.md/ })).toHaveCount(0);
});

test("a remote response from the previous place cannot replace the current file", async ({ page }) => {
  const backend = await storage(page);
  const read = gate();
  let loading = false;
  backend.transport.beforeRead = async () => { loading = true; await read.ready; };
  const oldResponse = page.waitForResponse((response) =>
    response.url().endsWith(`/api/files/${PATH}`) && response.request().method() === "GET");
  try {
    const info = backend.put("# Old place remote update");
    await event(page, { op: "write", node: null, path: PATH, sha256: info.sha256 });
    await expect.poll(() => loading).toBe(true);
    backend.transport.beforeRead = async () => {};
    await page.getByRole("button", { name: "Knowledge", exact: true }).click();
    await page.getByTestId("knowledge-node").filter({ hasText: "Other" }).click();
    await expect(page.getByRole("navigation", { name: "Location" })).toContainText("Other");
    await page.getByRole("button", { name: "Files", exact: true }).click();
    await page.getByRole("treeitem", { name: /sync\.md/ }).click();
    read.release();
    await (await oldResponse).finished();
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    await expect(page.getByTestId("file-editor")).toHaveValue("# Other place");
  } finally { read.release(); }
});
