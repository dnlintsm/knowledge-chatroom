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

// A sample run folder from the seed files (src/components/workspace/seed.ts).
// Without server storage it is only a folder: runs are experiments, which
// live on the server (runs.spec.ts shows them).
const RUN = "runs/etch-2026-10-01";
const REPORT = `${RUN}/xdoe-report/report.md`;

/** The file list, with the sample run folder's report open. */
async function gotoReport(page: Page) {
  await page.goto("/");
  await page.locator(`[role="treeitem"][title="${REPORT}"]`).click();
  await expect(page.getByTestId("file-preview")).toContainText("xDOE report: etch rate");
}

/** The sample report open, with the chat ready. */
async function openHome(page: Page) {
  await gotoReport(page);
  await expect(page.getByTestId("copilot-chat-textarea")).toBeVisible();
  await expect(page.getByTestId("copilot-suggestion").first()).toBeVisible();
}

// These screens show the browser-only workspace. When the run also has server
// storage (for knowledge.spec.ts), the storage API answers 404 here, which is
// what the app sees without DATABASE_URL.
test.beforeEach(async ({ page }) => {
  await page.route(/\/api\/(files|nodes)([/?]|$)/, (route) => route.fulfill({ status: 404 }));
});

// Long timeouts leave room for a real Claude reply when ANTHROPIC_API_KEY is set.
const reply = { timeout: 90_000 };

async function send(page: Page, text: string) {
  await page.getByTestId("copilot-chat-textarea").fill(text);
  await page.getByTestId("copilot-send-button").click();
  await expect(page.getByText(text)).toBeVisible();
}

test("workspace walkthrough", async ({ page }) => {
  // The files, and the chat beside them.
  await page.goto("/");
  await expect(page.getByRole("treeitem", { name: /welcome\.md/ })).toBeVisible();
  await expect(page.getByTestId("copilot-chat-textarea")).toBeVisible();
  await expect(page.getByTestId("chat-context-run")).toHaveCount(0);
  await shot(page, "01-workspace");

  // A report from a sample run folder, and Claude seeing it.
  await page.locator(`[role="treeitem"][title="${REPORT}"]`).click();
  await expect(page.getByTestId("file-preview")).toContainText("xDOE report: etch rate");
  await expect(page.getByRole("treeitem", { name: /effects\.csv/ })).toBeVisible();
  await expect(page.getByTestId("copilot-suggestion").first()).toBeVisible();
  await shot(page, "02-report");

  // Selecting text in the preview shows up as chat context.
  await page.getByTestId("file-preview").getByText("RF power dominates etch rate").selectText();
  await page.getByTestId("file-preview").dispatchEvent("mouseup");
  await expect(page.getByTestId("chat-context")).toContainText("selected chars");

  await send(page, "Summarize this file and save it under artifacts/");
  // The suggestion chips hide while a run streams and come back once it ends.
  await expect(page.getByTestId("copilot-assistant-message").first()).toBeVisible(reply);
  await expect(page.getByTestId("copilot-suggestion").first()).toBeVisible(reply);
  await shot(page, "03-claude-writes-artifact");

  await page.locator(`[role="treeitem"][title="${REPORT}"]`).click();
  await expect(page.getByTestId("file-preview").locator("table").first()).toBeVisible();
  await page.getByRole("button", { name: "edit", exact: true }).click();
  await expect(page.getByTestId("file-editor")).toBeVisible();
  await shot(page, "04-edit-mode");

  await page.getByRole("button", { name: "Skills", exact: true }).click();
  await page.getByRole("treeitem", { name: /summarize/ }).click();
  await shot(page, "05-skills");

  await page.getByRole("button", { name: "Task board" }).click();
  await expect(page.getByRole("button", { name: "Add a task" })).toBeVisible();
  await page.getByRole("button", { name: "Add a task" }).click();
  await shot(page, "06-task-board");

  // Past chats live in the chat pane now, not on the left icon rail.
  await expect(page.getByRole("button", { name: "Chats", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Chat history" }).click();
  await expect(page.getByTestId("chat-history")).toBeVisible();
  await expect(page.getByTestId("copilot-chat-textarea")).toBeHidden();
  await shot(page, "07-chats-list");
  await page.getByRole("button", { name: "Chat history" }).click();
  await expect(page.getByTestId("copilot-chat-textarea")).toBeVisible();
  // Hidden while showing the history, the chat reopens on the conversation.
  await page.getByRole("button", { name: "Chat history" }).click();

  await page.getByRole("button", { name: "Hide chat" }).click();
  await page.getByRole("button", { name: "Files", exact: true }).click();
  await shot(page, "08-hidden-chat");
  // The chat icon at the top-right opens the chat with the cursor in its input.
  await page.getByRole("button", { name: "Show chat" }).click();
  await expect(page.getByTestId("copilot-chat-textarea")).toBeFocused();
  await shot(page, "08b-chat-reopened");

  // The app name at the top-left goes home to the Runs view, which needs server storage.
  await page.getByRole("link", { name: "Knowledge Chatroom" }).click();
  await expect(page.getByText("Runs need server storage.")).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
});

test("skills: modes, the / menu and the status bar", async ({ page }) => {
  await openHome(page);
  await page.getByRole("button", { name: "Skills", exact: true }).click();
  const panel = page.getByTestId("skills-panel");
  const tldr = panel.locator('[data-skill="tldr"]');
  await expect(tldr).toContainText("Built-in");
  await expect(tldr.getByRole("radio", { name: "Auto" })).toHaveAttribute("aria-checked", "true");
  // write-skill may only run by name, so Auto is not offered.
  const writeSkill = panel.locator('[data-skill="write-skill"]');
  await expect(writeSkill.getByRole("radio", { name: "Manual" })).toHaveAttribute("aria-checked", "true");
  await expect(writeSkill.getByRole("radio", { name: "Auto" })).toBeDisabled();
  await expect(page.getByTestId("skill-status")).toContainText("2 auto · 1 manual skills");

  // Off takes it out of the / menu; back to the default brings it back.
  await tldr.getByRole("radio", { name: "Off" }).click();
  await expect(page.getByTestId("skill-status")).toContainText("1 auto · 1 manual skills");
  await page.getByTestId("copilot-chat-textarea").fill("/");
  await expect(page.getByTestId("skill-menu")).not.toContainText("/tldr");
  await tldr.getByTestId("skill-use-default").click();
  await expect(tldr.getByRole("radio", { name: "Auto" })).toHaveAttribute("aria-checked", "true");
  await page.getByTestId("copilot-chat-textarea").fill("");

  // Typing / lists the skills; Enter picks one and leaves room for its input.
  await page.getByTestId("copilot-chat-textarea").fill("/t");
  await expect(page.getByTestId("skill-menu")).toContainText("/tldr");
  await expect(page.getByTestId("skill-menu")).toContainText("[what to focus on]");
  await shot(page, "05b-skill-menu");
  await page.getByTestId("copilot-chat-textarea").press("Enter");
  await expect(page.getByTestId("copilot-chat-textarea")).toHaveValue("/tldr ");
  await expect(page.getByTestId("skill-menu")).toBeHidden();

  await page.getByTestId("copilot-chat-textarea").pressSequentially("RF power");
  await page.getByTestId("copilot-send-button").click();
  await expect(page.getByTestId("skill-used")).toHaveText("/tldr", reply);
  await expect(page.getByTestId("skill-status")).toContainText("Used:");
  await expect(page.getByTestId("copilot-assistant-message").last()).toContainText("TL;DR", reply);
  await shot(page, "05c-skill-status");
});

test("skills: defaults for everyone, your choice, and one chat's own", async ({ page }) => {
  await openHome(page);
  await page.getByRole("button", { name: "Skills", exact: true }).click();
  const tldr = page.getByTestId("skills-panel").locator('[data-skill="tldr"]');
  const status = page.getByTestId("skill-status");

  // An editor sets Manual for everyone; with no choice of your own, you get it too.
  await tldr.getByTestId("skill-workspace-mode").selectOption("manual");
  await expect(tldr.getByRole("radio", { name: "Manual" })).toHaveAttribute("aria-checked", "true");
  await expect(tldr).toContainText("Workspace default");
  // Your own choice wins until you go back to the default.
  await tldr.getByRole("radio", { name: "Auto" }).click();
  await expect(tldr.getByTestId("skill-use-default")).toBeVisible();
  await expect(status).toContainText("2 auto · 1 manual skills");
  await shot(page, "05d-skill-defaults");

  // Off in this chat only: the / command no longer runs it here.
  await page.getByTestId("chat-skills-toggle").click();
  const chat = page.getByTestId("chat-skills").locator('[data-skill="tldr"]');
  await expect(chat.getByTestId("skill-chat-mode")).toHaveValue("");
  await chat.getByTestId("skill-chat-mode").selectOption("off");
  await expect(page.getByTestId("chat-skills-toggle")).toHaveText("This chat · 1 changed");
  await expect(status).toContainText("1 auto · 1 manual skills");
  await shot(page, "05e-skill-this-chat");
  await page.getByTestId("chat-skills-toggle").click();
  // Your choice in the panel is unchanged.
  await expect(tldr.getByRole("radio", { name: "Auto" })).toHaveAttribute("aria-checked", "true");

  if (process.env.E2E_MODE !== "live") {
    // The mock agent runs /tldr only where it is on for the run's chat, so
    // this also checks that the chat's choices reach its runs.
    await page.getByTestId("copilot-chat-textarea").fill("/tldr RF power");
    await page.getByTestId("copilot-send-button").click();
    await expect(page.getByTestId("copilot-assistant-message").last()).toContainText("mock agent", reply);
    await expect(page.getByTestId("skill-used")).toHaveCount(0);
  }

  // Back to yours, and the skills go back to how they were.
  await page.getByTestId("chat-skills-toggle").click();
  await chat.getByTestId("skill-chat-mode").selectOption("");
  await tldr.getByTestId("skill-use-default").click();
  await tldr.getByTestId("skill-workspace-mode").selectOption("");
  await expect(page.getByTestId("chat-skills-toggle")).toHaveText("This chat");
  await expect(tldr).toContainText("Default");
});

test("Claude remembers across chats, and you see, undo and edit it", async ({ page }) => {
  test.skip(process.env.E2E_MODE === "live", "the mock agent saves the memory");
  await page.goto("/");
  const chip = page.getByTestId("memory-chip");
  await send(page, "Remember that I prefer short answers that lead with the result.");
  await expect(page.getByTestId("copilot-assistant-message").last()).toContainText("keep that in mind", reply);
  await expect(chip).toContainText("reply-style");
  await expect(chip).toHaveAttribute("data-kind", "create");
  await shot(page, "29-memory-saved");

  // Undo takes Claude's change back.
  await page.getByTestId("memory-undo").click();
  await expect(chip).toHaveClass(/line-through/);
  await expect(page.getByTestId("memory-undo")).toHaveCount(0);

  await send(page, "Remember that I prefer short answers, result first.");
  await expect(chip).toHaveAttribute("data-kind", "create", reply);
  await page.getByRole("navigation", { name: "Sidebar views" }).getByRole("button", { name: "Memory" }).click();
  const row = page.getByTestId("memory-row").filter({ hasText: "reply-style" });
  await expect(row).toHaveCount(1);
  await row.click();
  const editor = page.getByTestId("memory-editor");
  await expect(editor.getByLabel("Note")).toHaveValue("I prefer short answers, result first.");
  await editor.getByLabel("Note").fill("Short answers, result first. No em-dashes.");
  await editor.getByRole("button", { name: "Save" }).click();
  await expect(editor.getByTestId("memory-version")).toHaveCount(2);
  await expect(editor.getByRole("button", { name: "Save" })).toBeDisabled();
  await shot(page, "29b-memory-panel");

  // An incognito chat leaves memory alone.
  await page.getByTestId("memory-incognito").click();
  await expect(page.getByTestId("memory-status")).toContainText("Incognito");
  await send(page, "Remember that I like tables.");
  await expect(page.getByTestId("copilot-assistant-message").last()).toContainText("mock agent", reply);
  await expect(chip).toHaveCount(0);
  await expect(page.getByTestId("skill-status")).toContainText("auto ·");
  await shot(page, "29c-memory-incognito");
  await page.getByTestId("memory-incognito").click();
  await expect(page.getByTestId("memory-incognito")).toHaveAttribute("aria-pressed", "false");
});

test("a workspace with no runs still has the chat", async ({ page }) => {
  // A first start with one note and no run folders.
  await page.addInitScript((key) => {
    if (window.localStorage.getItem(key)) return;
    const note = {
      path: "notes/welcome.md", kind: "note", content: "# Welcome\n", mime: "text/markdown",
      author: "user", updatedAt: Date.now(),
    };
    window.localStorage.setItem(key, JSON.stringify({ files: [note], tabs: [], active: null }));
  }, "knowledge-chatroom.workspace.v1");
  await page.goto("/");
  await expect(page.getByTestId("copilot-chat-textarea")).toBeVisible();
  await page.getByRole("button", { name: "Hide chat" }).click();
  await expect(page.getByTestId("copilot-chat-textarea")).toBeHidden();
  await page.getByRole("button", { name: "Show chat" }).click();
  await expect(page.getByTestId("copilot-chat-textarea")).toBeFocused();
  await shot(page, "20-chat-without-runs");
});

test("chats come back after the page reloads", async ({ page }) => {
  const question = "Which etch runs did we do last week?";
  await page.goto("/");
  await send(page, question);
  await expect(page.getByTestId("copilot-assistant-message").first()).toBeVisible(reply);
  await expect(page.getByTestId("copilot-suggestion").first()).toBeVisible(reply);

  // A reload starts a new chat; the last one waits in the history, named after the question.
  await page.reload();
  await expect(page.getByTestId("copilot-chat-textarea")).toBeVisible();
  await expect(page.getByText(question)).toHaveCount(0);
  await page.getByRole("button", { name: "Chat history" }).click();
  const chat = page.getByTestId("chat-history").getByRole("option", { name: question });
  await expect(chat).toBeVisible();
  await shot(page, "28-chat-history-after-reload");

  await chat.click();
  await expect(page.getByTestId("copilot-chat-textarea")).toBeVisible();
  await expect(page.getByText(question)).toBeVisible();
  await expect(page.getByTestId("copilot-assistant-message").first()).toBeVisible();
  await shot(page, "28b-chat-reopened");
});

test("selection is dropped when its file closes", async ({ page }) => {
  await gotoReport(page);
  const preview = page.getByTestId("file-preview");
  await preview.getByRole("heading", { name: "Findings" }).selectText();
  await preview.dispatchEvent("mouseup");
  const context = page.getByTestId("chat-context");
  await expect(context).toContainText("selected chars");
  await page.getByRole("tab", { name: /report\.md/ }).getByRole("button", { name: "Close tab" }).click();
  await expect(preview).toContainText("Welcome to Knowledge Chatroom");
  await expect(context).not.toContainText("selected chars");
});

test("files and layout survive a reload", async ({ page }) => {
  await gotoReport(page);
  await page.getByRole("button", { name: "New note" }).click();
  await page.getByTestId("file-editor").fill("# Kept after reload");
  await page.getByRole("button", { name: "Hide chat" }).click();
  await page.reload();
  await expect(page.getByRole("treeitem", { name: /untitled-1\.md/ })).toHaveAttribute(
    "title",
    "notes/untitled-1.md",
  );
  await expect(page.getByRole("button", { name: "Show chat" })).toBeVisible();
});

test("rename a file", async ({ page }) => {
  const NOTES = "notes";
  await gotoReport(page);
  await page.getByRole("button", { name: "New note" }).click();
  await page.getByTestId("file-editor").fill("# Etch plan");
  const row = page.getByRole("treeitem", { name: /untitled-1\.md/ });
  await row.getByRole("button", { name: `Rename ${NOTES}/untitled-1.md` }).click();
  const input = page.getByRole("textbox", { name: `New name for ${NOTES}/untitled-1.md` });
  await expect(input).toBeFocused();
  await input.fill("etch-plan.md");
  await shot(page, "18-file-rename");
  await page.keyboard.press("Enter");
  const renamed = page.getByRole("treeitem", { name: /etch-plan\.md/ });
  await expect(renamed).toHaveAttribute("title", `${NOTES}/etch-plan.md`);
  await expect(page.getByRole("treeitem", { name: /untitled-1\.md/ })).toHaveCount(0);
  // The open tab follows the file.
  await expect(page.getByRole("tab", { name: /etch-plan\.md/ })).toBeVisible();
  await expect(page.getByTestId("file-preview")).toContainText("Etch plan");

  // A taken name is refused, and the file keeps its name.
  await page.getByRole("button", { name: "New note" }).click();
  const taken = (await page.getByRole("treeitem", { name: /untitled-\d+\.md/ }).innerText()).trim();
  await renamed.hover();
  await renamed.getByRole("button", { name: `Rename ${NOTES}/etch-plan.md` }).click();
  await page.getByRole("textbox", { name: `New name for ${NOTES}/etch-plan.md` }).fill(taken);
  await page.keyboard.press("Enter");
  await expect(page.getByRole("alert").filter({ hasText: `${taken} already exists here` })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(renamed).toBeVisible();
});

test("dark mode", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await openHome(page);
  await shot(page, "12-dark-mode");
});

test("mobile layout", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Chat", exact: true })).toBeVisible();
  await expect(page.getByTestId("file-preview")).toBeVisible();
  await shot(page, "13-mobile-editor");
  await page.getByRole("button", { name: "Files" }).last().click();
  await shot(page, "14-mobile-files");
  // Tapping a file switches to the editor.
  await page.locator(`[role="treeitem"][title="${REPORT}"]`).click();
  await expect(page.getByTestId("file-preview")).toBeVisible();
  await page.getByRole("button", { name: "Chat", exact: true }).click();
  await expect(page.getByTestId("copilot-chat-textarea")).toBeVisible();
  await shot(page, "15-mobile-chat");
  await page.getByRole("button", { name: "Chat history" }).click();
  await expect(page.getByTestId("chat-history")).toBeVisible();
  await shot(page, "16-mobile-chat-history");
});

// The mock agent answers "read next" with references to notes/reading-list.md
// line 7 and uploads/sales.csv lines 3-4; real Claude words its answer freely.
const citesFiles = "Which book should I read next?";
const fileRef = (page: Page, text: string) => page.getByTestId("file-ref").filter({ hasText: text });

test("file references in answers open the cited lines", async ({ page }) => {
  test.skip(process.env.E2E_MODE === "live", "Needs the mock agent's canned answer.");
  await openHome(page);
  await send(page, citesFiles);
  await fileRef(page, "The Pragmatic Programmer").click(reply);

  // The preview switches to the file and highlights the cited table row.
  await expect(page.getByRole("tab", { name: /reading-list\.md/ })).toHaveAttribute("aria-selected", "true");
  const cited = page.getByTestId("file-preview").locator("[data-revealed]");
  await expect(cited).toHaveText(/The Pragmatic Programmer/);
  await expect(cited).toBeInViewport();
  await shot(page, "16-file-reference");

  // The editor selects the same line.
  await page.getByRole("button", { name: "edit", exact: true }).click();
  const editor = page.getByTestId("file-editor");
  await expect(editor).toBeFocused();
  await expect
    .poll(() => editor.evaluate((t: HTMLTextAreaElement) => t.value.slice(t.selectionStart, t.selectionEnd)))
    .toBe("| The Pragmatic Programmer | Craft | Next |");

  // A range highlights each row it covers.
  await fileRef(page, "sales.csv:3-4").click();
  await expect(page.getByTestId("file-preview").locator("tr[data-revealed]")).toHaveText([/2026-08/, /2026-09/]);
});

test("file references on a phone show the editor", async ({ page }) => {
  test.skip(process.env.E2E_MODE === "live", "Needs the mock agent's canned answer.");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.getByRole("button", { name: "Files" }).last().click();
  await page.getByRole("button", { name: "Uploads", exact: true }).click();
  await page.getByRole("treeitem", { name: /sales\.csv/ }).click();
  // The CopilotKit inspector sometimes pops open over the editor toolbar on a phone.
  await page.getByRole("button", { name: "edit", exact: true }).dispatchEvent("click");
  await page.getByRole("button", { name: "Chat", exact: true }).click();
  await send(page, citesFiles);
  await fileRef(page, "sales.csv:3-4").click(reply);
  // Only possible once the editor pane is on screen.
  await expect(page.getByTestId("file-editor")).toBeFocused();
});

test("chat suggestions: first round follows what is open, then follow-ups", async ({ page }) => {
  await openHome(page);
  const chip = (name: string | RegExp) => page.getByTestId("copilot-suggestion").filter({ hasText: name });
  // The open report: summarize it or draft a note. Analyzing a run's report
  // and similar experiments need a run, which needs server storage (runs.spec.ts).
  await expect(chip("Summarize report.md")).toBeVisible();
  await expect(chip("Draft a note")).toBeVisible();
  await expect(chip("Analyze the report")).toHaveCount(0);
  await expect(chip("Search similar experiments")).toHaveCount(0);
  await shot(page, "17-chat-suggestions");

  // The summarize chip follows the open file.
  await page.getByRole("treeitem", { name: /effects\.csv/ }).click();
  await expect(chip("Summarize effects.csv")).toBeVisible();
  await chip("Draft a note").click();
  await expect(page.getByText("draft a short note at notes/next-steps.md")).toBeVisible();

  // After the reply, the suggester's follow-ups replace the first round
  // (the mock agent's canned ones without an API key).
  await expect(page.getByTestId("copilot-assistant-message").first()).toBeVisible(reply);
  await expect(page.getByTestId("copilot-suggestion").first()).toBeVisible(reply);
  await expect(chip("Draft a note")).toHaveCount(0);
  if (process.env.E2E_MODE !== "live") await expect(chip("Check the evidence")).toBeVisible();
  await shot(page, "17-chat-follow-ups");
});

test("each chat run tells the agent who the user is and where (docs/remote-agent.md)", async ({ page, request }) => {
  test.skip(process.env.E2E_MODE === "live", "Reads the run input the mock agent kept.");
  await openHome(page);
  await page.getByRole("treeitem", { name: /effects\.csv/ }).click();
  await send(page, "What does this file show?");
  await expect(page.getByTestId("copilot-assistant-message").first()).toBeVisible(reply);

  // The mock agent keeps what the CopilotKit runtime sent it (e2e/mock-agent.mjs).
  const lastRun = await (await request.get(`${process.env.LOCAL_AGENT_URL}/last-run`)).json();
  expect(lastRun.forwardedProps.knowledge_chatroom).toEqual({
    version: 2,
    // No login here: the one local user, set by the server.
    user: { id: "local", email: null, name: null, signed_in: false },
    storage: "local",
    node: null,
    experiment: null,
    selected_path: `${RUN}/xdoe-report/effects.csv`,
  });
});
