import { test, expect } from "@playwright/test";
import {
  DRIFT_LABEL,
  inputDrift,
  reader,
  rulesRecord,
  versionUrl,
  versionWith,
  type FileVersion,
  type RunRead,
} from "../../apps/web/src/components/workspace/run-evidence";
import { experimentPlace } from "../../apps/web/src/components/workspace/server-files";

const A = "a".repeat(64);
const B = "b".repeat(64);

function version(id: string, sha256: string, createdAt: string, author: FileVersion["author"] = "user"): FileVersion {
  return { id, sha256, size: 1, mime: "text/markdown", author, authorId: null, createdAt };
}

test("an input is compared by content, and a missing copy or record says so", () => {
  expect(inputDrift(A, true, A)).toBe("same");
  expect(inputDrift(A, true, B)).toBe("differs");
  // Writing the recorded bytes back makes it the same again: there is nothing else to compare.
  expect(inputDrift(A, true, A)).toBe("same");
  expect(inputDrift(A, false, undefined)).toBe("missing");
  expect(inputDrift(A, false, A)).toBe("missing");
  // A run recorded before inputs kept their hash.
  expect(inputDrift(undefined, true, A)).toBe("unrecorded");
  // Listed, but this browser doesn't know its version yet: no claim either way.
  expect(inputDrift(A, true, undefined)).toBe("unknown");
  expect(DRIFT_LABEL.same).toBeUndefined();
  expect(DRIFT_LABEL.unknown).toBeUndefined();
  expect(DRIFT_LABEL.differs).toBe("Content differs from the recorded input");
});

test("the recorded content is the first version that had those bytes", () => {
  // Newest first, as ?versions lists them.
  const versions = [version("v3", A, "2026-01-03T00:00:00Z"), version("v2", B, "2026-01-02T00:00:00Z"), version("v1", A, "2026-01-01T00:00:00Z")];
  expect(versionWith(versions, A)?.id).toBe("v1");
  expect(versionWith(versions, B)?.id).toBe("v2");
  expect(versionWith(versions, "c".repeat(64))).toBeNull();
  expect(versionUrl("inputs/a b.csv", experimentPlace("e1"), "v1")).toBe("/api/files/inputs/a%20b.csv?experiment=e1&version=v1");
});

test("the Rules row keeps to what was written while the run ran, what was read, and what was there at the end", () => {
  const versions = [
    version("after", B, "2026-01-01T12:00:00Z"),
    version("during", A, "2026-01-01T10:30:00Z", "agent"),
    version("before", B, "2026-01-01T09:00:00Z"),
  ];
  const reads: RunRead[] = [{ path: "models/general_rules.md", version: "during", sha256: A, via: "mcp:lab", readAt: "2026-01-01T10:31:00Z", by: null }];
  const started = { startedAt: "2026-01-01T10:00:00Z" };
  expect(rulesRecord(versions, reads, started).written.map((v) => v.id)).toEqual(["during", "after"]);
  expect(rulesRecord(versions, reads, started).atFinish).toBeUndefined();

  const finished = { ...started, finishedAt: "2026-01-01T11:00:00Z", files: { "models/general_rules.md": { version: "during", sha256: A } } };
  const record = rulesRecord(versions, reads, finished);
  expect(record.written.map((v) => v.id)).toEqual(["during"]);
  expect(record.read).toEqual(reads);
  expect(record.atFinish).toEqual({ version: "during", sha256: A });
  // Deleted before it finished; and a file that is gone has no versions to list.
  expect(rulesRecord(null, [], { ...finished, files: { "models/general_rules.md": null } })).toEqual({ written: [], read: [], atFinish: null });
});

test("a read names Claude or the tool server", () => {
  expect(reader("remote")).toBe("Claude");
  expect(reader("mcp:lab")).toBe("lab");
  expect(reader("other")).toBe("other");
});
