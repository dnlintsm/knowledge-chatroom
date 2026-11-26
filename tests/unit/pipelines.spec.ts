import { test, expect } from "@playwright/test";

import {
  authorizedByText,
  finishedByText,
  newPipelineBody,
  operationsText,
  pipelineActions,
  pipelineActivity,
  placesText,
  ranAsText,
  statusNote,
  type Pipeline,
  type RunExecution,
} from "../../apps/web/src/lib/pipelines";

/** What the Pipelines screen and the Run view say (docs/pipeline-identities.md, "Screens"). */

const names = {
  node: (id: string) => ({ n1: "Etch", n2: "Module 3" })[id],
  experiment: (id: string) => ({ x1: "Etch sweep" })[id],
};

const alice = { id: "u1", name: "Alice" };

function pipeline(over: Partial<Pipeline> = {}): Pipeline {
  return {
    id: "p1",
    name: "Nightly import",
    owner: alice,
    createdBy: "u1",
    createdAt: "2026-11-26T00:00:00Z",
    places: null,
    operations: ["read"],
    status: "active",
    revokedAt: null,
    keys: [{ id: "k1", hint: "a1b2", createdAt: "", expiresAt: "", lastUsedAt: null, revokedAt: null, status: "active" }],
    ...over,
  };
}

test("places read as names the reader can see, and the rest are counted, not named", () => {
  expect(placesText(null, names)).toBe("the whole workspace");
  expect(placesText([{ node: "n1" }], names)).toBe("Etch");
  expect(placesText([{ node: "n1" }, { node: "n2" }, { experiment: "x1" }], names)).toBe("Etch, Module 3 and Etch sweep");
  expect(placesText([{ node: "n1" }, { node: "secret" }], names)).toBe("Etch and 1 place you can't see");
  expect(placesText([{ node: "a" }, { experiment: "b" }], names)).toBe("2 places you can't see");
});

test("operations keep the form's order", () => {
  expect(operationsText(["runs", "read"])).toBe("read, runs");
  expect(operationsText(["upload", "write", "read", "runs"])).toBe("read, write, runs, upload");
});

test("only its owner makes keys; the owner and the workspace's Owners and Admins revoke; Owners and Admins hand over", () => {
  const p = pipeline();
  expect(pipelineActions(p, "u1", false)).toEqual({ addKey: true, revokeKey: true, revoke: true, handOver: false });
  expect(pipelineActions(p, "u2", true)).toEqual({ addKey: false, revokeKey: true, revoke: true, handOver: true });
  expect(pipelineActions(p, "u2", false)).toEqual({ addKey: false, revokeKey: false, revoke: false, handOver: false });
  // At most two live keys; a revoked pipeline offers nothing.
  const two = pipeline({ keys: [...p.keys, { ...p.keys[0], id: "k2", hint: "c3d4" }] });
  expect(pipelineActions(two, "u1", false).addKey).toBe(false);
  expect(pipelineActions(pipeline({ status: "revoked" }), "u1", true)).toEqual({
    addKey: false,
    revokeKey: false,
    revoke: false,
    handOver: false,
  });
});

test("a suspended or revoked pipeline says why", () => {
  expect(statusNote(pipeline())).toBeNull();
  expect(statusNote(pipeline({ status: "suspended" }))).toMatch(/owner is no longer a member/);
  expect(statusNote(pipeline({ status: "revoked" }))).toMatch(/can't be turned back on/);
});

test("the form sends a name, its places or the whole workspace, and operations in order", () => {
  const form = { name: "  Nightly   import ", whole: true, places: [], operations: ["runs", "read"] as const, days: 90 };
  expect(newPipelineBody({ ...form, operations: [...form.operations] })).toEqual({
    body: { name: "Nightly import", places: null, operations: ["read", "runs"], expiresInDays: 90 },
  });
  expect(newPipelineBody({ ...form, operations: ["read"], name: " " })).toEqual({ problem: "Give it a name" });
  expect(newPipelineBody({ ...form, operations: ["read"], whole: false })).toEqual({
    problem: "Choose at least one place, or the whole workspace",
  });
  expect(newPipelineBody({ ...form, operations: [] })).toEqual({ problem: "Choose at least one operation" });
  expect(newPipelineBody({ ...form, operations: ["read"], whole: false, places: [{ node: "n1" }] })).toEqual({
    body: { name: "Nightly import", places: [{ node: "n1" }], operations: ["read"], expiresInDays: 90 },
  });
});

const byPipeline: RunExecution = {
  initiatedBy: alice,
  ranAs: { kind: "pipeline", id: "p1", name: "Nightly etch import", key: "k1", hint: "a1b2" },
  authorizedBy: { kind: "pipeline-key", key: "k1", places: [{ node: "n1" }], operations: ["runs", "read"] },
};

test("a Run says what it ran as and whose access it used", () => {
  expect(ranAsText(undefined)).toBeNull();
  expect(ranAsText(byPipeline)).toBe("Pipeline Nightly etch import, key …a1b2, for Alice");
  expect(authorizedByText(byPipeline, names)).toBe("Alice's access, narrowed to Etch: read, runs");
  const wide = { ...byPipeline, authorizedBy: { ...byPipeline.authorizedBy, places: null } };
  expect(authorizedByText(wide, names)).toBe("Alice's access, narrowed to the whole workspace: read, runs");

  const chat: RunExecution = {
    initiatedBy: alice,
    ranAs: { kind: "agent", via: "remote" },
    authorizedBy: { kind: "storage-token", via: "remote" },
  };
  expect(ranAsText(chat)).toBe("Claude, in Alice's chat");
  expect(authorizedByText(chat, names)).toBe("Alice's access, through Claude");
  expect(ranAsText({ ...chat, ranAs: { kind: "agent", via: "mcp:lab" } })).toBe("Claude, through lab, for Alice");

  const browser: RunExecution = { initiatedBy: alice, ranAs: { kind: "user" }, authorizedBy: { kind: "session" } };
  expect(ranAsText(browser)).toBe("Alice");
  expect(authorizedByText(browser, names)).toBe("Alice's access, signed in");
});

test("who finished a Run shows only when it wasn't who started it, the same way", () => {
  expect(finishedByText(byPipeline)).toBeNull();
  const same = { ...byPipeline, finishedBy: { user: alice, ranAs: byPipeline.ranAs, authorizedBy: byPipeline.authorizedBy } };
  expect(finishedByText(same)).toBeNull();
  const byHand = {
    ...byPipeline,
    finishedBy: { user: alice, ranAs: { kind: "user" as const }, authorizedBy: { kind: "session" as const } },
  };
  expect(finishedByText(byHand)).toBe("Alice");
});

test("the Activity tab names the pipeline and says what a handover revoked", () => {
  const pipelineName = (id: unknown) => (id === "p1" ? "Nightly import" : undefined);
  const person = (id: unknown) => (id === "u2" ? "Bob" : "a former member");
  expect(pipelineActivity("pipeline.create", { pipeline: "p1", name: "Nightly import" }, pipelineName, person)).toBe(
    "made the pipeline Nightly import",
  );
  expect(pipelineActivity("pipeline.handover", { pipeline: "p1", toUser: "u2", keysRevoked: 2 }, pipelineName, person)).toBe(
    "handed the pipeline Nightly import over to Bob, revoking its 2 keys",
  );
  expect(pipelineActivity("pipeline.key.revoke", { pipeline: "gone" }, pipelineName, person)).toBe(
    "revoked a key of a pipeline",
  );
  expect(pipelineActivity("grant.set", {}, pipelineName, person)).toBeNull();
});
