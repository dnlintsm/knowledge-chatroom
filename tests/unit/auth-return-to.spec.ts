import { test, expect } from "@playwright/test";
import { safeReturnTo } from "../../src/lib/auth";

/** Where the app sends users after sign-in (src/lib/auth.ts, issue #64). */

const APP = "https://app.example";
const landsOn = (value: string | null) => new URL(safeReturnTo(value), APP);

test("ordinary paths on the app are kept", () => {
  expect(safeReturnTo("/")).toBe("/");
  expect(safeReturnTo("/files/notes.md")).toBe("/files/notes.md");
  expect(safeReturnTo("/?file=a.md&tab=2#top")).toBe("/?file=a.md&tab=2#top");
  expect(safeReturnTo("/a/../b")).toBe("/b");
});

test("missing or non-path values fall back to the home page", () => {
  for (const value of [null, "", "files", "https://outside.example/", "javascript:alert(1)"]) {
    expect(safeReturnTo(value)).toBe("/");
  }
});

test("nothing can leave the app's origin", () => {
  const attempts = [
    "//outside.example",
    "/\\outside.example",
    "/\\/outside.example",
    "\\\\outside.example",
    "/\n/outside.example",
    "/\t/outside.example",
    "/\r/outside.example",
    "/\u0000/outside.example",
    "/\u007f/outside.example",
    "/x/..//outside.example",
    "/./outside.example/../..//outside.example",
    "/%2F%2Foutside.example",
    "/ //outside.example",
  ];
  for (const value of attempts) {
    expect(landsOn(value).origin, JSON.stringify(value)).toBe(APP);
  }
  // The case reported in issue #64.
  expect(safeReturnTo("/\n/outside.example")).toBe("/");
});
