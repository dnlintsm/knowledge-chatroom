import { test, expect, type Page } from "@playwright/test";
import type { Role, ServerEvent, ServerFile } from "../src/components/workspace/server-files";

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
      sha256: (++revision).toString(16).padStart(64, "0"), updatedAt: new Date().toISOString(), author: "user", readOnly: false,
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
    rootRole: "owner" as Role,
    listUnavailable: false,
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
      types: [{ name: "tech", depth: 1 }], rootRole: transport.rootRole,
      nodes: [{ id: otherNode, parentId: null, type: "tech", depth: 1, name: "Other",
        fileCount: 1, updatedAt: new Date().toISOString(), role: "owner" }],
    } });
    if (url.pathname === "/api/files") {
      transport.reads++;
      if (transport.listUnavailable) return route.fulfill({ status: 503, json: { error: "Storage unavailable" } });
      return route.fulfill({ json: { files: [...files].filter(([key]) => key.startsWith(`${node}\n`)).map(([, file]) => file.info) } });
    }
    const path = decodeURIComponent(url.pathname.slice("/api/files/".length));
    if (route.request().method() === "PUT") {
      const content = route.request().postData() ?? "";
      writes.push(content);
      await transport.beforeWrite(content);
      if (transport.rootRole === "viewer") return route.fulfill({ status: 403, json: { error: "Permission revoked" } });
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
  // The current workbench starts in Traverse; choose the file view explicitly.
  await page.getByRole("button", { name: "Files", exact: true }).click();
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

async function reconnect(page: Page) {
  const response = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/files");
  await page.evaluate(() => window.dispatchEvent(new Event("test-storage-reconnect")));
  await (await response).finished();
}

test("storage outage and reconnect preserve a failed draft until a new edit saves", async ({ page }) => {
  const backend = await storage(page);
  backend.transport.failWrite = true;
  await page.getByTestId("file-editor").fill("# My offline draft");
  await expect(page.getByRole("status").filter({ hasText: "Not saved" })).toBeVisible();
  backend.transport.listUnavailable = true;
  await reconnect(page);
  await expect(page.getByTestId("file-editor")).toHaveValue("# My offline draft");
  backend.transport.listUnavailable = false;
  backend.put("# Remote while offline");
  backend.put("# Reconnect marker", "", "notes/reconnected.md");
  await reconnect(page);
  // A new file appears only after the entire reconnect resync has committed.
  await expect(page.getByRole("treeitem", { name: /reconnected\.md/ })).toBeVisible();
  await expect(page.getByTestId("file-editor")).toHaveValue("# My offline draft");
  await expect(page.getByRole("status").filter({ hasText: "Not saved" })).toBeVisible();
  backend.transport.failWrite = false;
  await page.getByTestId("file-editor").fill("# Recovered draft");
  await expect.poll(() => backend.files.get(`\n${PATH}`)?.content).toBe("# Recovered draft");
  await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible();
});

test("permission revoked during a save keeps the failed draft through reconnect", async ({ page }) => {
  const backend = await storage(page);
  const held = gate();
  backend.transport.beforeWrite = async () => held.ready;
  try {
    await page.getByTestId("file-editor").fill("# Draft before revocation");
    await expect.poll(() => backend.writes.length).toBe(1);
    backend.transport.rootRole = "viewer";
    await event(page, { op: "node", change: "rename", id: otherNode });
    await expect(page.getByTestId("file-editor")).toHaveAttribute("readonly", "");
    held.release();
    await expect(page.getByRole("status").filter({ hasText: "Not saved" })).toBeVisible();
    expect(backend.files.get(`\n${PATH}`)?.content).toBe("# Original");
    backend.put("# Updated by another editor");
    backend.put("# Reconnect marker", "", "notes/reconnected.md");
    await reconnect(page);
    await expect(page.getByRole("treeitem", { name: /reconnected\.md/ })).toBeVisible();
    await expect(page.getByTestId("file-editor")).toHaveValue("# Draft before revocation");
    backend.transport.rootRole = "owner";
    backend.transport.beforeWrite = async () => {};
    await event(page, { op: "node", change: "rename", id: otherNode });
    await expect(page.getByTestId("file-editor")).not.toHaveAttribute("readonly", "");
    await page.getByTestId("file-editor").fill("# Draft after access restored");
    await expect.poll(() => backend.files.get(`\n${PATH}`)?.content).toBe("# Draft after access restored");
    await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible();
  } finally { held.release(); }
});

test("saving another file does not clear a failed file's error or draft", async ({ page }) => {
  const backend = await storage(page);
  backend.transport.failWrite = true;
  await page.getByTestId("file-editor").fill("# Unsaved first file");
  await expect(page.getByRole("status").filter({ hasText: "Not saved" })).toBeVisible();
  backend.transport.failWrite = false;
  const info = backend.put("# Second file", "", "notes/second.md");
  await event(page, { op: "write", node: null, path: info.path, sha256: info.sha256 });
  await page.getByRole("treeitem", { name: /second\.md/ }).click();
  await page.getByRole("button", { name: "edit", exact: true }).click();
  await page.getByTestId("file-editor").fill("# Saved second file");
  await expect.poll(() => backend.files.get("\nnotes/second.md")?.content).toBe("# Saved second file");
  await expect(page.getByRole("status").filter({ hasText: "Not saved" })).toBeVisible();
  await page.getByRole("tab", { name: /sync\.md/ }).click();
  await expect(page.getByTestId("file-editor")).toHaveValue("# Unsaved first file");
  await page.getByTestId("file-editor").fill("# Saved first file");
  await expect.poll(() => backend.files.get(`\n${PATH}`)?.content).toBe("# Saved first file");
  await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible();
});
