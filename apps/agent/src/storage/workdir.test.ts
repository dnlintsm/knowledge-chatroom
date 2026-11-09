import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import type { FilesSession, Session } from "./session";
import { LIST_CONCURRENCY, syncWorkdir } from "./workdir";

/**
 * syncWorkdir against a fake session: no database, but listings that finish
 * in a chosen order, to check the bounded, order-independent collection.
 */

const enc = (text: string) => new TextEncoder().encode(text);
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface FakePlace {
  files: Record<string, string>;
}

function fakeSession(opts: {
  nodes: { id: string; name: string; parentId: string | null }[];
  experiments: { id: string; title: string }[];
  places: Map<string | null, FakePlace>;
  /** How long the listing of place `key` takes. */
  delay: (key: string) => number;
  failList?: string;
}) {
  let active = 0;
  let maxActive = 0;
  const started: string[] = [];
  const finished: string[] = [];
  const filesFor = (key: string, place: FakePlace | undefined) => {
    const infos = Object.entries(place?.files ?? {}).map(([p, text]) => ({
      path: p,
      sha256: sha(enc(text)),
      size: enc(text).byteLength,
    }));
    return {
      list: async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        started.push(key);
        try {
          await sleep(opts.delay(key));
          if (opts.failList === key) throw new Error(`listing ${key} failed`);
          finished.push(key);
          return infos;
        } finally {
          active--;
        }
      },
      read: async (p: string) => {
        const bytes = enc(place!.files[p]);
        return { bytes, info: { path: p, sha256: sha(bytes), size: bytes.byteLength } };
      },
    } as unknown as FilesSession;
  };
  const session = {
    tree: async () => ({
      types: [],
      rootRole: "viewer",
      nodes: opts.nodes.map((n) => ({ ...n, role: "viewer" })),
    }),
    experiments: async () => opts.experiments.map((e) => ({ ...e, access: "viewer" })),
    files: async (nodeId: string | null) => filesFor(nodeId ?? "root", opts.places.get(nodeId)),
    experimentFiles: async (id: string) => filesFor(id, opts.places.get(id)),
  } as unknown as Session;
  return { session, maxActive: () => maxActive, started, finished };
}

/** A workspace with many places, a child node whose name hides a file, and experiments. */
function bigWorkspace() {
  const nodes: { id: string; name: string; parentId: string | null }[] = [];
  const places = new Map<string | null, FakePlace>();
  places.set(null, { files: { "readme.md": "root readme" } });
  for (let i = 0; i < 30; i++) {
    const id = `node-${String(i).padStart(4, "0")}-aaaa`;
    nodes.push({ id, name: `Module ${i}`, parentId: null });
    places.set(id, { files: { "notes.md": `notes ${i}`, [`data-${i}.csv`]: `a,b\n${i},${i}` } });
  }
  // A child node named "Loop" under Module 0: Module 0's own "Loop/x.md" must be skipped.
  nodes.push({ id: "child-000-bbbb", name: "Loop", parentId: nodes[0].id });
  places.get(nodes[0].id)!.files["Loop/x.md"] = "hidden by the child node";
  places.set("child-000-bbbb", { files: { "steps.md": "loop steps" } });
  const experiments: { id: string; title: string }[] = [];
  for (let i = 0; i < 12; i++) {
    const id = `exp-${String(i).padStart(4, "0")}-cccc`;
    experiments.push({ id, title: `Run ${i}` });
    places.set(id, { files: { "report.md": `report ${i}` } });
  }
  return { nodes, experiments, places };
}

async function run(delay: (key: string) => number) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "workdir-unit-"));
  try {
    const fake = fakeSession({ ...bigWorkspace(), delay });
    const summary = await syncWorkdir(fake.session, cwd, { maxBytes: 100 * 1024 * 1024, maxFileBytes: 1024 * 1024 });
    const places = JSON.parse(await readFile(path.join(summary.dir, ".places.json"), "utf8"));
    const someFile = await readFile(path.join(summary.dir, "nodes", "Module 7", "notes.md"), "utf8");
    return { summary: { ...summary, dir: "" }, places, someFile, maxActive: fake.maxActive() };
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

test("syncWorkdir lists places a few at a time, with the same result whatever order they finish in", async () => {
  const keyIndex = (key: string) => [...key].reduce((n, c) => n * 31 + c.charCodeAt(0), 7) >>> 0;
  // Reverse order: later places finish first. Scrambled: an arbitrary mix.
  const reverse = await run((key) => 60 - (keyIndex(key) % 60));
  const scrambled = await run((key) => (keyIndex(key) * 13) % 25);
  const instant = await run(() => 0);

  for (const result of [reverse, scrambled, instant]) {
    assert.ok(result.maxActive <= LIST_CONCURRENCY, `at most ${LIST_CONCURRENCY} listings at once, saw ${result.maxActive}`);
  }
  assert.ok(reverse.maxActive > 1, "listings overlap");

  assert.deepEqual(scrambled.summary, reverse.summary);
  assert.deepEqual(instant.summary, reverse.summary);
  assert.deepEqual(scrambled.places, reverse.places);

  const { summary } = reverse;
  // Root, the 31 nodes in the tree's order, then the 12 experiments.
  assert.equal(summary.places.length, 1 + 31 + 12);
  assert.deepEqual(summary.places[0], { folder: "workspace/root", root: true, role: "viewer" });
  assert.equal(summary.places[1].folder, "workspace/nodes/Module 0");
  assert.equal(summary.places[31].folder, "workspace/nodes/Module 0/Loop");
  assert.equal(summary.places.at(-1)!.folder, "workspace/experiments/Run 11 (exp-0011)");
  assert.deepEqual(summary.skipped, [{ path: "nodes/Module 0/Loop/x.md", reason: "a child node has this name" }]);
  // 1 root file + 30 nodes × 2 + 1 child file + 12 reports.
  assert.equal(summary.files, 1 + 60 + 1 + 12);
  assert.equal(reverse.someFile, "notes 7");
});

test("syncWorkdir waits for listings already started before reporting a failed one", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "workdir-unit-"));
  try {
    // Module 0 fails at once while the others in the first batch are still listing.
    const fake = fakeSession({ ...bigWorkspace(), failList: "node-0000-aaaa", delay: (key) => (key === "node-0000-aaaa" ? 0 : 40) });
    await assert.rejects(syncWorkdir(fake.session, cwd), /listing node-0000-aaaa failed/);
    assert.equal(fake.started.length, LIST_CONCURRENCY, "no new listing starts after the failure");
    // Every other listing that started had finished by the time it rejected.
    assert.deepEqual([...fake.finished].sort(), fake.started.filter((key) => key !== "node-0000-aaaa").sort());
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
