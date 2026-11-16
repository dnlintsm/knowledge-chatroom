import { test, expect } from "@playwright/test";
import { SaveScheduler, type StorageMode } from "../../apps/web/src/components/workspace/save-scheduler";
import type { WorkspaceFile } from "../../apps/web/src/components/workspace/types";

function file(content: string, path = "notes/a.md"): WorkspaceFile {
  return { path, content, kind: "note", mime: "text/markdown", author: "user", updatedAt: 1 };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
function fixture() {
  type Timer = ReturnType<typeof setTimeout>;
  const timers = new Map<Timer, () => void>();
  const state = { mode: "server" as StorageMode, place: null as string | null, files: [file("first")] };
  const writes: { content: string; at: string | null }[] = [];
  const errors: (string | null)[] = [];
  const transport = { beforeWrite: async (_file: WorkspaceFile) => {}, fail: false };
  let revision = 0;
  const sync = new SaveScheduler({
    getMode: () => state.mode, getPlace: () => state.place,
    getFile: (path) => state.files.find((file) => file.path === path),
    put: async (file, at) => {
      writes.push({ content: file.content, at });
      await transport.beforeWrite(file);
      if (transport.fail) throw new Error("controlled failure");
      return { sha256: String(++revision) };
    },
    onError: (error) => { errors.push(error); },
    clock: {
      setTimeout: (run) => { const timer = {} as Timer; timers.set(timer, run); return timer; },
      clearTimeout: (timer) => { timers.delete(timer); },
    },
  });
  const tick = async () => {
    const due = [...timers.values()];
    timers.clear();
    due.forEach((run) => run());
    await Promise.resolve();
  };
  return { sync, state, writes, errors, transport, tick, timers };
}

test("debounce coalesces edits and waits for storage selection without sending seed content", async () => {
  const { sync, state, writes, tick, timers } = fixture();
  state.mode = "loading";
  sync.schedule("notes/a.md");
  state.files = [file("latest")];
  sync.schedule("notes/a.md");
  expect(timers.size).toBe(1);
  await tick();
  expect(writes).toEqual([]);
  expect(sync.busy("notes/a.md")).toBe(true);
  state.mode = "server";
  await tick();
  await sync.settle(null);
  expect(writes).toEqual([{ content: "latest", at: null }]);
  expect(sync.busy("notes/a.md")).toBe(false);
  expect(sync.hash("notes/a.md")).toBe("1");
  state.mode = "local";
  sync.schedule("notes/a.md");
  await tick();
  expect(writes).toHaveLength(1);
});

test("queued saves keep their captured content/place and cannot overtake a blocked write", async () => {
  const { sync, state, writes, transport, tick } = fixture();
  const first = deferred();
  transport.beforeWrite = async (file) => { if (file.content === "first") await first.promise; };
  sync.schedule("notes/a.md");
  await tick();
  state.files = [file("latest")];
  sync.schedule("notes/a.md");
  sync.flush();
  state.place = "another-node";
  state.files = [file("other place")];
  await Promise.resolve();
  expect(writes).toEqual([{ content: "first", at: null }]);
  expect(sync.busy("notes/a.md", null)).toBe(true);
  expect(sync.busy("notes/a.md", "another-node")).toBe(false);
  first.resolve();
  await sync.settle(null);
  expect(writes).toEqual([{ content: "first", at: null }, { content: "latest", at: null }]);
  expect(sync.hash("notes/a.md", null)).toBe("2");
  expect(sync.hash("notes/a.md", "another-node")).toBeUndefined();
});

test("failed saves protect drafts and block server-dependent actions until that file recovers", async () => {
  const { sync, state, writes, errors, transport } = fixture();
  transport.fail = true;
  sync.schedule("notes/a.md");
  await expect(sync.settle(null)).rejects.toThrow("haven't saved yet");
  expect(sync.busy("notes/a.md")).toBe(true);
  expect(errors.at(-1)).toBe("Couldn't save notes/a.md");
  transport.fail = false;
  state.files.push(file("unrelated", "notes/b.md"));
  sync.schedule("notes/b.md");
  await expect(sync.settle(null)).rejects.toThrow("haven't saved yet");
  expect(errors.at(-1)).toBe("Couldn't save notes/a.md");
  state.files = [file("recovered")];
  sync.schedule("notes/a.md");
  await sync.settle(null);
  expect(writes.map((write) => write.content)).toEqual(["first", "unrelated", "recovered"]);
  expect(sync.busy("notes/a.md")).toBe(false);
  expect(errors.at(-1)).toBeNull();
});

test("create tracking is scoped and cancel removes the debounce/hash before delete", async () => {
  const { sync, tick, writes } = fixture();
  sync.beginWrite("notes/a.md", "node");
  sync.beginWrite("notes/a.md", "node");
  expect(sync.busy("notes/a.md", "node")).toBe(true);
  expect(sync.busy("notes/a.md", null)).toBe(false);
  sync.endWrite("notes/a.md", "node");
  expect(sync.busy("notes/a.md", "node")).toBe(true);
  sync.endWrite("notes/a.md", "node");
  expect(sync.busy("notes/a.md", "node")).toBe(false);
  sync.remember("notes/a.md", "old");
  sync.schedule("notes/a.md");
  sync.cancel("notes/a.md");
  await tick();
  expect(writes).toEqual([]);
  expect(sync.hash("notes/a.md")).toBeUndefined();
  expect(sync.busy("notes/a.md")).toBe(false);
});

test("explicitly deleting a failed draft removes its protection and settle error", async () => {
  const { sync, state, transport, errors } = fixture();
  transport.fail = true;
  sync.schedule("notes/a.md");
  await expect(sync.settle(null)).rejects.toThrow("haven't saved yet");
  sync.cancel("notes/a.md");
  state.files = [];
  expect(sync.busy("notes/a.md")).toBe(false);
  await expect(sync.settle(null)).resolves.toBeUndefined();
  expect(errors.at(-1)).toBeNull();
});

test("deleting one failed file reports the remaining failure without clearing it", async () => {
  const { sync, state, transport, errors } = fixture();
  transport.fail = true;
  state.files.push(file("second", "notes/b.md"));
  sync.schedule("notes/a.md");
  await expect(sync.settle(null)).rejects.toThrow();
  sync.cancel("notes/healthy.md");
  expect(errors.at(-1)).toBe("Couldn't save notes/a.md");
  sync.schedule("notes/b.md");
  await expect(sync.settle(null)).rejects.toThrow();
  expect(errors.at(-1)).toBe("Couldn't save notes/b.md");
  sync.cancel("notes/b.md");
  expect(errors.at(-1)).toBe("Couldn't save notes/a.md");
  expect(sync.busy("notes/a.md")).toBe(true);
  await expect(sync.settle(null)).rejects.toThrow();
  sync.cancel("notes/a.md");
  await expect(sync.settle(null)).resolves.toBeUndefined();
  expect(errors.at(-1)).toBeNull();
});

test("leaving the workspace: unsaved edits are known, saved with failed ones retried, or discarded", async () => {
  const { sync, writes, errors, transport, tick, timers } = fixture();
  expect(sync.unsaved()).toBe(false);
  sync.schedule("notes/a.md");
  expect(sync.unsaved()).toBe(true);
  // Save: the waiting edit goes now, without its debounce.
  await sync.settleAll();
  expect(writes).toEqual([{ content: "first", at: null }]);
  expect(sync.unsaved()).toBe(false);

  // A failed save is still unsaved; Save tries it once more.
  transport.fail = true;
  sync.schedule("notes/a.md");
  await tick();
  await Promise.resolve();
  expect(sync.unsaved()).toBe(true);
  await expect(sync.settleAll()).rejects.toThrow(/haven't saved yet/);
  transport.fail = false;
  const sent = writes.length;
  await sync.settleAll();
  expect(writes).toHaveLength(sent + 1);
  expect(sync.unsaved()).toBe(false);
  expect(errors.at(-1)).toBeNull();

  // Discard: the waiting edit is never sent, and failures are forgotten.
  sync.schedule("notes/a.md");
  transport.fail = true;
  sync.schedule("notes/b.md");
  sync.discard();
  expect(timers.size).toBe(0);
  expect(sync.unsaved()).toBe(false);
  sync.flush();
  await Promise.resolve();
  expect(writes).toHaveLength(sent + 1);
});
