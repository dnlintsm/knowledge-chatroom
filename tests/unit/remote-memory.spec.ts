import { test, expect } from "@playwright/test";
import type { RunAgentInput } from "@ag-ui/client";

import { MEMORY_AUDIENCE, STORAGE_AUDIENCE, readIdentityToken } from "@knowledge-chatroom/contracts/identity-token";
import { createDefaultAgent, createSuggesterAgent } from "../../apps/web/src/agent";
import { IDENTITY_HEADER, identityHeader, readIdentityHeader, storageHeader } from "../../apps/web/src/lib/auth";

/**
 * A remote backend's chat agent gets an X-Knowledge-Memory token for the run's
 * chat (apps/web/src/agent.ts), so it can use the user's
 * memory there through the agent server's /memory/agent.
 */

const SECRET = "unit-test-secret-0123456789abcdef0123456789";
const LOGIN_ENV = {
  AUTH_MODE: "oidc",
  AUTH_SECRET: SECRET,
  OIDC_ISSUER: "https://login.example.com",
  OIDC_CLIENT_ID: "knowledge-chatroom",
};
const NODE = "0b6f3c1e-8a7d-4e5f-9c2b-1d3e5f7a9b0c";

const input = (threadId = "t1"): RunAgentInput => ({
  threadId,
  runId: "r1",
  state: {},
  messages: [],
  tools: [],
  context: [],
  forwardedProps: { knowledge_chatroom: { version: 2, node: { id: NODE, title: "A node" } } },
});

type WithInit = { requestInit(input: RunAgentInput): RequestInit; headers: Record<string, string> };

function memoryHeaderOf(agent: unknown, headers: Record<string, string> = {}): string | null {
  const a = agent as WithInit;
  a.headers = headers;
  return new Headers(a.requestInit(input()).headers).get("x-knowledge-memory");
}

test.describe("memory tokens for a remote chat agent", () => {
  const saved: Record<string, string | undefined> = {};
  const keys = ["AGENT_URL", "AUTH_MODE", "AUTH_SECRET", "OIDC_ISSUER", "OIDC_CLIENT_ID"];

  test.beforeEach(() => {
    for (const key of keys) saved[key] = process.env[key];
    process.env.AGENT_URL = "http://agent-py.test:9300";
  });

  test.afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test("with login: signed for the user, the chat and its node, via remote", () => {
    Object.assign(process.env, LOGIN_ENV);
    const user = { sub: "kc|alice", email: "alice@example.com", name: "Alice" };
    const token = memoryHeaderOf(createDefaultAgent(), { [IDENTITY_HEADER]: identityHeader(user) });
    const claims = readIdentityToken(token ?? undefined, SECRET);
    expect(claims).toMatchObject({ ...user, aud: MEMORY_AUDIENCE, via: "remote", thread: "t1", node: NODE });
    // Not an identity token.
    expect(readIdentityHeader(token ?? undefined)).toBeNull();
  });

  test("with login but no signed user: none", () => {
    Object.assign(process.env, LOGIN_ENV);
    expect(memoryHeaderOf(createDefaultAgent())).toBeNull();
  });

  test("without login: the local form", () => {
    process.env.AUTH_MODE = "local";
    delete process.env.AUTH_SECRET;
    const token = memoryHeaderOf(createDefaultAgent());
    expect(token?.startsWith("local.")).toBe(true);
    const claims = JSON.parse(Buffer.from(token!.slice("local.".length), "base64url").toString("utf8"));
    expect(claims).toEqual({ via: "remote", thread: "t1", node: NODE });
  });

  test("bound to the run's workspace when the page names one", () => {
    const ws = "11111111-2222-4333-8444-555555555555";
    process.env.AUTH_MODE = "local";
    delete process.env.AUTH_SECRET;
    const local = memoryHeaderOf(createDefaultAgent(), { "x-knowledge-workspace": ws });
    expect(JSON.parse(Buffer.from(local!.slice("local.".length), "base64url").toString("utf8"))).toEqual({
      via: "remote",
      thread: "t1",
      node: NODE,
      ws,
    });

    Object.assign(process.env, LOGIN_ENV);
    const user = { sub: "kc|alice", email: "alice@example.com", name: "Alice" };
    const signed = memoryHeaderOf(createDefaultAgent(), { [IDENTITY_HEADER]: identityHeader(user), "x-knowledge-workspace": ws });
    expect(readIdentityToken(signed ?? undefined, SECRET)).toMatchObject({ aud: MEMORY_AUDIENCE, thread: "t1", ws });
    const storage = readIdentityToken(storageHeader(user, "remote", ws), SECRET);
    expect(storage).toMatchObject({ aud: STORAGE_AUDIENCE, via: "remote", ws });
    expect(readIdentityToken(storageHeader(user, "remote"), SECRET)).not.toHaveProperty("ws");
  });

  test("only for the remote chat agent", () => {
    process.env.AUTH_MODE = "local";
    delete process.env.AUTH_SECRET;
    expect(memoryHeaderOf(createSuggesterAgent())).toBeNull();
    // AGENT_URL=local: the legacy agent server's own chat needs no memory token.
    process.env.AGENT_URL = "local";
    expect(memoryHeaderOf(createDefaultAgent())).toBeNull();
  });
});
