import { test, expect } from "@playwright/test";
import { SaveScheduler, type StorageMode } from "../../apps/web/src/components/workspace/save-scheduler";
import { FileChangedError, type WorkspaceFile } from "../../apps/web/src/components/workspace/types";

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
  // The version each save said it replaces (If-Match), in order.
  const replaced: (string | null | undefined)[] = [];
  const errors: (string | null)[] = [];
  const conflicts: string[][] = [];
  // `theirs`: someone else's version on the server, which the next save is refused over.
  const transport = { beforeWrite: async (_file: WorkspaceFile) => {}, fail: false, theirs: undefined as string | null | undefined };
  let revision = 0;
  const sync = new SaveScheduler({
    getMode: () => state.mode, getPlace: () => state.place,
    getFile: (path) => state.files.find((file) => file.path === path),
    put: async (file, at, replaces) => {
      writes.push({ content: file.content, at });
      replaced.push(replaces);
      await transport.beforeWrite(file);
      if (transport.fail) throw new Error("controlled failure");
      if (transport.theirs !== undefined && replaces !== transport.theirs) {
        throw new FileChangedError(file.path, transport.theirs);
      }
      transport.theirs = undefined;
      return { sha256: String(++revision) };
    },
    onError: (error) => { errors.push(error); },
    onConflict: (list) => { conflicts.push(list.map((c) => c.path)); },
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
  return { sync, state, writes, replaced, errors, conflicts, transport, tick, timers };
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

test("each save names the version the one before it made", async () => {
  const { sync, state, replaced, transport, tick } = fixture();
  sync.remember("notes/a.md", "opened");
  const first = deferred();
  transport.beforeWrite = async (file) => { if (file.content === "first") await first.promise; };
  sync.schedule("notes/a.md");
  await tick();
  // Typed on while the first save is on its way: the second waits, then replaces the first's version.
  state.files = [file("second")];
  sync.schedule("notes/a.md");
  sync.flush();
  first.resolve();
  await sync.settle(null);
  expect(replaced).toEqual(["opened", "1"]);
  // A file this browser never saw a version of (a new one) is saved without a precondition.
  state.files.push(file("new", "notes/new.md"));
  sync.schedule("notes/new.md");
  await sync.settle(null);
  expect(replaced.at(-1)).toBeUndefined();
});

test("a save over someone else's version is a conflict: edits stay, nothing more is sent, until one is chosen", async () => {
  const { sync, state, writes, replaced, errors, conflicts, transport } = fixture();
  sync.remember("notes/a.md", "opened");
  transport.theirs = "bobs";
  state.files = [file("mine")];
  sync.schedule("notes/a.md");
  await expect(sync.settle(null)).rejects.toThrow("notes/a.md was changed by someone else");
  expect(sync.conflict("notes/a.md")).toEqual({ path: "notes/a.md", at: null, sha256: "bobs" });
  expect(conflicts.at(-1)).toEqual(["notes/a.md"]);
  expect(errors.at(-1)).toContain("choose which version to keep");
  // Protected like an unsaved draft: change events and resync leave it alone.
  expect(sync.busy("notes/a.md")).toBe(true);
  expect(sync.unsaved()).toBe(true);
  expect(sync.hash("notes/a.md")).toBe("opened");

  // Typing on doesn't send anything while the conflict stands.
  state.files = [file("mine, more")];
  sync.schedule("notes/a.md");
  await expect(sync.settle(null)).rejects.toThrow("changed by someone else");
  expect(writes.map((w) => w.content)).toEqual(["mine"]);

  // They saved again meanwhile (a change event): keeping mine replaces that version.
  transport.theirs = "bobs-2";
  sync.theirs("notes/a.md", "bobs-2");
  await sync.keepMine("notes/a.md");
  expect(writes.map((w) => w.content)).toEqual(["mine", "mine, more"]);
  expect(replaced).toEqual(["opened", "bobs-2"]);
  expect(sync.conflict("notes/a.md")).toBeUndefined();
  expect(sync.busy("notes/a.md")).toBe(false);
  expect(sync.hash("notes/a.md")).toBe("1");
  expect(conflicts.at(-1)).toEqual([]);
  expect(errors.at(-1)).toBeNull();
  await expect(sync.settle(null)).resolves.toBeUndefined();
});

test("keeping mine over a version that was replaced again is refused again", async () => {
  const { sync, transport } = fixture();
  sync.remember("notes/a.md", "opened");
  transport.theirs = "bobs";
  sync.schedule("notes/a.md");
  await expect(sync.settle(null)).rejects.toThrow();
  transport.theirs = "carols"; // no change event reached this browser
  await sync.keepMine("notes/a.md");
  expect(sync.conflict("notes/a.md")?.sha256).toBe("carols");
  await sync.keepMine("notes/a.md");
  expect(sync.conflict("notes/a.md")).toBeUndefined();
});

test("a conflict with a deleted file: keeping mine saves it as a new file", async () => {
  const { sync, replaced, transport } = fixture();
  sync.remember("notes/a.md", "opened");
  transport.theirs = null;
  sync.schedule("notes/a.md");
  await expect(sync.settle(null)).rejects.toThrow();
  expect(sync.conflict("notes/a.md")?.sha256).toBeNull();
  // A known absence (null), not an unknown version: the save may only create the file.
  await sync.keepMine("notes/a.md");
  expect(replaced).toEqual(["opened", null]);
  expect(sync.conflict("notes/a.md")).toBeUndefined();
  expect(sync.hash("notes/a.md")).toBe("1");
});

test("keeping mine over a deleted file someone made again meanwhile is a conflict with their new file", async () => {
  const { sync, state, replaced, transport } = fixture();
  sync.remember("notes/a.md", "opened");
  transport.theirs = null;
  sync.schedule("notes/a.md");
  await expect(sync.settle(null)).rejects.toThrow();
  transport.theirs = "recreated"; // no change event reached this browser
  await sync.keepMine("notes/a.md");
  expect(replaced).toEqual(["opened", null]);
  expect(sync.conflict("notes/a.md")?.sha256).toBe("recreated");
  await sync.keepMine("notes/a.md");
  expect(replaced.at(-1)).toBe("recreated");
  expect(sync.conflict("notes/a.md")).toBeUndefined();
  // Back to ordinary saves: the next one names the version this one made.
  state.files = [file("later")];
  sync.schedule("notes/a.md");
  await sync.settle(null);
  expect(replaced.at(-1)).toBe("1");
});

test("taking theirs, leaving the place, deleting or discarding ends a conflict without sending mine", async () => {
  for (const end of ["theirs", "leave", "cancel", "discard"] as const) {
    const { sync, state, writes, errors, conflicts, transport, tick } = fixture();
    sync.remember("notes/a.md", "opened");
    transport.theirs = "bobs";
    sync.schedule("notes/a.md");
    await expect(sync.settle(null)).rejects.toThrow();
    state.files = [file("typed after the conflict")];
    sync.schedule("notes/a.md");
    if (end === "theirs") sync.dropConflict("notes/a.md");
    else if (end === "leave") sync.leave(null);
    else if (end === "cancel") sync.cancel("notes/a.md");
    else sync.discard();
    await tick();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sync.conflict("notes/a.md"), end).toBeUndefined();
    expect(conflicts.at(-1), end).toEqual([]);
    expect(errors.at(-1), end).toBeNull();
    expect(writes.map((w) => w.content), end).toEqual(["first"]);
    expect(sync.unsaved(), end).toBe(false);
  }
});

test("a conflict in one place doesn't hold up another, and outranks a plain failure in the message", async () => {
  const { sync, state, errors, transport } = fixture();
  sync.remember("notes/a.md", "opened", "node");
  state.place = "node";
  transport.theirs = "bobs";
  sync.schedule("notes/a.md");
  await expect(sync.settle("node")).rejects.toThrow("changed by someone else");
  await expect(sync.settle(null)).resolves.toBeUndefined();
  expect(sync.busy("notes/a.md", null)).toBe(false);
  state.files.push(file("b", "notes/b.md"));
  transport.fail = true;
  sync.schedule("notes/b.md");
  await expect(sync.settle("node")).rejects.toThrow();
  expect(errors.at(-1)).toContain("notes/a.md was changed by someone else");
});

test("it says when a version it knows of a file changes", () => {
  let told = 0;
  const sync = new SaveScheduler({
    getMode: () => "server", getPlace: () => null, getFile: () => undefined,
    put: async () => ({ sha256: "x" }), onError: () => {},
    onHashes: () => { told++; },
  });
  sync.remember("a.md", "1");
  expect(told).toBe(1);
  // The same version again is no change.
  sync.remember("a.md", "1");
  expect(told).toBe(1);
  sync.remember("a.md", "2");
  expect(told).toBe(2);
  expect(sync.forget("a.md")).toBe(true);
  expect(told).toBe(3);
  // Forgetting what it didn't know changes nothing.
  expect(sync.forget("a.md")).toBe(false);
  sync.cancel("a.md");
  expect(told).toBe(3);
});
