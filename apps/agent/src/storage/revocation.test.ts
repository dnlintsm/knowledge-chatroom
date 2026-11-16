/**
 * Revocation at tool boundaries (issue #255), through the real Claude Code
 * engine: a scripted Messages API stands in for the model, so the test can
 * count model turns. The tool revokes the user's membership while it runs.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";

import type { Storage } from "./index";
import { membershipHooks } from "./revocation";

const TOOL = "mcp__lab__long_task";

/**
 * A Messages API that calls the lab tool on the first chat turn and answers
 * in text on any later one; `turns` counts the chat turns (requests with tools).
 */
async function scriptedModel() {
  const turns: unknown[] = [];
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const { pathname } = new URL(req.url ?? "/", "http://localhost");
    const request = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf-8")) : {};
    if (pathname === "/v1/messages/count_tokens") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ input_tokens: 10 }));
    }
    const chat = Boolean(request.tools?.length);
    if (chat) turns.push(request);
    const callTool = chat && turns.length === 1;
    const id = `msg_${randomUUID().replace(/-/g, "")}`;
    if (request.stream === false) {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(
        JSON.stringify({
          id,
          type: "message",
          role: "assistant",
          model: request.model,
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 1 },
        }),
      );
    }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const send = (type: string, data: object) =>
      res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    send("message_start", {
      message: {
        id,
        type: "message",
        role: "assistant",
        model: request.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 1 },
      },
    });
    if (callTool) {
      send("content_block_start", {
        index: 0,
        content_block: {
          type: "tool_use",
          id: `toolu_${randomUUID().replace(/-/g, "")}`,
          name: TOOL,
          input: {},
        },
      });
      send("content_block_delta", {
        index: 0,
        delta: { type: "input_json_delta", partial_json: "{}" },
      });
    } else {
      send("content_block_start", {
        index: 0,
        content_block: { type: "text", text: "" },
      });
      send("content_block_delta", {
        index: 0,
        delta: { type: "text_delta", text: "Another turn." },
      });
    }
    send("content_block_stop", { index: 0 });
    send("message_delta", {
      delta: {
        stop_reason: callTool ? "tool_use" : "end_turn",
        stop_sequence: null,
      },
      usage: { output_tokens: 5 },
    });
    send("message_stop", {});
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    turns,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/**
 * Runs one prompt through the engine with the revocation hooks. The lab tool
 * ends as `outcome` says; with `revoke`, it removes the user while it runs.
 */
async function runWithTool(outcome: "ok" | "error", revoke: boolean) {
  const model = await scriptedModel();
  const cwd = await mkdtemp(path.join(os.tmpdir(), "revocation-test-"));
  let role: string | null = "member";
  const storage = () => ({ access: { membership: async () => role } }) as unknown as Storage;
  const hooks = membershipHooks(storage, "alice");
  let ran = 0;
  const lab = createSdkMcpServer({
    name: "lab",
    tools: [
      tool("long_task", "A task that takes a while", {}, async () => {
        ran++;
        if (revoke) role = null;
        if (outcome === "error")
          return {
            content: [{ type: "text", text: "the instrument failed" }],
            isError: true,
          };
        return { content: [{ type: "text", text: "the task finished" }] };
      }),
    ],
  });
  const messages: { type: string; subtype?: string; [key: string]: unknown }[] = [];
  try {
    for await (const message of query({
      prompt: "Run the long task.",
      options: {
        cwd,
        model: "claude-sonnet-4-5",
        tools: [],
        settingSources: [],
        mcpServers: { lab },
        allowedTools: [TOOL],
        hooks: {
          PreToolUse: [hooks.PreToolUse],
          PostToolBatch: [hooks.PostToolBatch],
        },
        maxTurns: 5,
        env: {
          ...process.env,
          ANTHROPIC_BASE_URL: model.url,
          ANTHROPIC_API_KEY: "test-key",
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        },
      },
    })) {
      messages.push(message as never);
    }
  } finally {
    await model.close();
    await rm(cwd, { recursive: true, force: true });
  }
  return { turns: model.turns.length, ran, messages };
}

const toolResults = (messages: { type: string; message?: unknown }[]) =>
  JSON.stringify(messages.filter((m) => m.type === "user").map((m) => m.message));

for (const outcome of ["ok", "error"] as const) {
  test(`a run whose user is removed during a tool call (${outcome}) ends after that call, with no further model turn (#255)`, async () => {
    const run = await runWithTool(outcome, true);
    assert.equal(run.ran, 1, "the accepted call runs to its end");
    assert.match(
      toolResults(run.messages),
      outcome === "ok" ? /the task finished/ : /the instrument failed/,
      "its result is kept",
    );
    assert.equal(run.turns, 1, "the model gets no turn after the call");
    assert.ok(!JSON.stringify(run.messages).includes("Another turn."));
    const result = run.messages.find((m) => m.type === "result");
    assert.equal(result?.terminal_reason, "hook_stopped", "the revocation hook ended the run");
  });
}

test("a run whose user stays a member continues after the call (the control)", async () => {
  const run = await runWithTool("ok", false);
  assert.equal(run.ran, 1);
  assert.equal(run.turns, 2, "the model answers the tool's result");
});
