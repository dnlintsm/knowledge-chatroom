import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { allowServer, externalServersFromEnv, serverConfigs } from "./mcp";

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
  });
  assert.deepEqual(servers.local, {
    config: { type: "stdio", command: "python", args: ["tools.py"], env: { KEY: "s3cret" } },
    forwardIdentity: false,
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
        spoof: { url: "http://x/mcp", headers: { "X-Knowledge-User": "someone" } },
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
  const configs = serverConfigs(servers, "v1.token.sig");
  assert.deepEqual((configs.lab as { headers?: object }).headers, { A: "1", "x-knowledge-user": "v1.token.sig" });
  assert.equal((configs.other as { headers?: object }).headers, undefined);
  // Outside a run (no identity) nothing is added.
  assert.deepEqual((serverConfigs(servers).lab as { headers?: object }).headers, { A: "1" });
});
