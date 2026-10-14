/**
 * The OpenAI-compatible embeddings client (semantic.ts ApiEmbedder) and its
 * settings (config.ts), against a stand-in endpoint. No database needed.
 */

import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";

import { storageConfigFromEnv } from "./config";
import { ApiEmbedder } from "./semantic";

interface Seen {
  auth?: string;
  path?: string;
  body: { model: string; input: string[]; dimensions?: number; encoding_format?: string };
}

const read = async (req: IncomingMessage) => {
  let text = "";
  for await (const chunk of req) text += chunk;
  return JSON.parse(text);
};

describe("ApiEmbedder", () => {
  let base = "";
  let seen: Seen[] = [];
  let status = 200;
  const server = createServer(async (req, res) => {
    const body = await read(req);
    seen.push({ auth: req.headers.authorization, path: req.url, body });
    if (status !== 200) {
      res.writeHead(status).end('{"error":"rate limited"}');
      return;
    }
    // Out of order and not unit length, as some providers answer.
    const data = body.input
      .map((text: string, index: number) => ({ index, embedding: [text.length, 0, 0, 0] }))
      .reverse();
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data }));
  });

  before(async () => {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/`;
  });
  after(() => server.close());

  test("posts to /embeddings and returns unit vectors in input order", async () => {
    seen = [];
    const embedder = new ApiEmbedder("openai/text-embedding-3-small", base, "sk-test", 512);
    const vectors = await embedder.embed(["a", "bbb"], "passage");
    assert.deepEqual(vectors, [[1, 0, 0, 0], [1, 0, 0, 0]]);
    assert.equal(seen[0].path, "/v1/embeddings");
    assert.equal(seen[0].auth, "Bearer sk-test");
    assert.deepEqual(seen[0].body, {
      model: "openai/text-embedding-3-small",
      input: ["a", "bbb"],
      encoding_format: "float",
      dimensions: 512,
    });
  });

  test("adds E5 prefixes and leaves out what isn't set", async () => {
    seen = [];
    await new ApiEmbedder("intfloat/multilingual-e5-large", base).embed(["etch rate"], "query");
    assert.equal(seen[0].auth, undefined);
    assert.deepEqual(seen[0].body.input, ["query: etch rate"]);
    assert.equal(seen[0].body.dimensions, undefined);
  });

  test("a failed request is an error naming the status", async () => {
    status = 429;
    try {
      await assert.rejects(new ApiEmbedder("m", base).embed(["x"], "passage"), /answered 429/);
    } finally {
      status = 200;
    }
  });
});

describe("embedding settings", () => {
  const db = { DATABASE_URL: "postgres://x" };

  test("the local model by default", () => {
    const config = storageConfigFromEnv(db)!;
    assert.equal(config.embeddingModel, "Xenova/multilingual-e5-small");
    assert.equal(config.embeddingApi, undefined);
  });

  test("EMBEDDING_BASE_URL switches to the API", () => {
    const config = storageConfigFromEnv({
      ...db,
      EMBEDDING_BASE_URL: "http://litellm:4000/v1",
      EMBEDDING_API_KEY: "sk-1",
      EMBEDDING_MODEL: "bge-m3",
      EMBEDDING_DIMENSIONS: "1024",
    })!;
    assert.equal(config.embeddingModel, "bge-m3");
    assert.deepEqual(config.embeddingApi, {
      baseUrl: "http://litellm:4000/v1",
      apiKey: "sk-1",
      dimensions: 1024,
    });
  });

  test("the API needs a model name, and off still turns search by meaning off", () => {
    assert.throws(() => storageConfigFromEnv({ ...db, EMBEDDING_BASE_URL: "http://x/v1" }), /EMBEDDING_MODEL/);
    const off = storageConfigFromEnv({ ...db, EMBEDDING_BASE_URL: "http://x/v1", EMBEDDING_MODEL: "off" })!;
    assert.equal(off.embeddingModel, null);
    assert.equal(off.embeddingApi, undefined);
  });
});
