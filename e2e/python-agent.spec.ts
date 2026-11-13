import { test, expect, type Page } from "@playwright/test";

/**
 * The chat with the Python chat agent (services/agent-py) as its remote
 * backend (AGENT_URL, docs/remote-agent.md): `pnpm test:e2e:python`.
 *
 * The agent runs a real Claude Code engine through the Claude Agent SDK, with a
 * scripted model behind ANTHROPIC_BASE_URL (mock-anthropic.mjs), so this covers
 * the app, the AG-UI adapter, the browser's tools and skills end to end without
 * an API key. The agent server (LOCAL_AGENT_URL) is the mock one: it hands the
 * run its skills and writes the follow-up chips.
 */

const MODEL_URL = `http://localhost:${process.env.E2E_MODEL_PORT ?? 9500}`;
// The engine starts once per chat, which takes a few seconds.
const reply = { timeout: 60_000 };

async function send(page: Page, text: string) {
  await page.getByTestId("copilot-chat-textarea").fill(text);
  await page.getByTestId("copilot-send-button").click();
  await expect(page.getByText(text).first()).toBeVisible();
}

test("the chat runs on the Python agent: replies, browser tools, skills, follow-ups", async ({ page, request }) => {
  await page.goto("/");
  await expect(page.getByTestId("copilot-chat-textarea")).toBeVisible();
  const answer = page.getByTestId("copilot-assistant-message").last();

  // A plain reply, and the agent server's follow-up chips after it.
  await send(page, "Hello there");
  await expect(answer).toContainText("Hello from the Python agent", reply);
  await expect(page.getByTestId("copilot-suggestion").filter({ hasText: "Check the evidence" })).toBeVisible(reply);

  // What the model got: the chatroom's prompt, the browser's tools and the agent's
  // own, and the workspace note in front of the user's message.
  const sent = await (await request.get(`${MODEL_URL}/last-request`)).json();
  const tools = (sent.tools as { name: string }[]).map((t) => t.name);
  expect(tools).toContain("mcp__ag_ui__writeWorkspaceFile");
  expect(tools).toContain("mcp__copilotkit__list_files");
  expect(JSON.stringify(sent.system)).toContain("assistant in a knowledge workspace");
  expect(JSON.stringify(sent.messages)).toContain("<workspace>");

  // A browser tool: the model writes a file in the browser's workspace, and the
  // run goes on with the tool's result.
  await send(page, "Write a short note under artifacts/");
  await expect(page.getByRole("treeitem", { name: /python-agent\.md/ })).toBeVisible(reply);
  await expect(answer).toContainText("Saved artifacts/python-agent.md", reply);

  // A skill by its slash command: the agent server hands the run the skill's
  // files, Claude Code follows them, and the chat shows the skill used.
  await send(page, "/tldr RF power");
  await expect(answer).toContainText("TL;DR", reply);
  await expect(page.getByTestId("skill-used")).toHaveText("/tldr", reply);
});

// Gate test (#234): a real E2E failure. Do not merge.
test("gate test: deliberate failure", async () => {
  expect(1, "deliberate failure to test the preview gate").toBe(2);
});
