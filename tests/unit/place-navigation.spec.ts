import { test, expect } from "@playwright/test";
import { createPlaceNavigator } from "../../src/components/workspace/place-navigation";
import type { ServerFile } from "../../src/components/workspace/server-files";

function deferred() {
  let resolve!: (files: ServerFile[]) => void;
  const promise = new Promise<ServerFile[]>((done) => { resolve = done; });
  return { promise, resolve };
}

test("a slower previous navigation cannot commit after the latest move", async () => {
  const older = deferred();
  const latest = deferred();
  let place: string | null = null;
  const applied: (string | null)[] = [];
  const enter = createPlaceNavigator({
    getMode: () => "server", getPlace: () => place,
    list: (id) => id === "older" ? older.promise : latest.promise,
    apply: async (id) => { place = id; applied.push(id); },
  });
  const first = enter("older");
  const second = enter("latest");
  latest.resolve([]);
  expect(await second).toBe(true);
  older.resolve([]);
  expect(await first).toBe(false);
  expect(place).toBe("latest");
  expect(applied).toEqual(["latest"]);
});

test("local/same-place/unavailable moves do not replace files or flush drafts", async () => {
  let mode: "local" | "server" = "local";
  let listed = 0;
  let applied = 0;
  const enter = createPlaceNavigator({
    getMode: () => mode, getPlace: () => "here",
    list: async (id) => { listed++; return id === "starting" ? "starting" : null; },
    apply: async () => { applied++; },
  });
  expect(await enter("elsewhere")).toBe(false);
  mode = "server";
  expect(await enter("here")).toBe(true);
  expect(listed).toBe(0);
  expect(await enter("gone")).toBe(false);
  expect(await enter("starting")).toBe(false);
  expect(applied).toBe(0);
});
