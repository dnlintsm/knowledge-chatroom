import type { components } from "@knowledge-chatroom/contracts/generated/storage-api";
import { RULES_FILE } from "./rules";
import { apiFetch, fileUrl, type PlaceId, type RunProvenance } from "./server-files";

/**
 * What a run keeps as evidence, as the run panel and Claude see it
 * (docs/run-evidence.md): whether each recorded input still has the bytes it
 * was recorded with, and which versions of its Rules were written and read.
 */

type Schema = components["schemas"];
export type FileVersion = Schema["FileVersion"];
export type RunRead = Schema["RunRead"];

/**
 * How a recorded input compares with its copy under inputs/ now: by content,
 * so writing the recorded bytes back makes it the same again. "unknown" while
 * this browser doesn't know the copy's version yet.
 */
export type InputDrift = "same" | "differs" | "missing" | "unrecorded" | "unknown";

export function inputDrift(recorded: string | undefined, exists: boolean, now: string | undefined): InputDrift {
  if (!exists) return "missing";
  if (!recorded) return "unrecorded";
  if (now === undefined) return "unknown";
  return now === recorded ? "same" : "differs";
}

export const DRIFT_LABEL: Partial<Record<InputDrift, string>> = {
  differs: "Content differs from the recorded input",
  missing: "No longer in inputs/",
  unrecorded: "Not recorded",
};

/**
 * The version with these bytes, the first one that had them (versions come
 * newest first, as ?versions lists them); null when none has them any more.
 */
export function versionWith(versions: FileVersion[], sha256: string): FileVersion | null {
  for (let i = versions.length - 1; i >= 0; i--) if (versions[i].sha256 === sha256) return versions[i];
  return null;
}

const withParam = (url: string, param: string) => `${url}${url.includes("?") ? "&" : "?"}${param}`;

/** One of a file's own versions, read only (GET /files/<path>?version=). */
export const versionUrl = (path: string, place: PlaceId, id: string) =>
  withParam(fileUrl(path, place), `version=${encodeURIComponent(id)}`);

/** A live file's versions, newest first; null when there is no such file (any more). */
export async function listVersions(path: string, place: PlaceId): Promise<FileVersion[] | null> {
  const res = await apiFetch(withParam(fileUrl(path, place), "versions"), { cache: "no-store" });
  if (!res.ok) return null;
  return ((await res.json()) as Schema["VersionList"]).versions;
}

/** The Rules versions a run's agents read while it ran, first read first; null when they can't be read. */
export async function listRunReads(experimentId: string): Promise<RunRead[] | null> {
  const res = await apiFetch(`/api/experiments/${encodeURIComponent(experimentId)}/reads`, { cache: "no-store" });
  if (!res.ok) return null;
  return ((await res.json()) as { reads: RunRead[] }).reads;
}

/**
 * The copy's version with the recorded bytes, for "View recorded" and for
 * Claude to read with read_file's `version`. One fetch per copy and version of
 * it, shared by everyone asking.
 */
const recorded = new Map<string, Promise<FileVersion | null>>();
export function recordedVersion(path: string, place: PlaceId, sha256: string, now: string): Promise<FileVersion | null> {
  const key = `${place ?? ""}\n${path}\n${sha256}\n${now}`;
  let found = recorded.get(key);
  if (!found) {
    found = listVersions(path, place)
      .then((versions) => (versions ? versionWith(versions, sha256) : null))
      .catch(() => null);
    // A new version of the copy is a new key, so this never goes stale.
    recorded.set(key, found);
  }
  return found;
}

export type RecordedInput = NonNullable<RunProvenance["inputs"]>[number];

/** Who read it: Claude in the chat, or the tool server that did. */
export function reader(via: string): string {
  if (via === "remote") return "Claude";
  return via.startsWith("mcp:") ? via.slice(4) : via;
}

/** What the Rules row shows of a run: what was written while it ran, what was read, and what was there at the end. */
export interface RulesRecord {
  /** Versions written while it ran, oldest first. */
  written: FileVersion[];
  read: RunRead[];
  /** The version when it finished; null when there was none; undefined before it finished. */
  atFinish: { version: string; sha256: string } | null | undefined;
}

export function rulesRecord(versions: FileVersion[] | null, reads: RunRead[], p: RunProvenance): RulesRecord {
  const start = p.startedAt ? Date.parse(p.startedAt) : -Infinity;
  const end = p.finishedAt ? Date.parse(p.finishedAt) : Infinity;
  const written = (versions ?? [])
    .filter((v) => {
      const at = Date.parse(v.createdAt);
      return at >= start && at <= end;
    })
    .reverse();
  const atFinish = p.files && RULES_FILE in p.files ? p.files[RULES_FILE] : undefined;
  return { written, read: reads, atFinish };
}
