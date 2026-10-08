/**
 * The Claude Agent SDK agent — backend tools + the official AG-UI adapter.
 *
 * Three backend tools live in their own modules (src/query.ts,
 * src/a2ui_fixed_schema.ts, src/a2ui_dynamic_schema.ts). The official
 * ClaudeAgentAdapter does everything else: it drives Claude via the Claude Agent
 * SDK, bridges CopilotKit frontend tools + human-in-the-loop, and manages the
 * shared `todos` state via its built-in ag_ui_update_state tool.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";
import { ClaudeAgentAdapter } from "@ag-ui/claude-agent-sdk";
import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import type { RunAgentInput } from "@ag-ui/core";

import { resolveModel } from "./model";
import { queryData } from "./query";
import { searchFlights } from "./a2ui_fixed_schema";
import { generateA2ui } from "./a2ui_dynamic_schema";
import { currentStorage } from "./storage";
import { storageConfigFromEnv } from "./storage/config";
import { createFileTools } from "./storage/tools";

// Load .env from the starter root before building the adapter (which reads the
// model from the environment); fall back to the current working directory.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../.env") });
dotenv.config();

// With storage configured (DATABASE_URL), workspace files live on the server.
const serverStorage = Boolean(storageConfigFromEnv());

const SYSTEM_PROMPT = [
  "You are a polished, professional demo assistant. Keep responses to 1-2 sentences.",
  "",
  "- Flights: call search_flights to show flight cards.",
  "- Dashboards: call generate_a2ui to build a rich dashboard UI; it renders itself.",
  "- Charts: call query_data first, then render with the chart component.",
  "- Todos: the todo board is shared state under `todos`; call openTaskBoard, then",
  "  ag_ui_update_state with the COMPLETE list to add or change todos.",
  "- Workspace: the user works on files beside the chat. The open file and their",
  "  selection arrive as context. Use the workspace file tools to look around (list,",
  "  read) and to create or edit files (write, full content); new generated",
  "  documents go under artifacts/. Say what you changed in one line.",
  "- File references: when you mention a workspace file or lines in it, link them so",
  "  the user can click to open them beside the chat: [welcome.md](notes/welcome.md),",
  "  [welcome.md:12](notes/welcome.md#L12) or [welcome.md:12-18](notes/welcome.md#L12-L18).",
  "  Use the workspace path and the line numbers shown in the content you were given.",
  ...(serverStorage
    ? [
        "- Knowledge tree: files live at the workspace root or in a node of the tree",
        "  (levels like tech › module › loop › process). The context's currentNode is",
        "  where the user is; pass its id as `node` to the file tools to work there,",
        "  and read parent nodes' files for background. list_nodes shows the tree.",
        "- Experiments: a user's sandbox on a node, with its own copy of the node's files.",
        "  When the context has currentExperiment, the user is in it: pass its id as",
        "  `experiment` to the file tools and never write to its node. Keep its",
        "  hypothesis, params and results up to date with update_experiment as the work",
        "  shows them; list_experiments compares experiments on a node.",
        "- Reviews: your write_file in a knowledge node doesn't change the file; it",
        "  proposes the change, and someone who can edit the node accepts or rejects it",
        "  in the editor. Say so, with a one-line summary of the change. When the user",
        "  asks to bring an experiment's results to its node, propose_experiment does",
        "  that for its changed files.",
        "- Search: search_files finds files by their text or path across every place the",
        "  user can read. Search before saying the workspace has nothing on a topic, and",
        "  pass the user's place (node / experiment) so nearby results come first.",
      ]
    : []),
].join("\n");

// The Claude Agent SDK exposes custom tools through an in-process MCP server
// (createSdkMcpServer). The model calls them as mcp__<server>__<tool>, and
// allowedTools pre-approves those names so they run without a permission prompt.
// (`tools` is a different field — Claude Code's BUILT-IN toolset; [] disables it
// so the model only uses ours + the AG-UI protocol tools.)
//
// With storage configured (DATABASE_URL), workspace files live on the server and
// the file tools run here; the browser then hides its own copies of them.
const SERVER_NAME = "copilotkit";
type Tools = NonNullable<Parameters<typeof createSdkMcpServer>[0]["tools"]>;
const baseTools: Tools = [queryData, searchFlights, generateA2ui];
const toolServer = (tools: Tools) =>
  createSdkMcpServer({ name: SERVER_NAME, version: "1.0.0", tools });
// The file tools act for a user (see ./storage/tools.ts). Without login that
// is always the local user; with it, each run gets tools for its own user.
const fileTools = serverStorage ? createFileTools(currentStorage) : [];
const backendTools: Tools = [...baseTools, ...fileTools];

const runUser = new AsyncLocalStorage<string | null>();

/**
 * Runs `fn` (which starts an adapter run) for a storage user: that run's file
 * tools can do what the user can, and nothing else. null = no access;
 * undefined = the shared tools, which act for the local user without login.
 */
export const runAs = <T>(userId: string | null | undefined, fn: () => T): T =>
  userId === undefined ? fn() : runUser.run(userId, fn);

class WorkspaceAgentAdapter extends ClaudeAgentAdapter {
  // Called synchronously when a run starts, so runAs()'s user is in scope.
  override buildOptions(input: RunAgentInput) {
    const options = super.buildOptions(input);
    const userId = runUser.getStore();
    if (!serverStorage || userId === undefined) return options;
    const tools = [...baseTools, ...createFileTools(currentStorage, async () => userId)];
    return { ...options, mcpServers: { ...options.mcpServers, [SERVER_NAME]: toolServer(tools) } };
  }
}

export const adapter = new WorkspaceAgentAdapter({
  agentId: "claude-sdk-typescript",
  description: "CopilotKit × Claude Agent SDK (TypeScript) starter",
  model: resolveModel(),
  systemPrompt: SYSTEM_PROMPT,
  mcpServers: { [SERVER_NAME]: toolServer(backendTools) },
  allowedTools: backendTools.map((tool) => `mcp__${SERVER_NAME}__${tool.name}`),
  tools: [],
  includePartialMessages: true,
});
