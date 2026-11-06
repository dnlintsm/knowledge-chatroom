import { createHash } from "node:crypto";

import type { MemoryService } from "../storage/memory";
import type { Embedder, SemanticIndex } from "../storage/semantic";
import type { RunSharedNote, SharedMemoryService } from "../storage/shared-memory";

/**
 * Search by meaning over memory notes (issue #93, step 5), beside
 * memory_search's word matching: "how do they like charts" finds a note that
 * says "plots: no titles, units on axes".
 *
 * Notes are few and short (a few hundred at most per run), so their vectors
 * live in this process only, keyed by the text they came from: a note that
 * changes, or is deleted, simply stops being looked up, and nothing derived
 * from private notes is stored. Uses the agent's embedding model (the one
 * file search uses, ../storage/semantic.ts) when search by meaning is on.
 */

/** Note texts embedded at most, in characters. */
const MAX_TEXT = 2_000;
/** Vectors kept, across users. */
const CACHE_SIZE = 5_000;

export interface RecallHit {
  /** A personal note's name, or a shared note's shared:<id> data. */
  name: string;
  description: string;
  type: string;
  shared: RunSharedNote | null;
  similarity: number;
}

export class MemoryRecall {
  private readonly cache = new Map<string, number[]>();

  constructor(
    private readonly embedder: Embedder,
    /** Notes less similar to the query than this aren't results. */
    private readonly minSimilarity: number,
    /** Vectors kept, across users. */
    private readonly cacheSize = CACHE_SIZE,
  ) {}

  private key(text: string) {
    return createHash("sha256").update(`${this.embedder.source ?? this.embedder.model}\n${text}`).digest("base64url");
  }

  /** The texts' vectors, embedding the ones not cached yet in one batch. */
  private async vectors(texts: string[]): Promise<number[][]> {
    const keys = texts.map((t) => this.key(t));
    const found = new Map<string, number[]>();
    for (const k of keys) {
      const vector = this.cache.get(k);
      if (!vector) continue;
      found.set(k, vector);
      // Recently used ones last, so they stay.
      this.cache.delete(k);
      this.cache.set(k, vector);
    }
    const missing = [...new Set(keys.filter((k) => !found.has(k)))];
    if (missing.length) {
      const made = await this.embedder.embed(missing.map((k) => texts[keys.indexOf(k)]), "passage");
      missing.forEach((k, j) => {
        found.set(k, made[j]);
        this.cache.set(k, made[j]);
      });
      // Oldest first out. This batch is already in hand, even if it alone
      // is more than the cache holds.
      for (const old of this.cache.keys()) {
        if (this.cache.size <= this.cacheSize) break;
        this.cache.delete(old);
      }
    }
    return keys.map((k) => found.get(k)!);
  }

  /** The run's notes closest in meaning to `query`, most similar first. */
  async search(
    memory: MemoryService,
    shared: SharedMemoryService,
    userId: string,
    nodeId: string | null,
    query: string,
    limit = 5,
  ): Promise<RecallHit[]> {
    if (!query.trim()) return [];
    const [personal, sharedNotes] = await Promise.all([memory.texts(userId), shared.texts(userId, nodeId)]);
    const notes = [
      ...personal.map((n) => ({ ...n, shared: null as RunSharedNote | null })),
      ...sharedNotes.map((n) => ({ ...n, shared: n as RunSharedNote })),
    ];
    if (!notes.length) return [];
    const texts = notes.map((n) => `${n.name}: ${n.description}\n${n.body}`.slice(0, MAX_TEXT));
    const [[q], vectors] = await Promise.all([this.embedder.embed([query], "query"), this.vectors(texts)]);
    return notes
      .map((n, i) => ({
        name: n.name,
        description: n.description,
        type: n.type,
        shared: n.shared,
        similarity: dot(q, vectors[i]),
      }))
      .filter((h) => h.similarity >= this.minSimilarity)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, limit);
  }
}

/** Unit-length vectors: the dot product is the cosine similarity. */
const dot = (a: number[], b: number[]) => a.reduce((sum, x, i) => sum + x * (b[i] ?? 0), 0);

const recalls = new WeakMap<SemanticIndex, MemoryRecall>();

/** Search by meaning over notes, once the agent's embedding model is ready. */
export function recallFor(semantic: SemanticIndex | null | undefined): MemoryRecall | null {
  if (!semantic?.ready) return null;
  let recall = recalls.get(semantic);
  if (!recall) recalls.set(semantic, (recall = new MemoryRecall(semantic.embedder, semantic.minSimilarity)));
  return recall;
}
