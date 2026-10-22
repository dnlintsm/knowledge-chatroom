import { test, expect } from "@playwright/test";
import { firstValueFrom, toArray, type Observable } from "rxjs";
import type { AbstractAgent, BaseEvent, Message, RunAgentInput } from "@ag-ui/client";

import { IDENTITY_HEADER, identityHeader } from "../../src/lib/auth";
import { handleChatRoute } from "../../src/lib/chat-routes";
import { ChatRunner, chatName } from "../../src/lib/chat-runner";
import { AutoChatStore, MemoryChatStore, type ChatStore } from "../../src/lib/chat-store";

/** An agent that answers every run with `reply`, as the runtime's per-request clone would. */
function fakeAgent(reply: string, headers: Record<string, string> = {}, agentId = "default") {
  const agent = {
    agentId,
    headers,
    messages: [] as Message[],
    aborted: false,
    abortRun() {
      agent.aborted = true;
    },
    async runAgent(input: RunAgentInput, { onEvent }: { onEvent: (p: { event: BaseEvent }) => void }) {
      const send = (event: Record<string, unknown>) => onEvent({ event: event as unknown as BaseEvent });
      const messageId = `a-${input.runId}`;
      send({ type: "RUN_STARTED", threadId: input.threadId, runId: input.runId });
      send({ type: "TEXT_MESSAGE_START", messageId, role: "assistant" });
      send({ type: "TEXT_MESSAGE_CONTENT", messageId, delta: reply });
      send({ type: "TEXT_MESSAGE_END", messageId });
      send({ type: "RUN_FINISHED", threadId: input.threadId, runId: input.runId });
      agent.messages = [...input.messages, { id: messageId, role: "assistant", content: reply }];
    },
  };
  return agent;
}

const input = (threadId: string, runId: string, messages: Message[]): RunAgentInput => ({
  threadId,
  runId,
  messages,
  state: {},
  tools: [],
  context: [],
  forwardedProps: {},
});

const all = (events: Observable<BaseEvent>) => firstValueFrom(events.pipe(toArray()));
const texts = (events: BaseEvent[]) =>
  events.filter((e) => e.type === "TEXT_MESSAGE_CONTENT").map((e) => (e as unknown as { delta: string }).delta);

test("names a chat after the first thing asked", () => {
  expect(chatName([{ id: "1", role: "user", content: "  What is\nin my notes?  " }])).toBe("What is in my notes?");
  expect(chatName([{ id: "1", role: "user", content: [{ type: "text", text: "From parts" }] } as Message])).toBe(
    "From parts",
  );
  expect(chatName([{ id: "1", role: "assistant", content: "Hi" }])).toBeNull();
  expect(chatName([{ id: "1", role: "user", content: "x".repeat(200) }])!.length).toBe(80);
});

test("a chat survives a new runner and replays when connected again", async () => {
  const store = new MemoryChatStore();
  const ask: Message = { id: "u1", role: "user", content: "Hello there" };
  const first = new ChatRunner(store);
  await all(first.run({ threadId: "t1", agent: fakeAgent("Hi!") as unknown as AbstractAgent, input: input("t1", "r1", [ask]) }));

  // As after a restart: a new runner, the same store.
  const second = new ChatRunner(store);
  expect(texts(await all(second.connect({ threadId: "t1" })))).toEqual(["Hi!"]);

  const again: Message = { id: "u2", role: "user", content: "And again" };
  const agent = fakeAgent("Again!");
  await all(second.run({ threadId: "t1", agent: agent as unknown as AbstractAgent, input: input("t1", "r2", [ask, { id: "a-r1", role: "assistant", content: "Hi!" }, again]) }));
  const runs = await store.runs(null, "t1");
  expect(runs.map((r) => [r.runId, r.parentRunId])).toEqual([["r1", null], ["r2", "r1"]]);
  // The second run's start records only the message it adds.
  const started = runs[1].events.find((e) => (e as BaseEvent).type === "RUN_STARTED") as { input: { messages: Message[] } };
  expect(started.input.messages.map((m) => m.id)).toEqual(["u2"]);

  const { threads } = await store.list(null, { agentId: "default" });
  expect(threads.map((t) => [t.id, t.name])).toEqual([["t1", "Hello there"]]);
  expect((await store.get(null, "t1"))!.messages).toHaveLength(4);
});

test("the follow-up chips' runs are not kept", async () => {
  const store = new MemoryChatStore();
  const runner = new ChatRunner(store);
  const agent = fakeAgent("chips", {}, "suggester");
  await all(runner.run({ threadId: "s1", agent: agent as unknown as AbstractAgent, input: input("s1", "r1", []) }));
  expect((await store.list(null, {})).threads).toEqual([]);
});

test("without server storage, memory stands in until the agent server says which", async () => {
  const server = new MemoryChatStore();
  const memory = new MemoryChatStore();
  let status: number | null = null;
  const store = new AutoChatStore(server, memory, async () => status);
  await store.save(null, "early", { agentId: "default", runId: "r", parentRunId: null, events: [], messages: [], name: "Early" });
  expect((await memory.list(null, {})).threads).toHaveLength(1);
  status = 401; // storage on, login on
  await store.save(null, "later", { agentId: "default", runId: "r", parentRunId: null, events: [], messages: [], name: "Later" });
  expect((await server.list(null, {})).threads.map((t) => t.id)).toEqual(["later"]);
  status = 404; // remembered: no more asking
  expect((await store.list(null, {})).threads.map((t) => t.id)).toEqual(["later"]);
});

test.describe("with login on", () => {
  const LOGIN_ENV = {
    AUTH_MODE: "oidc",
    AUTH_SECRET: "unit-test-secret-0123456789abcdef0123456789",
    OIDC_ISSUER: "https://login.example.com",
    OIDC_CLIENT_ID: "knowledge-chatroom",
  };
  const saved: Record<string, string | undefined> = {};
  test.beforeAll(() => {
    for (const [key, value] of Object.entries(LOGIN_ENV)) {
      saved[key] = process.env[key];
      process.env[key] = value;
    }
  });
  test.afterAll(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const ana = { sub: "https://login.example.com|ana", name: "Ana" };
  const ben = { sub: "https://login.example.com|ben", name: "Ben" };
  const as = (user: typeof ana) => ({ [IDENTITY_HEADER]: identityHeader(user) });

  test("each user has their own chats", async () => {
    const store: ChatStore = new MemoryChatStore();
    const runner = new ChatRunner(store);
    const ask: Message = { id: "u1", role: "user", content: "Ana's question" };
    await all(runner.run({ threadId: "ana-1", agent: fakeAgent("For Ana", as(ana)) as unknown as AbstractAgent, input: input("ana-1", "r1", [ask]) }));

    // Ben can't read it, list it, or take over its id.
    expect(await all(runner.connect({ threadId: "ana-1", headers: as(ben) }))).toEqual([]);
    expect((await store.list(ben, {})).threads).toEqual([]);
    const taken = await all(
      runner.run({ threadId: "ana-1", agent: fakeAgent("For Ben", as(ben)) as unknown as AbstractAgent, input: input("ana-1", "r2", []) }),
    );
    expect(taken.map((e) => e.type)).toEqual(["RUN_ERROR"]);
    expect((await store.runs(ana, "ana-1")).map((r) => r.runId)).toEqual(["r1"]);

    // Without a signed header nobody runs.
    const anonymous = await all(runner.run({ threadId: "x", agent: fakeAgent("?") as unknown as AbstractAgent, input: input("x", "r", []) }));
    expect(anonymous.map((e) => e.type)).toEqual(["RUN_ERROR"]);

    // The history routes answer for the asking user only.
    const route = (method: string, path: string, user: typeof ana, body?: unknown) =>
      handleChatRoute(
        new Request(`http://app/api/copilotkit${path}`, { method, body: body ? JSON.stringify(body) : undefined }),
        path.split("?")[0],
        user,
        store,
      );
    const listed = await (await route("GET", "/threads?agentId=default", ana))!.json();
    expect(listed.threads.map((t: { id: string; name: string }) => [t.id, t.name])).toEqual([["ana-1", "Ana's question"]]);
    expect((await (await route("GET", "/threads?agentId=default", ben))!.json()).threads).toEqual([]);
    expect((await route("PATCH", "/threads/ana-1", ben, { name: "Mine" }))!.status).toBe(404);
    expect((await route("DELETE", "/threads/ana-1", ben))!.status).toBe(404);
    expect((await (await route("GET", "/threads/ana-1/messages", ben))!.json()).messages).toEqual([]);
    const messages = (await (await route("GET", "/threads/ana-1/messages", ana))!.json()).messages;
    expect(messages.map((m: { content: string }) => m.content)).toEqual(["Ana's question", "For Ana"]);

    expect((await route("PATCH", "/threads/ana-1", ana, { name: "Renamed" }))!.status).toBe(200);
    expect((await route("POST", "/threads/ana-1/archive", ana))!.status).toBe(200);
    expect((await (await route("GET", "/threads?agentId=default", ana))!.json()).threads).toEqual([]);
    const archived = await (await route("GET", "/threads?agentId=default&includeArchived=true", ana))!.json();
    expect(archived.threads.map((t: { name: string; archived: boolean }) => [t.name, t.archived])).toEqual([["Renamed", true]]);
    expect((await route("POST", "/threads/clear", ana))!.status).toBe(204);
    expect((await route("DELETE", "/threads/ana-1", ana))!.status).toBe(200);
    expect(await store.get(ana, "ana-1")).toBeNull();
    expect(await route("POST", "/agent/default/run", ana)).toBeNull();
  });
});
