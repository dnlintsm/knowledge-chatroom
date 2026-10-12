/**
 * Checks the real embedding model (semantic.ts): it loads, and its
 * similarities clear the search bar for related text but not for unrelated
 * text, in English and Chinese. It downloads the model (about 120 MB) the
 * first time, so it runs only with EMBEDDING_TEST=1, which adds it to
 * `npm run test:integration` (CI caches the model):
 *
 *   cd agent && EMBEDDING_TEST=1 npx tsx --test src/storage/embeddings.test.ts
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { DEFAULT_EMBEDDING_MODEL } from "./config";
import { defaultMinSimilarity, LocalEmbedder } from "./semantic";

const dot = (a: number[], b: number[]) => a.reduce((sum, x, i) => sum + x * b[i], 0);

describe("embedding model", { skip: !process.env.EMBEDDING_TEST && "EMBEDDING_TEST not set" }, () => {
  test("related passages clear the bar, unrelated ones don't", { timeout: 600_000 }, async () => {
    const embedder = new LocalEmbedder(DEFAULT_EMBEDDING_MODEL, process.env.EMBEDDING_CACHE_DIR);
    const min = defaultMinSimilarity(DEFAULT_EMBEDDING_MODEL, {});
    const cases: [query: string, related: string, unrelated: string][] = [
      [
        "chamber wall buildup",
        "Polymer deposition on the chamber liner grows every week and flakes onto wafers.",
        "The quarterly budget review moved to Thursday afternoon.",
      ],
      [
        "why did the etch rate drop",
        "After the RF generator was replaced, oxide etch rate fell by 8 percent.",
        "Remember to water the plants in the lobby.",
      ],
      [
        "腔体内壁沉积",
        "刻蚀腔室衬里上的聚合物沉积每周都在增加。",
        "下周三的团队午餐改到楼下餐厅。",
      ],
    ];
    for (const [query, related, unrelated] of cases) {
      const [q] = await embedder.embed([query], "query");
      const [r, u] = await embedder.embed([related, unrelated], "passage");
      assert.ok(Math.abs(dot(q, q) - 1) < 1e-3, "vectors are unit length");
      const close = dot(q, r);
      const far = dot(q, u);
      console.log(`[embeddings] ${JSON.stringify(query)}: related ${close.toFixed(3)}, unrelated ${far.toFixed(3)} (bar ${min})`);
      assert.ok(close > far, `${query}: related should be closer`);
      assert.ok(close >= min, `${query}: related ${close} should clear ${min}`);
      assert.ok(far < min, `${query}: unrelated ${far} should stay under ${min}`);
    }
  });
});
