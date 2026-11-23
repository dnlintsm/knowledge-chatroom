import { test, expect, type Browser, type Page } from "@playwright/test";
import { expectStoredNote } from "./storage-assertions";
import { showPlaces } from "./places";

/** Shows the Files view; clicking it while it is already shown would fold the sidebar away. */
async function showFiles(page: Page) {
  const files = page.getByRole("button", { name: "Files", exact: true });
  if ((await files.getAttribute("aria-pressed")) !== "true") await files.click();
}

/**
 * Login and sharing: pnpm test:e2e:login.
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
  await showPlaces(alice);
  const aliceTree = alice.getByRole("tree", { name: "Knowledge tree" });
  await aliceTree.getByRole("button", { name: /^New / }).click();
  await alice.getByPlaceholder(/^New .* name$/).fill(TECH);
  await alice.keyboard.press("Enter");
  await aliceTree.getByTestId("knowledge-node").filter({ hasText: TECH }).click();
  await expect(alice.getByRole("navigation", { name: "Location" })).toContainText(TECH);
  await showFiles(alice);
  await alice.getByRole("button", { name: "New file", exact: true }).click();
  await alice.getByRole("textbox", { name: "New file path" }).press("Enter");
  await alice.getByTestId("file-editor").fill("# Overlay\n\nAlignment marks moved to the scribe line.");
  await expectStoredNote(alice, TECH, "# Overlay\n\nAlignment marks moved to the scribe line.");
  await expect(alice.getByRole("status").filter({ hasText: "Saved" })).toBeVisible();

  // Bob signs in: nothing is shared with him yet.
  const bob = await signIn(browser, "Bob Builder");
  await showPlaces(bob);
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
  await showPlaces(bob);
  const bobTree = bob.getByRole("tree", { name: "Knowledge tree" });
  await bobTree.getByTestId("knowledge-node").filter({ hasText: TECH }).click();
  await showFiles(bob);
  await bob.getByRole("treeitem", { name: /untitled-1\.md/ }).click();
  await expect(bob.getByTestId("file-preview")).toContainText("Alignment marks moved");
  // The badge says why (#187), without naming who could grant more.
  await expect(bob.getByTestId("read-only-badge")).toHaveText("Read only · view access");
  await expect(bob.getByRole("button", { name: "New file", exact: true })).toHaveCount(0);
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
    await page.goto(`/?experiment_id=${run.id}`);
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

  // Once Alice has generated the rules, Bob can open them, but only read them:
  // his role in the run decides, as for any of its files.
  await alice.getByTestId("actions").getByRole("button", { name: "Generate Rules" }).click();
  await expect(alice.getByTestId("file-preview")).toContainText("General rules: r1");
  await bob.reload();
  await showFiles(bob);
  await bob.getByTestId("actions").getByRole("button", { name: "Open Rules" }).click();
  await expect(bob.getByTestId("file-preview")).toContainText("General rules: r1");
  await expect(bob.getByTestId("read-only-badge")).toHaveText("Read only · only Alice Admin can edit");
  const bobRules = bob.getByRole("treeitem", { name: /general_rules\.md/ });
  await expect(bobRules.getByRole("button", { name: /Delete|Rename/ })).toHaveCount(0);
  const rulesUrl = `/api/files/models/general_rules.md?experiment=${run.id}`;
  expect((await bob.request.put(rulesUrl, { headers: { "Content-Type": "text/markdown" }, data: "# Bob's rules" })).status()).toBe(403);
  expect((await bob.request.delete(rulesUrl)).status()).toBe(403);
  expect((await alice.request.get(rulesUrl)).ok()).toBe(true);

  // The experiment says why Bob can't change it and offers the step he can
  // take (#187): rerun it as his own. Restore is Alice's alone.
  await bob.getByRole("navigation", { name: "Location" }).getByRole("button", { name: "r1" }).click();
  const bobPanel = bob.getByTestId("experiment-panel");
  await expect(bobPanel.getByTestId("read-only-reason")).toHaveText(
    "Only Alice Admin can edit this experiment. Rerun it to work on your own copy.",
  );
  await expect(bobPanel.getByRole("button", { name: "Restore" })).toHaveCount(0);
  await bobPanel.getByRole("button", { name: "Rerun as your own" }).click();
  await expect(bob.getByRole("navigation", { name: "Location" })).toContainText("r1 (rerun)");
  // The new experiment opens on its report, like any other; its panel says it's his.
  await bob.getByRole("navigation", { name: "Location" }).getByRole("button", { name: "r1 (rerun)" }).click();
  await expect(bob.getByTestId("experiment-panel")).toContainText("Only you can see this draft.");
  await expect(bob.getByTestId("experiment-panel").getByTestId("read-only-reason")).toHaveCount(0);

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
  await expect(admin.getByLabel("Access to the workspace for Bob Builder")).toHaveValue("");

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
  await admin.getByLabel("Access to the workspace for Bob Builder").selectOption("editor");
  await expect(admin.getByLabel("Access to the workspace for Bob Builder")).toHaveValue("editor");
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
  await bob.getByRole("navigation", { name: "Location" }).getByRole("button", { name: "My workspace", exact: true }).click();
  await showFiles(bob);
  await expect(bob.getByRole("button", { name: "New file", exact: true })).toBeVisible();

  // Alice gives Bob Full access and steps down to Can edit. She stays the
  // workspace's Owner (issue #226), which is what the Admin panel needs.
  await alice.getByRole("button", { name: "Admin", exact: true }).click();
  await admin.getByLabel("Access to the workspace for Bob Builder").selectOption("owner");
  await expect(admin.getByLabel("Access to the workspace for Bob Builder")).toHaveValue("owner");
  alice.once("dialog", (d) => void d.accept());
  await admin.getByLabel("Access to the workspace for Alice Admin").selectOption("editor");
  await expect(admin.getByLabel("Access to the workspace for Alice Admin")).toHaveValue("editor");
  await expect(admin.getByLabel("Access to the workspace for Bob Builder").locator("option:checked")).toHaveText("Full access");
  await expect(admin.getByRole("table", { name: "People" })).toContainText("Owner");
  await admin.getByRole("button", { name: "Close" }).click();
  await expect(bob.getByRole("button", { name: "Admin", exact: true })).toHaveCount(0);

  // A workspace of her own (docs/workspaces.md, "Screens"): Alice creates it
  // from the switcher and lands there; Bob can't open it until she adds him.
  const lab = `Lab ${Date.now()}`;
  await alice.getByRole("button", { name: "Switch workspace" }).click();
  await alice.getByRole("menuitem", { name: "Create workspace" }).click();
  const create = alice.getByRole("dialog", { name: "Create a workspace" });
  await create.getByLabel("Name").fill(lab);
  await expect(create.getByLabel("Address")).toHaveValue(/^lab-\d+$/);
  await create.getByLabel("Address").fill(`the-${lab.toLowerCase().replace(" ", "-")}`);
  await create.getByRole("button", { name: "Create workspace" }).click();
  await expect(alice).toHaveURL(new RegExp(`/w/the-lab-\\d+$`));
  const labUrl = new URL(alice.url()).pathname;
  await expect(alice.getByRole("navigation", { name: "Location" }).getByRole("button", { name: lab, exact: true })).toBeVisible();

  // She shares an experiment there by its link (the milestone of #226).
  const labWs = ((await (await alice.request.get("/api/workspaces")).json()).workspaces as { id: string; slug: string }[]).find(
    (w) => labUrl === `/w/${w.slug}`,
  )!;
  const inLab = { "X-Knowledge-Workspace": labWs.id };
  const finding = (await (
    await alice.request.post("/api/experiments", { headers: inLab, data: { nodeId: null, title: "Lab finding" } })
  ).json()) as { id: string };
  expect((await alice.request.patch(`/api/experiments/${finding.id}`, { headers: inLab, data: { status: "shared" } })).ok()).toBe(true);
  const findingUrl = `${labUrl}?experiment_id=${finding.id}`;
  await alice.goto(findingUrl);
  await expect(alice.getByRole("navigation", { name: "Location" })).toContainText("Lab finding");
  // In the default workspace there is no such experiment.
  expect((await alice.request.get(`/api/experiments/${finding.id}`)).status()).toBe(404);

  // Bob isn't a member yet: the link opens the no-access page, which names nothing.
  await bob.goto(findingUrl);
  await expect(bob.getByTestId("workspace-no-access")).toBeVisible();
  await expect(bob.getByTestId("workspace-no-access")).not.toContainText(lab);
  await expect(bob.getByTestId("workspace-no-access")).not.toContainText("Lab finding");

  await alice.getByRole("button", { name: "Admin", exact: true }).click();
  const add = admin.getByRole("form", { name: "Add a member" });
  await add.getByLabel("Email").fill("nobody@example.com");
  await add.getByRole("button", { name: "Add" }).click();
  await expect(add.getByRole("alert")).toContainText("has signed in yet");
  await add.getByLabel("Email").fill("BOB@example.com");
  await add.getByLabel("Starting access").selectOption("editor");
  await add.getByRole("button", { name: "Add" }).click();
  await expect(add.getByRole("status")).toContainText("Added Bob Builder as Member");
  await expect(admin.getByLabel("Access to the workspace for Bob Builder")).toHaveValue("editor");
  await add.getByLabel("Email").fill("bob@example.com");
  await add.getByLabel("Role").selectOption("admin");
  await add.getByRole("button", { name: "Add" }).click();
  await expect(add.getByRole("alert")).toContainText("already in this workspace, as Member");
  await shot(alice, "22-admin-add-member");
  await admin.getByRole("button", { name: "Close" }).click();

  // Now he can, from the switcher too.
  await bob.goto("/");
  await expect(bob.getByRole("status").filter({ hasText: "Saved" })).toBeVisible();
  await bob.getByRole("button", { name: "Switch workspace" }).click();
  await bob.getByRole("menu", { name: "Workspaces" }).getByRole("menuitem", { name: new RegExp(lab) }).click();
  await expect(bob).toHaveURL(new RegExp(`${labUrl}$`));
  await expect(bob.getByRole("navigation", { name: "Location" }).getByRole("button", { name: lab, exact: true })).toBeVisible();
  // And Alice's link opens her experiment there.
  await bob.goto(findingUrl);
  const bobLocation = bob.getByRole("navigation", { name: "Location" });
  await expect(bobLocation.getByRole("button", { name: lab, exact: true })).toBeVisible();
  await expect(bobLocation).toContainText("Lab finding");

  // Administration (issue #255): Alice makes Bob an Admin, then hands the lab
  // over to him and becomes an Admin herself.
  await alice.getByRole("button", { name: "Admin", exact: true }).click();
  await admin.getByLabel("Role of Bob Builder").selectOption("admin");
  await expect(admin.getByLabel("Role of Bob Builder")).toHaveValue("admin");
  await admin.getByLabel("Role of Bob Builder").selectOption("owner");
  const transfer = alice.getByRole("dialog", { name: "Make Bob Builder an Owner" });
  await transfer.getByLabel("Become an Admin").check();
  await expect(transfer.getByLabel(/Give them Full access/)).toBeChecked();
  await shot(alice, "30-admin-transfer");
  const reloaded = alice.waitForEvent("load");
  await transfer.getByRole("button", { name: "Make Owner" }).click();
  // Her own role changed, so the page loads again.
  await reloaded;
  await expect(alice.getByRole("status").filter({ hasText: "Saved" })).toBeVisible();
  await alice.getByRole("button", { name: "Admin", exact: true }).click();
  await expect(admin.getByLabel("Role of Alice Admin")).toHaveValue("admin");
  // An Admin doesn't change an Owner's role.
  await expect(admin.getByLabel("Role of Bob Builder")).toHaveCount(0);
  await expect(admin.getByLabel("Access to the workspace for Bob Builder")).toHaveValue("owner");
  await admin.getByRole("tab", { name: "Activity" }).click();
  await expect(changes).toContainText("made Bob Builder Owner (was Admin)");
  await expect(changes).toContainText("made Alice Admin Admin (was Owner)");
  await admin.getByRole("button", { name: "Close" }).click();

  // Bob, now its Owner, removes Alice after seeing what goes, then adds her back.
  await bob.goto(labUrl);
  await expect(bob.getByRole("status").filter({ hasText: "Saved" })).toBeVisible();
  await bob.getByRole("button", { name: "Admin", exact: true }).click();
  const bobAdmin = bob.getByRole("dialog", { name: "Admin" });
  await bobAdmin.getByRole("button", { name: "Remove Alice Admin" }).click();
  const removal = bob.getByRole("dialog", { name: "Remove Alice Admin?" });
  await expect(removal.getByLabel("What goes")).toContainText("1 direct access they were given");
  await expect(removal.getByRole("list", { name: "Experiments they maintain" })).toContainText("Lab finding");
  await shot(bob, "31-admin-remove-member");
  // Opening one of them closes the panel, to show it.
  await removal.getByRole("button", { name: "Lab finding" }).click();
  await expect(bobAdmin).toHaveCount(0);
  await expect(bob.getByRole("navigation", { name: "Location" })).toContainText("Lab finding");
  await bob.getByRole("button", { name: "Admin", exact: true }).click();
  await bobAdmin.getByRole("button", { name: "Remove Alice Admin" }).click();
  await removal.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(removal).toHaveCount(0);
  await expect(bobAdmin.getByRole("table", { name: "People" })).not.toContainText("Alice Admin");
  expect((await alice.request.get("/api/files", { headers: inLab })).status()).toBe(404);
  await bobAdmin.getByRole("button", { name: "Close" }).click();

  // Her shared experiment says she has gone, and Bob, an Owner, hands it over
  // to himself (docs/workspaces.md, "Experiment handover").
  await bob.getByRole("navigation", { name: "Location" }).getByRole("button", { name: "Lab finding" }).click();
  const findingPanel = bob.getByTestId("experiment-panel");
  const people = findingPanel.getByTestId("experiment-people");
  await expect(people).toContainText("Maintained by Alice Admin");
  await expect(people).toContainText("No longer a member");
  await expect(findingPanel.getByTestId("read-only-reason")).toHaveText(
    "Only Alice Admin can edit this experiment. Rerun it to work on your own copy.",
  );
  await shot(bob, "32-experiment-maintainer-left");
  await people.getByRole("button", { name: "Hand over" }).click();
  const handOver = bob.getByRole("dialog", { name: "Hand over the experiment" });
  // A departed maintainer isn't kept on, so there's nothing to choose about it.
  await expect(handOver.getByLabel("Stay on as a collaborator")).toHaveCount(0);
  await handOver.getByLabel("New maintainer").selectOption({ label: "Bob Builder" });
  await handOver.getByRole("button", { name: "Hand over" }).click();
  await expect(handOver).toHaveCount(0);
  await expect(people).toContainText("Maintained by you");
  await expect(people).toContainText("started by Alice Admin");
  await expect(people).not.toContainText("No longer a member");
  await expect(findingPanel.getByTestId("read-only-reason")).toHaveCount(0);
  await expect(findingPanel.getByRole("button", { name: "Make private" })).toBeVisible();

  await bob.getByRole("button", { name: "Admin", exact: true }).click();
  const bobAdd = bobAdmin.getByRole("form", { name: "Add a member" });
  await bobAdd.getByLabel("Email").fill("alice@example.com");
  await bobAdd.getByRole("button", { name: "Add" }).click();
  await expect(bobAdd.getByRole("status")).toContainText("Added Alice Admin as Member");
  await bobAdmin.getByRole("button", { name: "Close" }).click();

  // Bob, its maintainer now, adds her back to it as a collaborator: she edits
  // it again, until she stops collaborating.
  await people.getByRole("button", { name: "Add collaborator" }).click();
  const addCollaborator = bob.getByRole("dialog", { name: "Add a collaborator" });
  await addCollaborator.getByLabel("Collaborator").selectOption({ label: "Alice Admin" });
  await addCollaborator.getByRole("button", { name: "Add", exact: true }).click();
  await expect(addCollaborator).toHaveCount(0);
  await expect(people.getByRole("list", { name: "Collaborators" })).toHaveText("Alice Admin");
  await expect(people.getByRole("button", { name: "Remove Alice Admin as a collaborator" })).toBeVisible();
  await shot(bob, "33-experiment-collaborators");

  await alice.goto(findingUrl);
  await expect(alice.getByRole("navigation", { name: "Location" })).toContainText("Lab finding");
  await alice.getByRole("navigation", { name: "Location" }).getByRole("button", { name: "Lab finding" }).click();
  const aliceFinding = alice.getByTestId("experiment-panel");
  await expect(aliceFinding.getByTestId("experiment-people")).toContainText("Maintained by Bob Builder");
  await expect(aliceFinding.getByRole("list", { name: "Collaborators" })).toHaveText("you");
  await expect(aliceFinding.getByTestId("read-only-reason")).toHaveCount(0);
  // Collaborators edit; only the maintainer shares, archives or chooses who works on it.
  await expect(aliceFinding.getByLabel("Experiment state")).toBeVisible();
  await expect(aliceFinding.getByRole("button", { name: "Archive" })).toHaveCount(0);
  await expect(aliceFinding.getByRole("button", { name: "Add collaborator" })).toHaveCount(0);
  await aliceFinding.getByRole("button", { name: "Stop collaborating" }).click();
  await alice.getByRole("dialog", { name: "Stop collaborating?" }).getByRole("button", { name: "Stop collaborating" }).click();
  // It's shared, so she still sees it, read only.
  await expect(aliceFinding.getByTestId("read-only-reason")).toHaveText(
    "Only Bob Builder can edit this experiment. Rerun it to work on your own copy.",
  );
  await expect(aliceFinding.getByRole("list", { name: "Collaborators" })).toHaveCount(0);

  // Alice leaves it from the switcher; Bob, its last Owner, is told he can't yet.
  await alice.goto(labUrl);
  await expect(alice.getByRole("status").filter({ hasText: "Saved" })).toBeVisible();
  await alice.getByRole("button", { name: "Switch workspace" }).click();
  await alice.getByRole("menuitem", { name: "Leave workspace" }).click();
  const leaving = alice.getByRole("dialog", { name: `Leave ${lab}?` });
  await expect(leaving).toContainText("come back if you are");
  await leaving.getByRole("button", { name: "Leave", exact: true }).click();
  await expect(alice).toHaveURL(/\/w\/default$/);
  expect((await alice.request.get("/api/files", { headers: inLab })).status()).toBe(404);
  await bob.getByRole("button", { name: "Switch workspace" }).click();
  await bob.getByRole("menuitem", { name: "Leave workspace" }).click();
  const bobLeaving = bob.getByRole("dialog", { name: `Leave ${lab}?` });
  await expect(bobLeaving).toContainText("You're its only Owner");
  await expect(bobLeaving.getByRole("button", { name: "Leave", exact: true })).toHaveCount(0);
  await bob.keyboard.press("Escape");
  await expect(bobLeaving).toHaveCount(0);

  // Signing out ends the session.
  await bob.getByRole("button", { name: "Account" }).click();
  await bob.getByRole("button", { name: "Sign out" }).click();
  await expect(bob.getByText("You're signed out.")).toBeVisible();
  expect((await bob.request.get("/api/files")).status()).toBe(401);

  await alice.context().close();
  await bob.context().close();
});

test("the workspace inventory is for the deployment's admins, who add Owners but never themselves", async ({ browser }) => {
  // PLATFORM_ADMINS names Alice here (playwright.config.ts).
  const alice = await signIn(browser, "Alice Admin");
  const bob = await signIn(browser, "Bob Builder");
  const name = `Inventory lab ${Date.now()}`;
  const created = await alice.request.post("/api/workspaces", { data: { name } });
  expect(created.status()).toBe(201);

  // Bob isn't an admin: no menu item, and the page refuses him.
  await bob.goto("/platform");
  await expect(bob.getByTestId("workspace-inventory").getByRole("alert")).toContainText("Only the deployment's admins");
  await expect(bob.getByRole("table", { name: "Workspaces" })).toHaveCount(0);

  // Alice opens it from the switcher: her new workspace, with her as its Owner, and no content.
  await alice.getByRole("button", { name: "Switch workspace" }).click();
  await alice.getByRole("menuitem", { name: "Workspace inventory" }).click();
  await expect(alice).toHaveURL(/\/platform$/);
  const inventory = alice.getByRole("table", { name: "Workspaces" });
  await alice.getByRole("searchbox", { name: "Find a workspace" }).fill(name);
  await expect(inventory.getByRole("row")).toHaveCount(2);
  await expect(inventory.getByRole("list", { name: `Owners of ${name}` })).toContainText("Alice Admin");
  await expect(inventory.getByRole("row", { name })).toContainText("by Alice Admin");

  // She can't make herself an Owner, and someone who never signed in can't be found.
  await inventory.getByRole("button", { name: `Add an Owner to ${name}` }).click();
  const add = alice.getByRole("dialog", { name: `Add an Owner to ${name}` });
  await add.getByLabel("Their email").fill("nobody-yet@example.com");
  await add.getByRole("button", { name: "Find" }).click();
  await expect(add.getByRole("alert")).toContainText("Nobody with that email has signed in yet");
  await add.getByLabel("Their email").fill("alice@example.com");
  await add.getByRole("button", { name: "Find" }).click();
  await add.getByRole("button", { name: "Make Owner" }).click();
  await expect(add.getByRole("alert")).toContainText("can't make themselves Owners");

  // Bob, who isn't a member, becomes an Owner. Alice, active, holds Full access, so it isn't preselected.
  await add.getByLabel("Their email").fill("BOB@example.com");
  await add.getByRole("button", { name: "Find" }).click();
  await expect(add).toContainText("bob@example.com");
  await expect(add.getByLabel(/Also give them Full access/)).not.toBeChecked();
  await shot(alice, "34-workspace-inventory-add-owner");
  await add.getByRole("button", { name: "Make Owner" }).click();
  await expect(add).toHaveCount(0);
  await expect(alice.getByRole("status")).toContainText(`Bob Builder is now an Owner of ${name}.`);
  await expect(inventory.getByRole("list", { name: `Owners of ${name}` })).toContainText("Bob Builder");
  await alice.getByRole("searchbox", { name: "Find a workspace" }).fill("");
  await shot(alice, "35-workspace-inventory");

  // Bob now has it, as an Owner.
  const mine = (await (await bob.request.get("/api/workspaces")).json()) as { workspaces: { name: string; role: string }[] };
  expect(mine.workspaces.find((w) => w.name === name)?.role).toBe("owner");

  await alice.context().close();
  await bob.context().close();
});
