import os from "node:os";
import path from "node:path";

import type { Sql } from "./db";

/**
 * Search by meaning (issue #4, step 6). Every passage of indexed text
 * (blob_chunks, 006_search.sql) gets an embedding from a small model that
 * runs inside the agent, stored with pgvector; a search embeds the query and
 * finds the nearest passages. It is optional: without pgvector, or with
 * EMBEDDING_MODEL=off, search stays word-based.
 *
 * Embedding happens in the background, so a new file is found by its words
 * at once and by meaning a few seconds later.
 */

export interface Embedder {
  readonly model: string;
  /** One unit-length vector per text. */
  embed(texts: string[], kind: "query" | "passage"): Promise<number[][]>;
}

type Extractor = (
  texts: string[],
  options: { pooling: "mean"; normalize: boolean },
) => Promise<{ tolist(): number[][] }>;

const DEFAULT_CACHE_DIR = path.join(os.homedir(), ".cache", "knowledge-chatroom", "models");

/**
 * A model from the Hugging Face hub run with ONNX Runtime in this process
 * (transformers.js), downloaded to `cacheDir` on first use.
 */
export class LocalEmbedder implements Embedder {
  private extractor: Promise<Extractor> | null = null;

  constructor(
    readonly model: string,
    private readonly cacheDir = DEFAULT_CACHE_DIR,
  ) {}

  private load(): Promise<Extractor> {
    this.extractor ??= (async () => {
      // Loaded only when used, so the agent starts fast and tests don't need it.
      const { env, pipeline } = await import("@huggingface/transformers");
      env.cacheDir = this.cacheDir;
      return (await pipeline("feature-extraction", this.model, { dtype: "q8" })) as unknown as Extractor;
    })().catch((err) => {
      this.extractor = null; // so a later call can try again
      throw err;
    });
    return this.extractor;
  }

  async embed(texts: string[], kind: "query" | "passage"): Promise<number[][]> {
    const extractor = await this.load();
    // E5 models were trained with these prefixes.
    const prefix = /(^|\/)(multilingual-)?e5-/i.test(this.model) ? `${kind}: ` : "";
    const output = await extractor(
      texts.map((t) => prefix + t),
      { pooling: "mean", normalize: true },
    );
    return output.tolist();
  }
}

/** pgvector's text form of a vector. */
export const toVector = (v: number[]) => `[${v.join(",")}]`;

const BATCH = 16;
const IDLE_MS = 5_000;
const RETRY_MS = 60_000;

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms).unref());

/**
 * Keeps blob_chunks.embedding filled for `embedder`, and embeds queries.
 * `ready` once the database can hold this model's vectors.
 */
export class SemanticIndex {
  ready = false;
  private stopped = false;

  constructor(
    private readonly sql: Sql,
    readonly embedder: Embedder,
    /** Passages less similar to the query than this aren't search results. */
    readonly minSimilarity: number = defaultMinSimilarity(embedder.model),
  ) {}

  /**
   * Makes sure pgvector is on and blob_chunks has a column for this model's
   * vectors (a different model or size starts the column over). Returns
   * whether search by meaning can be used; false without pgvector.
   */
  async prepare(): Promise<boolean> {
    // pgvector first, so a database without it never loads the model.
    if (!(await this.enableVectors())) return (this.ready = false);
    const [probe] = await this.embedder.embed(["probe"], "passage");
    const dims = probe.length;
    const model = this.embedder.model;
    await this.sql.begin(async (tx) => {
      // Same lock as migrate(): schema changes one process at a time.
      await tx`SELECT pg_advisory_xact_lock(hashtext('knowledge-chatroom:migrate'))`;
      await tx`
        CREATE TABLE IF NOT EXISTS search_embedding (
          singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
          model text NOT NULL,
          dims  integer NOT NULL
        )`;
      const [current] = await tx<{ model: string; dims: number }[]>`
        SELECT model, dims FROM search_embedding`;
      if (current?.model === model && current.dims === dims) return;
      // Vectors from another model don't compare with this one's: start over.
      await tx`ALTER TABLE blob_chunks DROP COLUMN IF EXISTS embedding`;
      await tx.unsafe(`ALTER TABLE blob_chunks ADD COLUMN embedding vector(${Number(dims)})`);
      await tx`CREATE INDEX blob_chunks_embedding ON blob_chunks USING hnsw (embedding vector_cosine_ops)`;
      await tx`CREATE INDEX blob_chunks_unembedded ON blob_chunks (sha256, ord) WHERE embedding IS NULL`;
      await tx`
        INSERT INTO search_embedding (model, dims) VALUES (${model}, ${dims})
        ON CONFLICT (singleton) DO UPDATE SET model = EXCLUDED.model, dims = EXCLUDED.dims`;
      console.log(`[search] search by meaning uses ${model} (${dims} dimensions)`);
    });
    return (this.ready = true);
  }

  /** Turns pgvector on if Postgres has it; false (and a log line) if not. */
  private async enableVectors(): Promise<boolean> {
    const [available] = await this.sql`SELECT 1 FROM pg_available_extensions WHERE name = 'vector'`;
    if (!available) {
      console.warn(
        "[search] Postgres has no pgvector, so search matches words only " +
          "(use the pgvector/pgvector image, or install pgvector, for search by meaning)",
      );
      return false;
    }
    try {
      await this.sql`CREATE EXTENSION IF NOT EXISTS vector`;
      return true;
    } catch (err) {
      console.warn(
        "[search] could not turn on pgvector (an admin can run CREATE EXTENSION vector); " +
          "search matches words only:",
        (err as Error).message,
      );
      return false;
    }
  }

  /** Embeds up to `batch` passages that have no vector yet; returns how many. */
  async embedPending(batch = BATCH): Promise<number> {
    const rows = await this.sql<{ sha256: string; ord: number; body: string }[]>`
      SELECT sha256, ord, body FROM blob_chunks
      WHERE embedding IS NULL
      ORDER BY sha256, ord
      LIMIT ${batch}`;
    if (!rows.length) return 0;
    const vectors = await this.embedder.embed(
      rows.map((r) => r.body),
      "passage",
    );
    await this.sql`
      UPDATE blob_chunks c SET embedding = u.embedding::vector
      FROM unnest(${rows.map((r) => r.sha256)}::text[], ${rows.map((r) => r.ord)}::int[],
                  ${vectors.map(toVector)}::text[]) AS u(sha256, ord, embedding)
      WHERE c.sha256 = u.sha256 AND c.ord = u.ord AND c.embedding IS NULL`;
    return rows.length;
  }

  /** embedPending() until every passage has a vector. */
  async embedAll(): Promise<number> {
    let total = 0;
    for (let n = await this.embedPending(); n > 0; n = await this.embedPending()) total += n;
    return total;
  }

  /** The query as a pgvector value. */
  async queryVector(query: string): Promise<string> {
    const [vector] = await this.embedder.embed([query], "query");
    return toVector(vector);
  }

  /**
   * Runs in the background for the server: loads the model (downloading it
   * the first time), prepares the database, then embeds new passages as they
   * appear. Failures are logged and retried; search by words never waits.
   */
  start(): void {
    void this.run();
  }

  stop(): void {
    this.stopped = true;
  }

  private async run() {
    while (!this.stopped && !this.ready) {
      try {
        if (!(await this.prepare())) return; // no pgvector: nothing to retry
      } catch (err) {
        console.error(`[search] could not load ${this.embedder.model}; trying again in a minute:`, err);
        await sleep(RETRY_MS);
      }
    }
    while (!this.stopped) {
      try {
        if ((await this.embedPending()) === 0) await sleep(IDLE_MS);
      } catch (err) {
        console.error("[search] embedding passages failed; trying again in a minute:", err);
        await sleep(RETRY_MS);
      }
    }
  }
}

/**
 * How similar a passage must be to count as a result. E5 models give
 * unrelated text a fairly high cosine similarity, so their bar is higher.
 * SEARCH_MIN_SIMILARITY overrides it.
 */
export function defaultMinSimilarity(
  model: string,
  env: Record<string, string | undefined> = process.env,
): number {
  const set = Number.parseFloat(env.SEARCH_MIN_SIMILARITY ?? "");
  if (!Number.isNaN(set)) return set;
  return /e5-/i.test(model) ? 0.82 : 0.5;
}
