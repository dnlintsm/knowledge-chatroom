import { test, expect } from "@playwright/test";

import {
  assignableRoles,
  canRemove,
  experimentPeople,
  inventoryMatches,
  namesMatch,
  settingsFor,
  transferSteps,
} from "../../apps/web/src/lib/workspace-admin";

/** What the people and settings screens offer (issue #255, docs/workspaces.md, "Changing a role"). */

test("Owners give any role; Admins promote Members and step down; Members change nothing", () => {
  for (const target of ["owner", "admin", "member"] as const) {
    expect(assignableRoles("owner", target, false)).toEqual(["owner", "admin", "member"]);
    expect(assignableRoles("member", target, false)).toEqual([]);
  }
  expect(assignableRoles("owner", "owner", true)).toEqual(["owner", "admin", "member"]);
  expect(assignableRoles("admin", "member", false)).toEqual(["admin", "member"]);
  expect(assignableRoles("admin", "admin", false)).toEqual([]);
  expect(assignableRoles("admin", "owner", false)).toEqual([]);
  expect(assignableRoles("admin", "admin", true)).toEqual(["admin", "member"]);
  expect(assignableRoles("member", "member", true)).toEqual([]);
});

test("Owners remove anyone else, Admins only Members, and nobody removes themselves here", () => {
  expect(canRemove("owner", "owner", false)).toBe(true);
  expect(canRemove("owner", "admin", false)).toBe(true);
  expect(canRemove("owner", "owner", true)).toBe(false);
  expect(canRemove("admin", "member", false)).toBe(true);
  expect(canRemove("admin", "admin", false)).toBe(false);
  expect(canRemove("admin", "owner", false)).toBe(false);
  expect(canRemove("member", "member", false)).toBe(false);
});

test("Owners and Admins rename; only Owners archive, and never the default workspace", () => {
  expect(settingsFor("owner", false)).toEqual({ rename: true, archive: true });
  expect(settingsFor("owner", true)).toEqual({ rename: true, archive: false });
  expect(settingsFor("admin", false)).toEqual({ rename: true, archive: false });
  expect(settingsFor("member", false)).toEqual({ rename: false, archive: false });
});

test("archiving is confirmed by the workspace's name, as a person reads it", () => {
  expect(namesMatch("Etch lab", "Etch lab")).toBe(true);
  expect(namesMatch("  Etch   lab ", "Etch lab")).toBe(true);
  expect(namesMatch("etch lab", "Etch lab")).toBe(false);
  expect(namesMatch("Etch", "Etch lab")).toBe(false);
  expect(namesMatch("   ", "   ")).toBe(false);
});

test("a transfer makes them Owner first, then gives Full access, then lowers your role", () => {
  const steps = transferSteps("ws 1", "me", "them", { fullAccess: true, myRole: "admin" });
  expect(steps).toEqual([
    { path: "/api/workspaces/ws%201/members/them", method: "PATCH", body: { role: "owner" } },
    {
      path: "/api/access/grants",
      method: "POST",
      body: { node: null, principalType: "user", principalId: "them", role: "owner" },
    },
    { path: "/api/workspaces/ws%201/members/me", method: "PATCH", body: { role: "admin" } },
  ]);
  // Sharing ownership: you stay an Owner, and they keep the access they have.
  expect(transferSteps("w", "me", "them", { fullAccess: false, myRole: "owner" })).toEqual([
    { path: "/api/workspaces/w/members/them", method: "PATCH", body: { role: "owner" } },
  ]);
});

test("the maintainer manages an Experiment's people; Owners and Admins hand over a departed maintainer's shared one", () => {
  const exp = (fields: Partial<Parameters<typeof experimentPeople>[0]>) => ({
    mine: false,
    status: "shared" as const,
    maintainerIsMember: true,
    collaborators: [{ id: "carol" }],
    ...fields,
  });
  const none = { collaborators: false, handOver: false, leave: false };
  expect(experimentPeople(exp({ mine: true }), { id: "me", role: "member" })).toEqual({
    collaborators: true,
    handOver: true,
    leave: false,
  });
  // A maintainer who is still a member: nobody else hands it over, Owners included.
  expect(experimentPeople(exp({}), { id: "me", role: "owner" })).toEqual(none);
  expect(experimentPeople(exp({ maintainerIsMember: false }), { id: "me", role: "admin" })).toEqual({
    ...none,
    handOver: true,
  });
  expect(experimentPeople(exp({ maintainerIsMember: false, status: "archived" }), { id: "me", role: "owner" }).handOver).toBe(true);
  // Never a draft (they can't see one), and never by a Member.
  expect(experimentPeople(exp({ maintainerIsMember: false, status: "draft" }), { id: "me", role: "owner" })).toEqual(none);
  expect(experimentPeople(exp({ maintainerIsMember: false }), { id: "me", role: "member" })).toEqual(none);
  // A collaborator may stop collaborating.
  expect(experimentPeople(exp({}), { id: "carol", role: "member" })).toEqual({ ...none, leave: true });
  expect(experimentPeople(exp({}), { id: null, role: null })).toEqual(none);
});

test("the inventory's filter finds a workspace by name, address or an Owner, case ignored", () => {
  const w = {
    id: "w",
    slug: "etch-lab",
    name: "Etch lab",
    status: "active" as const,
    createdAt: "2026-11-17T00:00:00.000Z",
    createdBy: null,
    memberCount: 3,
    owners: [{ id: "o", name: "Gina", email: "gina@example.com", lastSeenAt: null }],
    lastActiveAt: null,
    fullAccessHeld: false,
  };
  for (const q of ["", "  ", "etch", "ETCH-LAB", "gina", "Gina@Example", " lab "]) expect(inventoryMatches(w, q), q).toBe(true);
  for (const q of ["litho", "carol"]) expect(inventoryMatches(w, q), q).toBe(false);
});
