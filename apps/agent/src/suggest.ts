/**
 * Follow-up suggestions for the chat (the chips under it after a reply).
 *
 * CopilotKit's dynamic suggestions run a provider agent with a forced
 * `copilotkitSuggest` tool call. The Claude Agent SDK agent can't force a tool
 * and would run a whole turn with file tools, so `POST /suggest` answers
 * instead with one plain Messages API call on a small model: it reads the
 * conversation and the workspace context the browser sends and streams back
 * just that tool call as AG-UI events. Nothing is stored and no tools run.
 */
import { randomUUID } from "node:crypto";

import Anthropic from "@anthropic-ai/sdk";
import { EventType } from "@ag-ui/core";
import type { BaseEvent, Message, RunAgentInput, Tool } from "@ag-ui/core";

import { resolveModel } from "./model";

export const SUGGEST_TOOL = "copilotkitSuggest";

/** The small model the chips come from when SUGGESTIONS_MODEL isn't set. */
export const DEFAULT_SUGGESTIONS_MODEL = "claude-haiku-5-5";

/** Enough of the conversation and workspace to suggest from, without paying for all of it. */
const MAX_TRANSCRIPT_CHARS = 12_000;
const MAX_MESSAGE_CHARS = 2_000;
const MAX_CONTEXT_CHARS = 6_000;

const SYSTEM = `You suggest what the user might ask Claude next in Knowledge Chatroom. It is a workspace where Claude reads and writes the user's files, works on experiment runs and their xDOE reports, keeps a knowledge tree (technology, module, loop, process) with experiments on its nodes, searches the workspace by words and by meaning, and runs skills. Your suggestions appear as chips under the chat; clicking one sends its message as the user.

- Base them on the conversation and the workspace context: name the actual files, runs, experiments and findings.
- Offer natural next steps from what Claude just did (go deeper, check it, compare, save it as a file, propose it for review), never a repeat of it.
- Only things Claude can do here: no email, calendar, web browsing or outside services.
- title: at most 5 words. message: the complete request in the user's own voice, one or two sentences.
- Call the ${SUGGEST_TOOL} tool once.`;

/** SUGGESTIONS_MODEL, else a small Claude model; behind a gateway with a non-Claude model, that model. */
export function suggestionsModel(): string {
  const configured = process.env.SUGGESTIONS_MODEL;
  if (configured) return /^claude-/.test(configured) ? configured.replace(/\./g, "-") : configured;
  const main = resolveModel();
  return /^claude-/.test(main) ? DEFAULT_SUGGESTIONS_MODEL : main;
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (part && typeof part === "object" && "text" in part && typeof part.text === "string" ? part.text : ""))
    .filter(Boolean)
    .join("\n");
}

function line(message: Message): string | null {
  switch (message.role) {
    case "user":
      return `User: ${clip(textOf(message.content), MAX_MESSAGE_CHARS)}`;
    case "assistant": {
      const said = textOf(message.content);
      const used = (message.toolCalls ?? []).map((call) => call.function.name);
      return [said && `Claude: ${clip(said, MAX_MESSAGE_CHARS)}`, used.length && `(Claude used ${used.join(", ")})`]
        .filter(Boolean)
        .join("\n") || null;
    }
    default:
      // Tool results, system and other messages: the calls above say enough.
      return null;
  }
}

/** The newest lines of the conversation that fit. */
export function transcript(messages: Message[]): string {
  const lines: string[] = [];
  let size = 0;
  for (const message of [...messages].reverse()) {
    const text = line(message);
    if (!text) continue;
    if (size + text.length > MAX_TRANSCRIPT_CHARS && lines.length) break;
    lines.unshift(text);
    size += text.length;
  }
  return lines.join("\n\n");
}

/**
 * CopilotKit's request is the last user message. Its list of the browser's
 * tools (Claude's, not the user's) is long and the system prompt covers what
 * Claude can do, so it is dropped.
 */
function request(message: Message | undefined): string {
  return textOf(message?.content)
    .split("\n")
    .filter((l) => !l.startsWith("The user has the following tools available:"))
    .join("\n")
    .trim();
}

export interface SuggestPrompt {
  system: string;
  user: string;
  tool: Anthropic.Tool;
}

/** The Messages API request for `input`, or null when it doesn't ask for suggestions. */
export function suggestPrompt(input: RunAgentInput): SuggestPrompt | null {
  const tool = (input.tools ?? []).find((t: Tool) => t.name === SUGGEST_TOOL);
  const messages = input.messages ?? [];
  const last = messages.at(-1);
  if (!tool || last?.role !== "user") return null;
  const context = (input.context ?? [])
    .map((c) => `<context description=${JSON.stringify(clip(c.description, 300))}>\n${clip(c.value, MAX_CONTEXT_CHARS)}\n</context>`)
    .join("\n");
  const user = [
    `<conversation>\n${transcript(messages.slice(0, -1)) || "(empty)"}\n</conversation>`,
    context && `<workspace>\n${context}\n</workspace>`,
    request(last),
  ]
    .filter(Boolean)
    .join("\n\n");
  return {
    system: SYSTEM,
    user,
    tool: {
      name: SUGGEST_TOOL,
      description: tool.description,
      input_schema: tool.parameters as Anthropic.Tool["input_schema"],
    },
  };
}

export type CreateMessage = (params: Anthropic.MessageCreateParamsNonStreaming) => Promise<Anthropic.Message>;

/** Calls the Messages API, reading the key and base URL (gateways) from the environment. */
export const createMessage: CreateMessage = (params) =>
  new Anthropic({ timeout: 30_000, maxRetries: 1 }).messages.create(params);

/** The AG-UI events answering `input`: one copilotkitSuggest tool call, or a RUN_ERROR. */
export async function suggest(input: RunAgentInput, create: CreateMessage = createMessage): Promise<BaseEvent[]> {
  const { threadId, runId } = input;
  const started = { type: EventType.RUN_STARTED, threadId, runId } as BaseEvent;
  const prompt = suggestPrompt(input);
  if (!prompt) return [started, { type: EventType.RUN_ERROR, message: `Expected a ${SUGGEST_TOOL} request` } as BaseEvent];

  let args: unknown;
  try {
    const response = await create({
      model: suggestionsModel(),
      max_tokens: 800,
      system: prompt.system,
      messages: [{ role: "user", content: prompt.user }],
      tools: [prompt.tool],
      tool_choice: { type: "tool", name: SUGGEST_TOOL },
    });
    const call = response.content.find(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === SUGGEST_TOOL,
    );
    args = call?.input;
    if (!args) throw new Error("the model didn't call the suggestion tool");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[suggest] no suggestions: ${message}`);
    return [started, { type: EventType.RUN_ERROR, message } as BaseEvent];
  }

  const toolCallId = randomUUID();
  return [
    started,
    {
      type: EventType.TOOL_CALL_START,
      toolCallId,
      toolCallName: SUGGEST_TOOL,
      parentMessageId: randomUUID(),
    } as BaseEvent,
    { type: EventType.TOOL_CALL_ARGS, toolCallId, delta: JSON.stringify(args) } as BaseEvent,
    { type: EventType.TOOL_CALL_END, toolCallId } as BaseEvent,
    { type: EventType.RUN_FINISHED, threadId, runId } as BaseEvent,
  ];
}
