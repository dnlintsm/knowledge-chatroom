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

import { allowServer, externalServersFromEnv, serverConfigs, type RunTokens } from "./mcp";
import { resolveModel } from "./model";
import { keepFailureReason } from "./run-errors";
import { queryData } from "./query";
import { searchFlights } from "./a2ui_fixed_schema";
import { generateA2ui } from "./a2ui_dynamic_schema";
import { currentStorage } from "./storage";
import { storageConfigFromEnv } from "./storage/config";
import { createFileTools } from "./storage/tools";
import { CONFINED_TOOLS, confineTools, workdirPrompt } from "./storage/workdir";
import { guardSlashCommand, scriptOptions, skillOptions, type RunSkills, type SkillUse } from "./skills/run";
import { CHAT_TOOLS, chatTools, MEMORY_TOOLS, memoryPrompt, memoryTools, taintHook, type RunMemory } from "./memory/run";

// Load .env from the starter root before building the adapter (which reads the
// model from the environment); fall back to the current working directory.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(__dirname, "../..");
dotenv.config({ path: path.join(APP_ROOT, ".env") });
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
  "- Runs: a run is an experiment with a report (its report.md).",
  "  The one the user is in arrives as currentExperiment in context, with its state",
  "  (ready, running, done, failed) and report. Answer about that run unless told",
  "  otherwise. Without one, answer about the files where the user is.",
  "- Workbench: showPane / hidePane move the panes; listRuns and openRun switch runs;",
  "  listActions and runAction run the current run's Actions-block buttons (e.g.",
  "  generate-rules, which writes the run's read-only models/general_rules.md once and",
  "  opens it). Use them when the user asks for what they do, not on your own.",
  "- Skills: when one of your skills fits the request, use it. When the user's",
  "  message starts with /<skill>, that skill was loaded for this turn: follow it.",
  "  Writing a skill (skills/<name>/...) proposes it for review; it is not added",
  "  until someone accepts it, and only the user turns skills on or off.",
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
        "- Experiments: a user's sandbox on a node, with its own copy of the node's files,",
        "  or at the workspace root, starting empty.",
        "  When the context has currentExperiment, the user is in it: pass its id as",
        "  `experiment` to the file tools and never write to its node. Keep its",
        "  hypothesis and params up to date with update_experiment as the work shows",
        "  them; list_experiments compares experiments on a node.",
        "- Starting a run: when the user asks to analyze or run something, create_experiment",
        "  with the files it works from as `inputs` (linked read only under inputs/, at",
        "  their current versions) and the skill you follow as `skill`. Write the report",
        "  below the front matter of its report.md (keep the front matter), save outputs",
        "  in the run, then set_experiment_results with the results and done, or failed",
        "  with the reason in the report. A rerun is a new run (create_experiment with",
        "  rerunOf); never rewrite a finished one.",
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
// Outside MCP servers from MCP_SERVERS (see ./mcp.ts), e.g. Python tools.
const externalServers = externalServersFromEnv();

interface RunContext {
  userId: string | null | undefined;
  /** This run's skills (see ./skills/run.ts); null = none. */
  skills: RunSkills | null;
  onSkillUse: (use: SkillUse) => void;
  /** Signs the run's user for an outside MCP server that asks for it. */
  identity?: RunTokens;
  /** The user's memory for this run (./memory/run.ts); null = none. */
  memory?: RunMemory | null;
}

const runContext = new AsyncLocalStorage<RunContext>();

/** forwardedProps key of the app's run payload (src/lib/chatroom-props.ts). */
const CHATROOM_PROPS = "knowledge_chatroom";

/**
 * Runs `fn` (which starts an adapter run) for a storage user: that run's file
 * tools can do what the user can, and nothing else. null = no access;
 * undefined = the shared tools, which act for the local user without login.
 * `skills` are the skills prepared for the run, and `onSkillUse` hears each
 * one it uses. `identity` signs the run's user for each outside MCP server
 * that asks for it (./mcp.ts). `memory` is the user's memory for the run.
 */
export const runAs = <T>(
  userId: string | null | undefined,
  fn: () => T,
  skills: RunSkills | null = null,
  onSkillUse: (use: SkillUse) => void = () => {},
  identity?: RunTokens,
  memory: RunMemory | null = null,
): T => runContext.run({ userId, skills, onSkillUse, identity, memory }, fn);

// The adapter's own extra arguments (profile options, frontend tool results).
type OptionsRest = Parameters<ClaudeAgentAdapter["buildOptions"]> extends [unknown, ...infer R] ? R : never;

class WorkspaceAgentAdapter extends ClaudeAgentAdapter {
  // Slash commands only for the run's own skills (guardSlashCommand).
  override run(input: RunAgentInput) {
    const messages = input.messages ?? [];
    const last = messages[messages.length - 1];
    if (last?.role !== "user") return super.run(input);
    const skills = runContext.getStore()?.skills ?? null;
    const guard = (text: string) => guardSlashCommand(text, skills);
    const content =
      typeof last.content === "string"
        ? guard(last.content)
        : Array.isArray(last.content)
          ? (() => {
              // The adapter sends the first text part as the prompt.
              const first = last.content.findIndex((part) => "text" in part);
              return last.content.map((part, i) =>
                i === first && "text" in part ? { ...part, text: guard(part.text) } : part,
              );
            })()
          : last.content;
    if (content === last.content) return super.run(input);
    return super.run({
      ...input,
      messages: [...messages.slice(0, -1), { ...last, content } as typeof last],
    });
  }

  // Called synchronously when a run starts, so runAs()'s context is in scope.
  override buildOptions(input: RunAgentInput, ...rest: OptionsRest) {
    const options = super.buildOptions(withoutChatroomProps(input), ...rest);
    const ctx = runContext.getStore();
    if (!ctx) return options;
    // Skills' scripts, when on, run in Bash inside the SDK's sandbox.
    const scripts = ctx.skills && scriptOptions(ctx.skills, APP_ROOT);
    // The workspace copy in the run folder (./storage/workdir.ts): Read, Glob
    // and Grep, confined to that folder.
    const workdir = ctx.skills?.workdir ? ctx.skills : null;
    const builtIn = workdir ? CONFINED_TOOLS : [];
    const withSkills = ctx.skills
      ? (() => {
          const skill = skillOptions(ctx.skills, ctx.onSkillUse);
          return {
            ...options,
            ...skill,
            allowedTools: [...(options.allowedTools ?? []), "Skill", ...builtIn, ...(scripts ? ["Bash"] : [])],
            ...scripts,
            tools: ["Skill", ...builtIn, ...(scripts ? ["Bash"] : [])],
            ...(workdir && {
              systemPrompt: `${options.systemPrompt ?? ""}\n${workdirPrompt(workdir.workdir!, Boolean(scripts))}`,
              hooks: {
                ...skill.hooks,
                PreToolUse: [...(skill.hooks?.PreToolUse ?? []), confineTools(workdir.cwd)],
              },
            }),
          };
        })()
      : options;
    const withIdentity = ctx.identity
      ? { ...withSkills, mcpServers: { ...withSkills.mcpServers, ...serverConfigs(externalServers, ctx.identity) } }
      : withSkills;
    const userId = ctx.userId;
    if (!serverStorage || userId === undefined) return withIdentity;
    const memory = ctx.memory;
    const tools = [
      ...baseTools,
      ...createFileTools(currentStorage, async () => userId, workdir?.cwd, {
        chat: input.threadId ?? null,
        model: options.model ?? resolveModel(),
        skills: ctx.skills?.skills.map((s) => s.skill),
      }),
      ...(memory ? [...memoryTools(memory), ...chatTools(memory)] : []),
    ];
    return {
      ...withIdentity,
      ...(memory && {
        systemPrompt: `${withIdentity.systemPrompt ?? ""}\n${memoryPrompt(memory, memory.chats !== null)}`,
        hooks: { ...withIdentity.hooks, PreToolUse: [...(withIdentity.hooks?.PreToolUse ?? []), taintHook(memory)] },
      }),
      mcpServers: { ...withIdentity.mcpServers, [SERVER_NAME]: toolServer(tools) },
      // save_file is only in runs with a working folder, the memory and past-chat tools in runs with memory.
      allowedTools: [
        ...(withIdentity.allowedTools ?? []),
        ...(workdir ? [`mcp__${SERVER_NAME}__save_file`] : []),
        ...(memory ? MEMORY_TOOLS.map((name) => `mcp__${SERVER_NAME}__${name}`) : []),
        ...(memory?.chats ? CHAT_TOOLS.map((name) => `mcp__${SERVER_NAME}__${name}`) : []),
      ],
    };
  }
}

/**
 * The app's run payload (forwardedProps.knowledge_chatroom, for remote
 * backends; docs/remote-agent.md) isn't an SDK option: the adapter would only
 * warn about it. This agent learns the user from the signed header instead.
 */
function withoutChatroomProps(input: RunAgentInput): RunAgentInput {
  const props = input.forwardedProps as Record<string, unknown> | undefined;
  if (!props || !(CHATROOM_PROPS in props)) return input;
  const rest = { ...props };
  delete rest[CHATROOM_PROPS];
  return { ...input, forwardedProps: rest };
}

// Failed turns say why (a bad API key, an unknown model, ...), not just
// "SDK resume/run failed".
keepFailureReason();

export const adapter = new WorkspaceAgentAdapter({
  agentId: "claude-sdk-typescript",
  description: "CopilotKit × Claude Agent SDK (TypeScript) starter",
  model: resolveModel(),
  systemPrompt: SYSTEM_PROMPT,
  mcpServers: { ...serverConfigs(externalServers), [SERVER_NAME]: toolServer(backendTools) },
  allowedTools: [
    ...backendTools.map((tool) => `mcp__${SERVER_NAME}__${tool.name}`),
    ...Object.keys(externalServers).map(allowServer),
  ],
  tools: [],
  includePartialMessages: true,
});
