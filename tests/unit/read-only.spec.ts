import { test, expect } from "@playwright/test";
import { readOnlyReason } from "../../apps/web/src/components/workspace/read-only";
import type { Experiment } from "../../apps/web/src/components/workspace/server-files";

/** Why a place is read only (apps/web/src/components/workspace/read-only.ts), #187. */

const exp = (fields: Partial<Experiment>) =>
  ({ access: "reader", status: "shared", mine: false, authorName: "Alice", ...fields }) as Experiment;
const at = (experiment: Experiment | null, placeRole: "viewer" | "editor" | "owner" | null = "viewer") =>
  readOnlyReason({ experiment, placeRole, placeName: "Main etch" });

test("an experiment you can change, or a node you can edit, has no reason", () => {
  expect(at(exp({ access: "writer", mine: true }))).toBeNull();
  expect(at(null, "editor")).toBeNull();
  expect(at(null, "owner")).toBeNull();
});

test("an archived experiment says so; only its author is told to restore it", () => {
  const own = at(exp({ status: "archived", mine: true }))!;
  expect(own.kind).toBe("archived");
  expect(own.label).toBe("Read only · archived");
  expect(own.detail).toBe("Archived, so it's read only. Restore it to change it.");
  const theirs = at(exp({ status: "archived" }))!;
  expect(theirs.detail).toBe("Archived, so it's read only. Only Alice can restore it. Rerun it to work on your own copy.");
});

test("someone else's experiment names its author and offers a rerun", () => {
  const reason = at(exp({}))!;
  expect(reason.kind).toBe("not-author");
  expect(reason.label).toBe("Read only · only Alice can edit");
  expect(reason.detail).toBe("Only Alice can edit this experiment. Rerun it to work on your own copy.");
  expect(at(exp({ authorName: null }))!.label).toBe("Read only · only its author can edit");
  // Rerun is offered only where the user may start one.
  const noRerun = readOnlyReason({ experiment: exp({}), placeRole: "viewer", placeName: "Main etch", canRerun: false })!;
  expect(noRerun.detail).toBe("Only Alice can edit this experiment.");
});

test("view access to a node says where, without naming who could grant more", () => {
  const reason = at(null, "viewer")!;
  expect(reason.kind).toBe("view-only");
  expect(reason.detail).toBe("You can view Main etch but not edit it.");
  expect(at(null, null)!.kind).toBe("view-only");
});
