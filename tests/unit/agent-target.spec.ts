import { test, expect } from "@playwright/test";
import {
  chatAgentUrl,
  localAgentUrl,
  localSuggester,
  remoteAgentUrl,
} from "../../src/lib/agent-target";
import { identityHeader, readIdentityHeader } from "../../src/lib/auth";
import {
  CHATROOM_PROPS,
  LOCAL_USER,
  chatroomPlace,
  withChatroomUser,
  type ChatroomProps,
} from "../../src/lib/chatroom-props";

/**
 * Which agent the chat talks to (src/lib/agent-target.ts) and what each run
 * tells it (src/lib/chatroom-props.ts); docs/remote-agent.md is the contract.
 */

test("without AGENT_URL the chat uses this repo's agent server", () => {
  expect(remoteAgentUrl({})).toBeNull();
  expect(chatAgentUrl({})).toBe("http://localhost:8000/");
  expect(chatAgentUrl({ LOCAL_AGENT_URL: "http://agent:8000/" })).toBe("http://agent:8000/");
  // Blank counts as unset, as docker compose passes ${AGENT_URL:-}.
  expect(chatAgentUrl({ AGENT_URL: "  " })).toBe("http://localhost:8000/");
});

test("AGENT_URL sends the chat to the backend's /agent/report", () => {
  const env = { AGENT_URL: "https://backend.internal:9000/", LOCAL_AGENT_URL: "http://agent:8000" };
  expect(chatAgentUrl(env)).toBe("https://backend.internal:9000/agent/report");
  expect(chatAgentUrl({ AGENT_URL: "http://host/api" })).toBe("http://host/api/agent/report");
  // Storage and skills stay on this repo's server.
  expect(localAgentUrl(env)).toBe("http://agent:8000");
  expect(localAgentUrl({ AGENT_URL: "http://host" })).toBe("http://localhost:8000");
});

test("follow-up chips come from this repo's agent only without a remote backend", () => {
  expect(localSuggester({})).toBe(true);
  expect(localSuggester({ CHAT_SUGGESTIONS: "Static" })).toBe(false);
  expect(localSuggester({ AGENT_URL: "http://backend" })).toBe(false);
});

const etch = { id: "n1", name: "Etch", type: "tech" };
const module3 = { id: "n2", name: "Module 3", type: "module" };

test("the place: root, node path, experiment (a run) and open file", () => {
  expect(
    chatroomPlace({ storage: "local", lineage: [], experiment: null, report: null, selectedPath: null }),
  ).toEqual({
    version: 2,
    storage: "local",
    node: null,
    experiment: null,
    selected_path: null,
  });

  const place = chatroomPlace({
    storage: "server",
    lineage: [etch, module3],
    experiment: { id: "x1", nodeId: "n2", title: "Lower RF", status: "draft", state: "done", access: "writer" },
    report: "report.md",
    selectedPath: "report.md",
  });
  expect(place.node).toEqual({ ...module3, path: [etch, module3] });
  expect(place.experiment).toEqual({
    id: "x1", node_id: "n2", title: "Lower RF", status: "draft", state: "done", can_change: true, report: "report.md",
  });
  expect(place).not.toHaveProperty("run_dir");
  expect(place.selected_path).toBe("report.md");

  // A run at the workspace root has no node.
  const atRoot = chatroomPlace({
    storage: "server",
    lineage: [],
    experiment: { id: "x2", nodeId: null, title: "Uploads", status: "draft", state: "ready", access: "reader" },
    report: null,
    selectedPath: null,
  });
  expect([atRoot.node, atRoot.experiment?.node_id, atRoot.experiment?.can_change]).toEqual([null, null, false]);
});

test("the server's user replaces whatever the browser sent, and the rest is kept", () => {
  const place = chatroomPlace({ storage: "server", lineage: [etch], experiment: null, report: null, selectedPath: "a.md" });
  const user = { id: "https://login.example.com|42", email: "a@example.com", name: "A", signed_in: true };
  const input = {
    threadId: "t1",
    forwardedProps: {
      a2uiCatalogAvailable: true,
      [CHATROOM_PROPS]: { ...place, user: { id: "someone-else", email: null, name: null, signed_in: true } },
    },
  };
  const out = withChatroomUser(input, user);
  expect(out.threadId).toBe("t1");
  expect(out.forwardedProps.a2uiCatalogAvailable).toBe(true);
  expect(out.forwardedProps[CHATROOM_PROPS]).toEqual({ ...place, user } satisfies ChatroomProps);
  // The input itself is left alone.
  expect((input.forwardedProps[CHATROOM_PROPS] as ChatroomProps).user?.id).toBe("someone-else");

  // Runs without a place (e.g. before the workspace loads) still name the user.
  expect(withChatroomUser({}, LOCAL_USER).forwardedProps).toEqual({ [CHATROOM_PROPS]: { version: 2, user: LOCAL_USER } });
  expect(withChatroomUser({ forwardedProps: null }, null).forwardedProps).toEqual({
    [CHATROOM_PROPS]: { version: 2, user: null },
  });
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

  test("the run's user is read only from a header this app signed", () => {
    const ana = { sub: "https://login.example.com|42", email: "ana@example.com", name: "Ana" };
    expect(readIdentityHeader(identityHeader(ana))).toEqual(ana);

    const [kind, payload, signature] = identityHeader(ana).split(".");
    const forged = Buffer.from(JSON.stringify({ ...ana, sub: "someone-else", exp: 9e9 })).toString("base64url");
    expect(readIdentityHeader(`${kind}.${forged}.${signature}`)).toBeNull();
    expect(readIdentityHeader(`${kind}.${payload}`)).toBeNull();
    expect(readIdentityHeader(undefined)).toBeNull();
  });
});
