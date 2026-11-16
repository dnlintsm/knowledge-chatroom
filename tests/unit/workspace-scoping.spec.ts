import { test, expect } from "@playwright/test";
import { firstValueFrom, toArray, type Observable } from "rxjs";
import type { AbstractAgent, BaseEvent, Message, RunAgentInput } from "@ag-ui/client";

import {
  NODE_KEY,
  PLACE_UI_KEY,
  SERVER_SEEDED_KEY,
  moveLegacyState,
  scopedKey,
  scopedStorage,
  type SavedStateScope,
} from "../../apps/web/src/components/workspace/local-persistence";
import { handleChatRoute } from "../../apps/web/src/lib/chat-routes";
import { ChatRunner } from "../../apps/web/src/lib/chat-runner";
import { AgentChatStore, AutoChatStore, MemoryChatStore } from "../../apps/web/src/lib/chat-store";
import { defaultWorkspacePath, findWorkspace, homeWorkspacePath } from "../../apps/web/src/lib/workspaces";

/** Saved state, chats and the page's workspace, per workspace (issue #226, docs/workspaces.md). */

const WS1 = "11111111-2222-4333-8444-555555555555";
const WS2 = "66666666-7777-4888-9999-aaaaaaaaaaaa";

class FakeStorage {
  readonly items = new Map<string, string>();
  getItem = (key: string) => this.items.get(key) ?? null;
  setItem = (key: string, value: string) => void this.items.set(key, value);
  removeItem = (key: string) => void this.items.delete(key);
}

test.describe("saved browser state", () => {
  const ana: SavedStateScope = { user: "kc|ana", workspace: WS1, isDefault: true };
  const anaElsewhere: SavedStateScope = { user: "kc|ana", workspace: WS2, isDefault: false };
  const ben: SavedStateScope = { user: "kc|ben", workspace: WS1, isDefault: true };

  test("is kept per user and workspace; browser preferences aren't", () => {
    const storage = new FakeStorage();
    scopedStorage(storage, ana).setItem(NODE_KEY, "node-a");
    scopedStorage(storage, anaElsewhere).setItem(NODE_KEY, "node-b");
    scopedStorage(storage, ana).setItem("knowledge-chatroom.layout.v1", "wide");

    expect(scopedStorage(storage, ana).getItem(NODE_KEY)).toBe("node-a");
    expect(scopedStorage(storage, anaElsewhere).getItem(NODE_KEY)).toBe("node-b");
    expect(scopedStorage(storage, ben).getItem(NODE_KEY)).toBeNull();
    expect(storage.getItem(NODE_KEY)).toBeNull();
    expect(storage.getItem(scopedKey(NODE_KEY, ana))).toBe("node-a");
    expect(scopedKey(NODE_KEY, ana)).toBe(`${NODE_KEY}@kc%7Cana/${WS1}`);
    // Not a workspace's state: the same key for everyone.
    expect(storage.getItem("knowledge-chatroom.layout.v1")).toBe("wide");
    // Without workspaces, the keys as before.
    expect(scopedStorage(storage, null)).toBe(storage);
  });

  test("moves into the default workspace once", () => {
    const storage = new FakeStorage();
    storage.setItem(NODE_KEY, "legacy-node");
    storage.setItem(PLACE_UI_KEY, "{}");
    storage.setItem("knowledge-chatroom.layout.v1", "wide");

    moveLegacyState(storage, anaElsewhere); // not the default: nothing moves
    expect(storage.getItem(NODE_KEY)).toBe("legacy-node");

    scopedStorage(storage, ana).setItem(PLACE_UI_KEY, '{"saved":"here"}');
    moveLegacyState(storage, ana);
    expect(scopedStorage(storage, ana).getItem(NODE_KEY)).toBe("legacy-node");
    // State already saved there wins.
    expect(scopedStorage(storage, ana).getItem(PLACE_UI_KEY)).toBe('{"saved":"here"}');
    expect(storage.getItem(NODE_KEY)).toBeNull();
    expect(storage.getItem(PLACE_UI_KEY)).toBeNull();
    expect(storage.getItem("knowledge-chatroom.layout.v1")).toBe("wide");

    // Once: the next user finds nothing to take over.
    moveLegacyState(storage, ben);
    expect(scopedStorage(storage, ben).getItem(NODE_KEY)).toBeNull();
    expect(scopedStorage(storage, ben).getItem(SERVER_SEEDED_KEY)).toBeNull();
  });
});

test.describe("the page's workspace", () => {
  const originalFetch = globalThis.fetch;
  test.afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const answer = (status: number, body?: unknown) => {
    globalThis.fetch = (async () =>
      body === undefined ? new Response(null, { status }) : Response.json(body, { status })) as typeof fetch;
  };
  const listed = {
    workspaces: [
      { id: WS1, slug: "default", name: "Default", role: "member" },
      { id: WS2, slug: "research", name: "Research", role: "owner" },
      { id: "x", slug: "broken", name: "Broken" },
    ],
  };

  test("is found by slug among the user's own", async () => {
    answer(200, listed);
    expect(await findWorkspace(null, "Research", "http://agent.test")).toEqual({
      status: "found",
      workspace: { id: WS2, slug: "research", name: "Research", role: "owner" },
    });
    // A miss names nothing of what was asked for, and lists the user's own.
    const mine = listed.workspaces.slice(0, 2);
    expect(await findWorkspace(null, "elsewhere", "http://agent.test")).toEqual({ status: "missing", mine, canCreate: true });
    expect(await findWorkspace(null, "broken", "http://agent.test")).toEqual({ status: "missing", mine, canCreate: true });
    // With whether they may create one (WORKSPACE_CREATORS); a server that doesn't say lets them.
    answer(200, { workspaces: [], canCreate: false });
    expect(await findWorkspace(null, "default", "http://agent.test")).toEqual({ status: "missing", mine: [], canCreate: false });
  });

  test("is unavailable without the workspaces API, or without an answer", async () => {
    answer(404, { error: "Not found" });
    expect(await findWorkspace(null, "default", "http://agent.test")).toEqual({ status: "unavailable", reason: "none" });
    answer(503, { error: "Storage is starting" });
    expect(await findWorkspace(null, "default", "http://agent.test")).toEqual({ status: "unavailable", reason: "down" });
    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    expect(await findWorkspace(null, "default", "http://agent.test")).toEqual({ status: "unavailable", reason: "down" });
  });

  test("URLs without one go to the default workspace, keeping their query", () => {
    expect(defaultWorkspacePath()).toBe("/w/default");
    expect(defaultWorkspacePath("experiment=e1&list=all")).toBe("/w/default?experiment=e1&list=all");
    expect(defaultWorkspacePath("?experiment=e1")).toBe("/w/default?experiment=e1");
  });

  test("/ goes to the default workspace when the user is in it, otherwise to their first", async () => {
    answer(200, listed);
    expect(await homeWorkspacePath(null, "list=all", "http://agent.test")).toBe("/w/default?list=all");
    answer(200, { workspaces: [listed.workspaces[1]] });
    expect(await homeWorkspacePath(null, "list=all", "http://agent.test")).toBe("/w/research?list=all");
    // None of their own (that page offers to create one), or no answer.
    answer(200, { workspaces: [] });
    expect(await homeWorkspacePath(null, "", "http://agent.test")).toBe("/w/default");
    answer(404, { error: "Not found" });
    expect(await homeWorkspacePath(null, "", "http://agent.test")).toBe("/w/default");
  });
});

function fakeAgent(reply: string, headers: Record<string, string>) {
  return {
    agentId: "default",
    headers,
    messages: [] as Message[],
    abortRun() {},
    async runAgent(input: RunAgentInput, { onEvent }: { onEvent: (p: { event: BaseEvent }) => void }) {
      const send = (event: Record<string, unknown>) => onEvent({ event: event as unknown as BaseEvent });
      const messageId = `a-${input.runId}`;
      send({ type: "RUN_STARTED", threadId: input.threadId, runId: input.runId });
      send({ type: "TEXT_MESSAGE_START", messageId, role: "assistant" });
      send({ type: "TEXT_MESSAGE_CONTENT", messageId, delta: reply });
      send({ type: "TEXT_MESSAGE_END", messageId });
      send({ type: "RUN_FINISHED", threadId: input.threadId, runId: input.runId });
      this.messages = [...input.messages, { id: messageId, role: "assistant", content: reply }];
    },
  };
}

const runInput = (threadId: string, runId: string, messages: Message[]): RunAgentInput => ({
  threadId,
  runId,
  messages,
  state: {},
  tools: [],
  context: [],
  forwardedProps: {},
});
const all = (events: Observable<BaseEvent>) => firstValueFrom(events.pipe(toArray()));
const inWs = (ws: string) => ({ "x-knowledge-workspace": ws });

test.describe("chats", () => {
  test("are kept in the workspace the run started in", async () => {
    const store = new MemoryChatStore();
    const runner = new ChatRunner(store);
    const ask: Message = { id: "u1", role: "user", content: "In research" };
    const agent = fakeAgent("Answer", inWs(WS2)) as unknown as AbstractAgent;
    await all(runner.run({ threadId: "c1", agent, input: runInput("c1", "r1", [ask]) }));

    expect((await store.inWorkspace(WS2).list(null, {})).threads.map((t) => t.id)).toEqual(["c1"]);
    expect((await store.inWorkspace(WS1).list(null, {})).threads).toEqual([]);
    expect((await store.list(null, {})).threads).toEqual([]); // the default workspace's

    // Connecting from another workspace replays nothing.
    expect(await all(runner.connect({ threadId: "c1", headers: inWs(WS1) }))).toEqual([]);
    expect((await all(runner.connect({ threadId: "c1", headers: inWs(WS2) }))).length).toBeGreaterThan(0);

    // The history routes answer for the asked workspace only.
    const route = (path: string, ws: string) =>
      handleChatRoute(new Request(`http://app/api/copilotkit${path}`), path, null, store.inWorkspace(ws));
    expect((await (await route("/threads", WS2))!.json()).threads.map((t: { id: string }) => t.id)).toEqual(["c1"]);
    expect((await (await route("/threads", WS1))!.json()).threads).toEqual([]);
    expect((await (await route("/threads/c1/messages", WS1))!.json()).messages).toEqual([]);
  });

  test("a run that names no workspace by id is refused", async () => {
    const runner = new ChatRunner(new MemoryChatStore());
    const agent = fakeAgent("?", { "x-knowledge-workspace": "research" }) as unknown as AbstractAgent;
    const events = await all(runner.run({ threadId: "c2", agent, input: runInput("c2", "r1", []) }));
    expect(events.map((e) => [e.type, (e as { message?: string }).message])).toEqual([["RUN_ERROR", "Workspace not found"]]);
  });

  test("the agent server's store names the workspace", async () => {
    const originalFetch = globalThis.fetch;
    const sent: Headers[] = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      sent.push(new Headers(init?.headers));
      return Response.json({ threads: [], nextCursor: null });
    }) as typeof fetch;
    try {
      const store = new AgentChatStore("http://agent.test");
      await store.list(null, {});
      await store.inWorkspace(WS2).list(null, {});
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(sent.map((h) => h.get("x-knowledge-workspace"))).toEqual([null, WS2]);
  });

  test("chats kept in memory move to the server in their workspace", async () => {
    const server = new MemoryChatStore();
    const memory = new MemoryChatStore();
    let status: number | null = null;
    const store = new AutoChatStore(server, memory, async () => status);
    const run = (name: string) => ({ agentId: "default", runId: "r", parentRunId: null, events: [], messages: [], name });
    await store.inWorkspace(WS2).save(null, "early", run("Early"));
    status = 401;
    await store.save(null, "later", run("Later"));
    expect((await server.inWorkspace(WS2).list(null, {})).threads.map((t) => t.id)).toEqual(["early"]);
    expect((await server.list(null, {})).threads.map((t) => t.id)).toEqual(["later"]);
    expect((await store.inWorkspace(WS2).list(null, {})).threads.map((t) => t.id)).toEqual(["early"]);
  });
});
