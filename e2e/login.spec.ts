import { test, expect, type Browser, type Page } from "@playwright/test";

/**
 * Login and sharing. Runs only with AUTH_SECRET and server storage set
 * (playwright.config.ts then starts e2e/mock-oidc.mjs as the login provider):
 *
 *   AUTH_SECRET=$(openssl rand -hex 32) npx playwright test
 *
 * Needs a database nobody has signed in to yet, since the first person to
 * sign in becomes the workspace owner. Screenshots continue the numbering of
 * knowledge.spec.ts.
 */
const SCREENSHOT_DIR = "preview/screenshots";

async function shot(page: Page, name: string) {
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${SCREENSHOT_DIR}/${name}.png` });
}

test.skip(
  !process.env.AUTH_SECRET || !process.env.DATABASE_URL,
  "Needs login (AUTH_SECRET) and server storage (DATABASE_URL).",
);

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
  await alice.getByRole("button", { name: "Files", exact: true }).click();
  await alice.getByRole("button", { name: "New note" }).click();
  await alice.getByTestId("file-editor").fill("# Overlay\n\nAlignment marks moved to the scribe line.");
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
  await bob.getByRole("button", { name: "Files", exact: true }).click();
  await bob.getByRole("treeitem", { name: /untitled-1\.md/ }).click();
  await expect(bob.getByTestId("file-preview")).toContainText("Alignment marks moved");
  await expect(bob.getByText("Read only")).toBeVisible();
  await expect(bob.getByRole("button", { name: "New note" })).toHaveCount(0);
  await expect(bob.getByRole("button", { name: "Upload files" })).toHaveCount(0);
  await bob.mouse.move(600, 500);
  await shot(bob, "17-read-only-viewer");

  // Signing out ends the session.
  await bob.getByRole("button", { name: "Account" }).click();
  await bob.getByRole("button", { name: "Sign out" }).click();
  await expect(bob.getByText("You're signed out.")).toBeVisible();
  expect((await bob.request.get("/api/files")).status()).toBe(401);

  await alice.context().close();
  await bob.context().close();
});
