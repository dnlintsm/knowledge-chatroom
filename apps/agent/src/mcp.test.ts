import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { allowServer, chipsFrom, externalServersFromEnv, serverConfigs, withToolChips } from "./mcp";
import { signIdentity, verifyIdentity } from "./storage/identity";

const quiet = <T>(fn: () => T): T => {
  const { error, warn } = console;
  console.error = console.warn = () => {};
  try {
    return fn();
  } finally {
    Object.assign(console, { error, warn });
  }
};

test("no MCP_SERVERS means no outside servers", () => {
  assert.deepEqual(externalServersFromEnv({}), {});
});

test("reads .mcp.json-shaped JSON, http by default, ${VAR} from the environment", () => {
  const servers = externalServersFromEnv({
    LAB_TOKEN: "s3cret",
    MCP_SERVERS: JSON.stringify({
      mcpServers: {
        lab: { url: "http://lab:9000/mcp", headers: { Authorization: "Bearer ${LAB_TOKEN}" }, forwardIdentity: true },
        local: { type: "stdio", command: "python", args: ["tools.py"], env: { KEY: "${LAB_TOKEN}" } },
      },
    }),
  });
  assert.deepEqual(servers.lab, {
    config: { type: "http", url: "http://lab:9000/mcp", headers: { Authorization: "Bearer s3cret" }, alwaysLoad: true },
    forwardIdentity: true,
    storageAccess: false,
    memoryAccess: false,
  });
  assert.deepEqual(servers.local, {
    config: { type: "stdio", command: "python", args: ["tools.py"], env: { KEY: "s3cret" } },
    forwardIdentity: false,
    storageAccess: false,
    memoryAccess: false,
  });
  assert.equal(allowServer("lab"), "mcp__lab");
});

test("reads a file path and a bare map", () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "mcp-")), "servers.json");
  writeFileSync(file, JSON.stringify({ lab: { type: "sse", url: "https://lab/sse" } }));
  assert.equal(externalServersFromEnv({ MCP_SERVERS: file }).lab?.config.type, "sse");
});

test("bad entries are left out, good ones kept", () => {
  const servers = quiet(() =>
    externalServersFromEnv({
      MCP_SERVERS: JSON.stringify({
        ok: { url: "http://ok/mcp" },
        copilotkit: { url: "http://x/mcp" },
        "bad name": { url: "http://x/mcp" },
        noUrl: { type: "http" },
        ftp: { url: "ftp://x" },
        weird: { type: "websocket", url: "http://x" },
        stdioIdentity: { type: "stdio", command: "x", forwardIdentity: true },
        stdioStorage: { type: "stdio", command: "x", storageAccess: true },
        spoof: { url: "http://x/mcp", headers: { "X-Knowledge-User": "someone" } },
        spoofStorage: { url: "http://x/mcp", headers: { "X-Knowledge-Storage": "someone" } },
      }),
    }),
  );
  assert.deepEqual(Object.keys(servers), ["ok"]);
  assert.deepEqual(quiet(() => externalServersFromEnv({ MCP_SERVERS: "{not json" })), {});
});

test("only forwardIdentity servers get the run's identity", () => {
  const servers = externalServersFromEnv({
    MCP_SERVERS: JSON.stringify({
      lab: { url: "http://lab/mcp", forwardIdentity: true, headers: { A: "1" } },
      other: { url: "http://other/mcp" },
    }),
  });
  const configs = serverConfigs(servers, (server, kind) => `${kind}-for-${server}`);
  assert.deepEqual((configs.lab as { headers?: object }).headers, { A: "1", "x-knowledge-user": "identity-for-lab" });
  assert.equal((configs.other as { headers?: object }).headers, undefined);
  // Outside a run (no identity) nothing is added.
  assert.deepEqual((serverConfigs(servers).lab as { headers?: object }).headers, { A: "1" });
});

test("memoryAccess servers get the run's memory token, when it has one", () => {
  const servers = externalServersFromEnv({
    MCP_SERVERS: JSON.stringify({
      lab: { url: "http://lab/mcp", memoryAccess: true },
      other: { url: "http://other/mcp", storageAccess: true },
    }),
  });
  const configs = serverConfigs(servers, (server, kind) => (kind === "memory" ? `memory-for-${server}` : null));
  assert.deepEqual((configs.lab as { headers?: object }).headers, { "x-knowledge-memory": "memory-for-lab" });
  // No token of a kind (no login, or memory off in the chat): no header.
  assert.equal((configs.other as { headers?: object }).headers, undefined);
  assert.deepEqual(
    quiet(() => externalServersFromEnv({ MCP_SERVERS: JSON.stringify({ s: { type: "stdio", command: "x", memoryAccess: true } }) })),
    {},
  );
  assert.deepEqual(
    quiet(() => externalServersFromEnv({ MCP_SERVERS: JSON.stringify({ h: { url: "http://h/mcp", headers: { "X-Knowledge-Memory": "x" } } }) })),
    {},
  );
});

test("tokens signed for an MCP server aren't accepted by the agent", () => {
  const secret = "s".repeat(32);
  const exp = Math.floor(Date.now() / 1000) + 60;
  const forLab = signIdentity({ sub: "test|alice", exp, aud: "mcp:lab" }, secret);
  // Key-pair signed, so the server verifies it without AUTH_SECRET (#88).
  assert.match(forLab, /^v2\./);
  assert.equal(verifyIdentity(forLab, secret), null);
  assert.equal(verifyIdentity(forLab, secret, Date.now(), "mcp:lab")?.sub, "test|alice");
  assert.equal(verifyIdentity(forLab, secret, Date.now(), "mcp:other"), null);
});

test("storageAccess servers get a storage token, which only the storage API takes", () => {
  const servers = externalServersFromEnv({
    MCP_SERVERS: JSON.stringify({
      lab: { url: "http://lab/mcp", forwardIdentity: true, storageAccess: true },
      files: { url: "http://files/mcp", storageAccess: true },
    }),
  });
  const configs = serverConfigs(servers, (server, kind) => `${kind}-for-${server}`);
  assert.deepEqual((configs.lab as { headers?: object }).headers, {
    "x-knowledge-user": "identity-for-lab",
    "x-knowledge-storage": "storage-for-lab",
  });
  assert.deepEqual((configs.files as { headers?: object }).headers, { "x-knowledge-storage": "storage-for-files" });

  const secret = "s".repeat(32);
  const exp = Math.floor(Date.now() / 1000) + 60;
  const token = signIdentity({ sub: "test|alice", exp, aud: "storage", via: "mcp:lab" }, secret);
  assert.equal(verifyIdentity(token, secret), null);
  assert.equal(verifyIdentity(token, secret, Date.now(), "mcp:lab"), null);
  assert.equal(verifyIdentity(token, secret, Date.now(), "storage")?.via, "mcp:lab");
});

test("a ui block puts a server in the + menu; bad ones leave the server out", () => {
  const servers = quiet(() =>
    externalServersFromEnv({
      MCP_SERVERS: JSON.stringify({
        papers: { url: "http://papers/mcp", ui: { label: "Search papers", chip: "Papers", icon: "book-open", tools: ["search_papers", "search_papers"] } },
        plain: { url: "http://plain/mcp", ui: { label: "Plain", mode: "manual" } },
        noLabel: { url: "http://x/mcp", ui: { chip: "X" } },
        badMode: { url: "http://x/mcp", ui: { label: "X", mode: "always" } },
        badTools: { url: "http://x/mcp", ui: { label: "X", tools: "search" } },
        stdioUi: { type: "stdio", command: "x", ui: { label: "X" } },
      }),
    }),
  );
  assert.deepEqual(Object.keys(servers), ["papers", "plain"]);
  assert.deepEqual(servers.papers.ui, {
    label: "Search papers",
    chip: "Papers",
    description: null,
    icon: "book-open",
    mode: "auto",
    tools: ["search_papers"],
  });
  assert.deepEqual(servers.plain.ui, { label: "Plain", chip: "Plain", description: null, icon: null, mode: "manual", tools: [] });
});

test("chips steer the run; manual servers only join runs with their chip", () => {
  const servers = externalServersFromEnv({
    MCP_SERVERS: JSON.stringify({
      papers: { url: "http://papers/mcp", ui: { label: "Search papers", chip: "Papers" } },
      patents: { url: "http://patents/mcp", ui: { label: "Search patents", mode: "manual" } },
      lab: { url: "http://lab/mcp" },
    }),
  });
  const props = (tools: unknown) => ({ knowledge_chatroom: { version: 3, tools }, other: 1 });
  assert.deepEqual(chipsFrom(props(["papers", "lab", "nope", 3, "papers"]), servers), ["papers"]);
  assert.deepEqual(chipsFrom(props("papers"), servers), []);
  assert.deepEqual(chipsFrom(undefined, servers), []);

  const options = {
    systemPrompt: "Base.",
    mcpServers: { copilotkit: {}, papers: {}, patents: {}, lab: {} },
    allowedTools: ["mcp__copilotkit__query_data", "mcp__papers", "mcp__patents", "mcp__lab"],
    model: "m",
  };
  const plain = withToolChips(options, [], servers);
  assert.equal(plain.systemPrompt, "Base.");
  assert.deepEqual(Object.keys(plain.mcpServers), ["copilotkit", "papers", "lab"]);
  assert.deepEqual(plain.allowedTools, ["mcp__copilotkit__query_data", "mcp__papers", "mcp__lab"]);

  const chipped = withToolChips(options, ["papers", "patents"], servers);
  assert.match(chipped.systemPrompt, /^Base\.\n- The user turned on "Papers" \(Search papers\).*mcp__papers__ tools/);
  assert.match(chipped.systemPrompt, /"Search patents".*mcp__patents__/);
  assert.deepEqual(Object.keys(chipped.mcpServers), ["copilotkit", "papers", "patents", "lab"]);
  assert.equal(chipped.model, "m");
  // Nothing in the menu, nothing changes.
  assert.equal(withToolChips(options, [], {}), options);
});
