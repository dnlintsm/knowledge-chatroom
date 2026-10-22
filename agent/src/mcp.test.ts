import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { allowServer, externalServersFromEnv, serverConfigs } from "./mcp";
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
  });
  assert.deepEqual(servers.local, {
    config: { type: "stdio", command: "python", args: ["tools.py"], env: { KEY: "s3cret" } },
    forwardIdentity: false,
    storageAccess: false,
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
