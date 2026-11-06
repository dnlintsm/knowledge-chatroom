import { test, expect, type Browser, type Page } from "@playwright/test";
import { expectStoredNote } from "./storage-assertions";

/** Shows the Files view; clicking it while it is already shown would fold the sidebar away. */
async function showFiles(page: Page) {
  const files = page.getByRole("button", { name: "Files", exact: true });
  if ((await files.getAttribute("aria-pressed")) !== "true") await files.click();
}

/**
 * Login and sharing: npm run test:e2e:login.
 * The config supplies the test OIDC provider and public signing key.
 * Use a fresh disposable database: the first sign-in becomes its owner.
 */
const SCREENSHOT_DIR = "preview/screenshots";

async function shot(page: Page, name: string) {
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${SCREENSHOT_DIR}/${name}.png` });
}

const TECH = "Lithography";

/** A browser of its own for one person, signed in through the test provider. */
async function signIn(browser: Browser, who: "Alice Admin" | "Bob Builder") {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    recordVideo: { dir: test.info().outputPath("videos"), size: { width: 1440, height: 900 } },
  });
  const page = await context.newPage();
  await page.goto("/");
  // Not signed in: the app sends the browser to the login provider.
  await page.getByRole("button", { name: `Sign in as ${who}` }).click();
  await expect(page.getByRole("button", { name: "Account" })).toContainText(who);
  await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible();
  return page;
}

test("login, sharing and read-only access", async ({ browser, request }) => {
  // Without a session the API refuses, rather than acting as anyone.
  expect((await request.get("/api/files")).status()).toBe(401);

  // Alice signs in first, so she owns the workspace.
  const alice = await signIn(browser, "Alice Admin");
  await alice.getByRole("button", { name: "Knowledge", exact: true }).click();
  const aliceTree = alice.getByRole("tree", { name: "Knowledge tree" });
  await aliceTree.getByRole("button", { name: /^New / }).click();
  await alice.getByPlaceholder(/^New .* name$/).fill(TECH);
  await alice.keyboard.press("Enter");
  await aliceTree.getByTestId("knowledge-node").filter({ hasText: TECH }).click();
  await expect(alice.getByRole("navigation", { name: "Location" })).toContainText(TECH);
  await showFiles(alice);
  await alice.getByRole("button", { name: "New note" }).click();
  await alice.getByTestId("file-editor").fill("# Overlay\n\nAlignment marks moved to the scribe line.");
  await expectStoredNote(alice, TECH, "# Overlay\n\nAlignment marks moved to the scribe line.");
  await expect(alice.getByRole("status").filter({ hasText: "Saved" })).toBeVisible();

  // Bob signs in: nothing is shared with him yet.
  const bob = await signIn(browser, "Bob Builder");
  await bob.getByRole("button", { name: "Knowledge", exact: true }).click();
  await expect(bob.getByRole("tree", { name: "Knowledge tree" })).toContainText(
    "Nothing in the knowledge tree is shared with you yet.",
  );
  await expect(bob.getByRole("button", { name: "Share", exact: true })).toHaveCount(0);

  // Alice shares the tech with Bob, read only.
  await alice.getByRole("button", { name: "Share", exact: true }).click();
  const dialog = alice.getByRole("dialog", { name: `Share ${TECH}` });
  await dialog.getByLabel("Person or group").selectOption({ label: "Bob Builder" });
  await dialog.getByLabel("Role to give").selectOption("viewer");
  await dialog.getByRole("button", { name: "Share", exact: true }).click();
  await expect(dialog.getByRole("list", { name: "People with access" })).toContainText("Bob Builder");
  await shot(alice, "16-share-dialog");
  await dialog.getByRole("button", { name: "Close" }).click();

  // Bob now sees it, can read the note, and gets no editing controls.
  await bob.reload();
  await bob.getByRole("button", { name: "Knowledge", exact: true }).click();
  const bobTree = bob.getByRole("tree", { name: "Knowledge tree" });
  await bobTree.getByTestId("knowledge-node").filter({ hasText: TECH }).click();
  await showFiles(bob);
  await bob.getByRole("treeitem", { name: /untitled-1\.md/ }).click();
  await expect(bob.getByTestId("file-preview")).toContainText("Alignment marks moved");
  await expect(bob.getByText("Read only")).toBeVisible();
  await expect(bob.getByRole("button", { name: "New note" })).toHaveCount(0);
  await expect(bob.getByRole("button", { name: "Upload files" })).toHaveCount(0);
  await bob.mouse.move(600, 500);
  await shot(bob, "17-read-only-viewer");

  // Actions follow the role where the run lives (#13): Alice adds a run to the
  // tech; Bob, a viewer there, can open it and start a chat but not generate
  // its rules, while Alice, the owner, can.
  const { nodes } = (await (await alice.request.get("/api/nodes")).json()) as {
    nodes: { id: string; name: string }[];
  };
  const techId = nodes.find((n) => n.name === TECH)!.id;
  const created = await alice.request.post("/api/experiments", { data: { nodeId: techId, title: "r1" } });
  expect(created.ok()).toBe(true);
  const run = (await created.json()) as { id: string };
  // A run is private to its author until shared.
  expect((await alice.request.patch(`/api/experiments/${run.id}`, { data: { status: "shared" } })).ok()).toBe(true);
  const report = await alice.request.put(`/api/files/report.md?experiment=${run.id}`, {
    headers: { "Content-Type": "text/markdown" },
    data: "# xDOE report\n\nOverlay run.",
  });
  expect(report.status()).toBe(200);
  for (const [who, page, canGenerate] of [
    ["Bob", bob, false],
    ["Alice", alice, true],
  ] as const) {
    await page.goto(`/?experiment=${run.id}`);
    await expect(page.getByRole("navigation", { name: "Location" }), who).toContainText("r1");
    await expect(page.getByTestId("file-preview"), who).toContainText("Overlay run.");
    await showFiles(page);
    const actions = page.getByTestId("actions");
    await expect(actions.getByRole("button", { name: "New Chat" }), who).toBeEnabled();
    const generate = actions.getByRole("button", { name: "Generate Rules" });
    if (canGenerate) {
      await expect(generate, who).toBeEnabled();
    } else {
      await expect(generate, who).toBeDisabled();
      await expect(generate, who).toHaveAttribute("title", "Needs the editor role here (you are a viewer)");
    }
  }
  await bob.mouse.move(600, 500);
  await shot(bob, "18-actions-by-role");

  // Admin panel (#67): only workspace owners get it. Alice puts Bob in a
  // group, sees the change logged, and makes him a workspace editor.
  await expect(bob.getByRole("button", { name: "Admin", exact: true })).toHaveCount(0);
  await alice.goto("/");
  await alice.getByRole("button", { name: "Admin", exact: true }).click();
  const admin = alice.getByRole("dialog", { name: "Admin" });
  await expect(admin.getByRole("tab", { name: "People (2)" })).toBeVisible();
  const peopleTable = admin.getByRole("table", { name: "People" });
  await expect(peopleTable).toContainText("Alice Admin");
  await expect(peopleTable).toContainText("(you)");
  await expect(admin.getByLabel("Workspace role for Bob Builder")).toHaveValue("");

  await admin.getByRole("tab", { name: /^Groups/ }).click();
  await admin.getByLabel("New group name").fill("Fab");
  await admin.getByRole("button", { name: "Create group" }).click();
  await expect(admin.getByRole("list", { name: "Groups" })).toContainText("Fab");
  await admin.getByLabel("New group name").fill("Litho team");
  await admin.getByLabel("Inside").selectOption({ label: "Fab" });
  await admin.getByRole("button", { name: "Create group" }).click();
  const litho = admin.getByRole("listitem", { name: "Litho team" });
  await litho.getByLabel("Add a member to Litho team").selectOption({ label: "Bob Builder" });
  await expect(litho).toContainText("1 member");
  await expect(litho.getByRole("button", { name: "Remove Bob Builder from Litho team" })).toBeVisible();
  await shot(alice, "19-admin-groups");

  await admin.getByRole("tab", { name: /^People/ }).click();
  await admin.getByLabel("Workspace role for Bob Builder").selectOption("editor");
  await expect(admin.getByLabel("Workspace role for Bob Builder")).toHaveValue("editor");
  await expect(peopleTable).toContainText("Litho team");
  await shot(alice, "20-admin-people");

  await admin.getByRole("tab", { name: "Activity" }).click();
  const changes = admin.getByRole("list", { name: "Access changes" });
  await expect(changes).toContainText("added Bob Builder to Litho team");
  await expect(changes).toContainText("gave Bob Builder edit access to the workspace");
  await shot(alice, "21-admin-activity");
  await admin.getByRole("button", { name: "Close" }).click();

  // The workspace role reaches Bob on his next request.
  await bob.goto("/");
  // He comes back to the run he was last in, which he only reads; the new
  // role is for the workspace itself.
  await expect(bob.getByRole("navigation", { name: "Location" })).toContainText("r1");
  await bob.getByRole("navigation", { name: "Location" }).getByRole("button", { name: "Workspace" }).click();
  await showFiles(bob);
  await expect(bob.getByRole("button", { name: "New note" })).toBeVisible();

  // Alice hands ownership to Bob and steps down to editor: the app reloads
  // with her new access, so the Admin button goes away.
  await alice.getByRole("button", { name: "Admin", exact: true }).click();
  await admin.getByLabel("Workspace role for Bob Builder").selectOption("owner");
  await expect(admin.getByLabel("Workspace role for Bob Builder")).toHaveValue("owner");
  alice.once("dialog", (d) => void d.accept());
  await admin.getByLabel("Workspace role for Alice Admin").selectOption("editor");
  await expect(alice.getByRole("button", { name: "Account" })).toBeVisible();
  await expect(alice.getByRole("button", { name: "Admin", exact: true })).toHaveCount(0);

  // Signing out ends the session.
  await bob.getByRole("button", { name: "Account" }).click();
  await bob.getByRole("button", { name: "Sign out" }).click();
  await expect(bob.getByText("You're signed out.")).toBeVisible();
  expect((await bob.request.get("/api/files")).status()).toBe(401);

  await alice.context().close();
  await bob.context().close();
});
