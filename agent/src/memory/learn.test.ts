import assert from "node:assert/strict";
import { test } from "node:test";
import { MemoryLearner } from "./learn";

test("MemoryLearner.sweep runs due chats in parallel", async () => {
  const learner = new MemoryLearner(() => null as never);
  const CHAT_COUNT = 5;
  const DELAY_MS = 50;

  learner.due = async () =>
    Array.from({ length: CHAT_COUNT }, (_, i) => ({
      id: `chat-${i}`,
      user_id: `user-${i}`,
      last_run_at: new Date().toISOString(),
    }));

  let maxActive = 0;
  let active = 0;

  learner.learn = async () => {
    active++;
    if (active > maxActive) maxActive = active;
    await new Promise((resolve) => setTimeout(resolve, DELAY_MS));
    active--;
    return { made: 1, proposed: 0 };
  };

  const start = performance.now();
  const learned = await learner.sweep();
  const elapsed = performance.now() - start;

  assert.equal(learned, CHAT_COUNT);
  assert.equal(maxActive, CHAT_COUNT, "all due chats should be processed concurrently");
  assert.ok(
    elapsed < CHAT_COUNT * DELAY_MS * 0.7,
    `expected parallel execution (took ${elapsed.toFixed(1)}ms, sequential would take >=${CHAT_COUNT * DELAY_MS}ms)`,
  );
});

test("MemoryLearner.sweep prevents reentrant sweeps while running", async () => {
  const learner = new MemoryLearner(() => null as never);

  learner.due = async () => [
    { id: "c1", user_id: "u1", last_run_at: new Date().toISOString() },
  ];

  learner.learn = async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
    return { made: 1, proposed: 0 };
  };

  const firstPromise = learner.sweep();
  const secondPromise = learner.sweep();

  const [firstResult, secondResult] = await Promise.all([firstPromise, secondPromise]);
  assert.equal(firstResult, 1);
  assert.equal(secondResult, 0, "concurrent sweep while running returns 0");
});
