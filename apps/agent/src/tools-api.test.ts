import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

import { externalServersFromEnv } from "./mcp";
import { createToolsHandler, toolMenu } from "./tools-api";

// A stand-in paper server, reached over streamable HTTP like the real one.
const seen: { tool: string; args: unknown; headers: http.IncomingHttpHeaders }[] = [];
let toolServer: http.Server;
let base = "";

function paperServer(headers: http.IncomingHttpHeaders) {
  const mcp = new McpServer({ name: "papers", version: "1.0.0" });
  mcp.registerTool(
    "search_papers",
    { inputSchema: { query: z.string() }, outputSchema: { query: z.string(), results: z.array(z.object({ id: z.string() })) } },
    async (args) => {
      seen.push({ tool: "search_papers", args, headers });
      const result = { query: args.query, results: [{ id: "openalex:W1" }] };
      return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
    },
  );
  mcp.registerTool("save_paper", { inputSchema: { id: z.string() } }, async (args) => {
    seen.push({ tool: "save_paper", args, headers });
    return { content: [{ type: "text", text: `Not a paper id: ${args.id}` }], isError: true };
  });
  mcp.registerTool("secret_tool", { inputSchema: {} }, async () => ({ content: [{ type: "text", text: "no" }] }));
  return mcp;
}

before(async () => {
  toolServer = http.createServer(async (req, res) => {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await paperServer(req.headers).connect(transport);
    await transport.handleRequest(req, res);
  });
  await new Promise<void>((resolve) => toolServer.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(toolServer.address() as AddressInfo).port}`;
});

after(() => toolServer.close());

const servers = () =>
  externalServersFromEnv({
    MCP_SERVERS: JSON.stringify({
      papers: {
        url: `${base}/mcp`,
        forwardIdentity: true,
        storageAccess: true,
        ui: { label: "Search papers", chip: "Papers", icon: "book-open", tools: ["search_papers", "save_paper"] },
      },
      down: { url: "http://127.0.0.1:9/mcp", ui: { label: "Down", tools: ["search_papers"] } },
      lab: { url: `${base}/mcp` },
    }),
  });

/** Runs the handler for one request; `signedIn` false answers 401 as the agent server does. */
async function request(method: string, path: string, body?: unknown, signedIn = true) {
  const handler = createToolsHandler(servers(), (_req, res) => {
    if (!signedIn) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Sign in first" }));
      return null;
    }
    return (server, kind = "identity") => `${kind}-token-for-${server}`;
  });
  const app = http.createServer((req, res) => void handler(req, res, new URL(req.url ?? "/", "http://agent")));
  await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${(app.address() as AddressInfo).port}${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  } finally {
    app.close();
  }
}

test("the + menu lists servers with a ui block", async () => {
  assert.deepEqual(toolMenu(servers()).map((item) => item.server), ["papers", "down"]);
  const { status, body } = await request("GET", "/tools");
  assert.equal(status, 200);
  assert.deepEqual((body.tools as unknown[])[0], {
    server: "papers",
    label: "Search papers",
    chip: "Papers",
    description: null,
    icon: "book-open",
    mode: "auto",
    callable: ["search_papers", "save_paper"],
  });
  assert.equal((await request("GET", "/tools", undefined, false)).status, 401);
});

test("a button's call reaches the server as the signed-in user", async () => {
  seen.length = 0;
  const { status, body } = await request("POST", "/tools/papers/search_papers", { arguments: { query: "rag" } });
  assert.equal(status, 200);
  assert.deepEqual(body.result, { query: "rag", results: [{ id: "openalex:W1" }] });
  assert.equal(seen[0].tool, "search_papers");
  assert.deepEqual(seen[0].args, { query: "rag" });
  assert.equal(seen[0].headers["x-knowledge-user"], "identity-token-for-papers");
  assert.equal(seen[0].headers["x-knowledge-storage"], "storage-token-for-papers");
});

test("a tool's own error is a 422 with its message", async () => {
  const { status, body } = await request("POST", "/tools/papers/save_paper", { arguments: { id: "cats" } });
  assert.equal(status, 422);
  assert.equal(body.error, "Not a paper id: cats");
});

test("only menu servers, only their listed tools, signed in, with arguments", async () => {
  seen.length = 0;
  assert.equal((await request("POST", "/tools/papers/secret_tool", { arguments: {} })).status, 403);
  assert.equal((await request("POST", "/tools/lab/search_papers", { arguments: {} })).status, 404);
  assert.equal((await request("POST", "/tools/nope/search_papers", { arguments: {} })).status, 404);
  assert.equal((await request("POST", "/tools/papers/search_papers", { arguments: [] })).status, 400);
  assert.equal((await request("POST", "/tools/papers/search_papers", "{not json")).status, 400);
  assert.equal((await request("POST", "/tools/%E0%A4/search_papers", { arguments: {} })).status, 400);
  assert.equal((await request("GET", "/tools/papers/%E0%A4")).status, 400);
  assert.equal((await request("GET", "/tools/papers/search_papers")).status, 405);
  assert.equal((await request("POST", "/tools/papers/search_papers", { arguments: {} }, false)).status, 401);
  assert.equal(seen.length, 0);
});

test("a server that is down is a 502, not a crash", async () => {
  const quiet = console.error;
  console.error = () => {};
  try {
    const { status, body } = await request("POST", "/tools/down/search_papers", { arguments: { query: "x" } });
    assert.equal(status, 502);
    assert.equal(body.error, "Down isn't reachable right now");
  } finally {
    console.error = quiet;
  }
});
