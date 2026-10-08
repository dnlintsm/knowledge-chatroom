import { test, expect } from "@playwright/test";
import { hasRole, roleName } from "../../src/components/workspace/roles";

/** The role check actions run through (src/components/workspace/roles.ts). */

test("roles include the ones below them", () => {
  expect(hasRole("owner", "editor")).toBe(true);
  expect(hasRole("editor", "editor")).toBe(true);
  expect(hasRole("viewer", "viewer")).toBe(true);
  expect(hasRole("viewer", "editor")).toBe(false);
  expect(hasRole("editor", "owner")).toBe(false);
});

test("no access allows nothing", () => {
  expect(hasRole(null, "viewer")).toBe(false);
  expect(roleName(null)).toBe("without access");
  expect(roleName("viewer")).toBe("a viewer");
  expect(roleName("owner")).toBe("an owner");
});
