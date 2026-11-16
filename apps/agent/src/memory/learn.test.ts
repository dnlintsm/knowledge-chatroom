import assert from "node:assert/strict";
import { test } from "node:test";
import { MemoryLearner } from "./learn";

type Chat = Awaited<ReturnType<MemoryLearner["due"]>>[number];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const chat = (id: string, user: string): Chat => ({ id, workspace_id: "default", user_id: user, last_run_at: new Date().toISOString() });

test("MemoryLearner.sweep learns from different users' chats at the same time", async () => {
  const learner = new MemoryLearner(() => null as never);
  learner.due = async () => Array.from({ length: 5 }, (_, i) => chat(`chat-${i}`, `user-${i}`));

  let active = 0;
  let maxActive = 0;
  learner.learn = async () => {
    active++;
    maxActive = Math.max(maxActive, active);
    await sleep(30);
    active--;
    return { made: 1, proposed: 0 };
  };

  assert.equal(await learner.sweep(), 5);
  assert.equal(maxActive, 5, "every user's chat is learned from at once");
});

test("MemoryLearner.sweep learns from one user's chats one after another, oldest first", async () => {
  const learner = new MemoryLearner(() => null as never);
  // due() is ordered by last run; alice's chats interleave with bob's.
  learner.due = async () => [chat("a1", "alice"), chat("b1", "bob"), chat("a2", "alice"), chat("a3", "alice"), chat("b2", "bob")];

  const activeByUser = new Map<string, number>();
  let maxPerUser = 0;
  let maxActive = 0;
  const order: string[] = [];
  learner.learn = async (c) => {
    const now = (activeByUser.get(c.user_id) ?? 0) + 1;
    activeByUser.set(c.user_id, now);
    maxPerUser = Math.max(maxPerUser, now);
    maxActive = Math.max(maxActive, [...activeByUser.values()].reduce((a, b) => a + b, 0));
    // Later chats finish sooner, so only the sequencing keeps them in order.
    await sleep(c.id.endsWith("1") ? 40 : 5);
    order.push(c.id);
    activeByUser.set(c.user_id, activeByUser.get(c.user_id)! - 1);
    return { made: 1, proposed: 0 };
  };

  assert.equal(await learner.sweep(), 5);
  assert.equal(maxPerUser, 1, "never two of one user's chats at once");
  assert.equal(maxActive, 2, "alice and bob at the same time");
  assert.deepEqual(order.filter((id) => id.startsWith("a")), ["a1", "a2", "a3"]);
  assert.deepEqual(order.filter((id) => id.startsWith("b")), ["b1", "b2"]);
});

test("MemoryLearner.sweep releases its guard only once every chat has settled", async () => {
  const learner = new MemoryLearner(() => null as never);
  learner.due = async () => [chat("fails", "alice"), chat("after-fail", "alice"), chat("slow", "bob")];

  const finished: string[] = [];
  let release: () => void = () => {};
  const slowStarted = new Promise<void>((resolve) => (release = resolve));
  learner.learn = async (c) => {
    if (c.id === "fails") {
      // Like the memory_learned_chats write failing: learn() itself rejects.
      await slowStarted;
      throw new Error("couldn't record the chat");
    }
    if (c.id === "slow") {
      release();
      await sleep(50);
    }
    finished.push(c.id);
    return { made: 1, proposed: 0 };
  };

  const errors: unknown[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => void errors.push(args.join(" "));
  try {
    const sweep = learner.sweep();
    await slowStarted;
    // A sweep while bob's chat is still being learned from must not start another pass.
    assert.equal(await learner.sweep(), 0);
    assert.equal(await sweep, 1);
  } finally {
    console.error = original;
  }
  assert.deepEqual(finished, ["slow"], "bob's chat finished before the sweep returned; alice's next chat waits for the next sweep");
  assert.equal(errors.length, 1);
  assert.match(String(errors[0]), /couldn't record the chat/);
});

test("MemoryLearner.sweep prevents reentrant sweeps while running", async () => {
  const learner = new MemoryLearner(() => null as never);
  learner.due = async () => [chat("c1", "u1")];
  learner.learn = async () => {
    await sleep(30);
    return { made: 1, proposed: 0 };
  };

  const [first, second] = await Promise.all([learner.sweep(), learner.sweep()]);
  assert.equal(first, 1);
  assert.equal(second, 0, "a sweep while one is running returns 0");
});
