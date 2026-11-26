/**
 * What the Pipelines screen and the Run view say about pipelines
 * (docs/pipeline-identities.md): their places, operations, keys and status,
 * and what a Run ran as. Pure, so the wording is tested on its own.
 */
import type { components } from "@knowledge-chatroom/contracts/generated/storage-api";

type Schema = components["schemas"];
export type Pipeline = Schema["Pipeline"];
export type PipelineKey = Schema["PipelineKey"];
export type NewPipelineKey = Schema["NewPipelineKey"];
export type PipelinePlace = Schema["PipelinePlace"];
export type PipelineOperation = Schema["PipelineOperation"];
export type RunExecution = Schema["RunExecution"];

/** The operations, in the order the form lists them, each with what it allows. */
export const OPERATIONS: { id: PipelineOperation; label: string; allows: string }[] = [
  { id: "read", label: "Read", allows: "Read files, nodes, Experiments, Runs and search in its places" },
  { id: "write", label: "Write", allows: "Write files in Experiments; propose changes in Knowledge" },
  { id: "runs", label: "Runs", allows: "Create Experiments, and start, finish and label Runs" },
  { id: "upload", label: "Upload", allows: "Upload finished Experiments, adding nodes where its owner can edit" },
];

/** How long a new key lasts, in days; 90 is the default. */
export const KEY_LIFETIMES = [30, 90, 180, 365] as const;
export const DEFAULT_KEY_DAYS = 90;
/** A pipeline holds at most this many live keys, so one can replace another. */
export const MAX_LIVE_KEYS = 2;

export const STATUS_LABEL: Record<Pipeline["status"], string> = {
  active: "Active",
  suspended: "Suspended",
  revoked: "Revoked",
};

/** Why a status is what it is, for the line under a pipeline's name; nothing when it is active. */
export function statusNote(pipeline: Pick<Pipeline, "status">): string | null {
  if (pipeline.status === "suspended") return "Suspended: its owner is no longer a member. An Owner or Admin can hand it over.";
  if (pipeline.status === "revoked") return "Revoked: its keys stop at once, and it can't be turned back on.";
  return null;
}

/** Names for places, from what the reader can see; anything else is "a place you can't see". */
export interface PlaceNames {
  node: (id: string) => string | undefined;
  experiment: (id: string) => string | undefined;
}

/** "the whole workspace", or "Etch, Module 3 and 1 Experiment you can't see". */
export function placesText(places: PipelinePlace[] | null | undefined, names: PlaceNames): string {
  if (places == null) return "the whole workspace";
  const named: string[] = [];
  let hidden = 0;
  for (const place of places) {
    const name = "node" in place ? names.node(place.node) : names.experiment(place.experiment);
    if (name) named.push(name);
    else hidden += 1;
  }
  if (hidden) named.push(hidden === 1 ? "1 place you can't see" : `${hidden} places you can't see`);
  return list(named) || "no places";
}

/** "read, runs", in the form's order. */
export function operationsText(operations: readonly PipelineOperation[] | undefined): string {
  const chosen = new Set(operations ?? []);
  return OPERATIONS.filter((op) => chosen.has(op.id))
    .map((op) => op.id)
    .join(", ");
}

/** A key as a list shows it: "…a1b2". */
export const keyName = (key: Pick<PipelineKey, "hint">) => `…${key.hint}`;

/** The keys that still work, which count towards MAX_LIVE_KEYS. */
export const liveKeys = (pipeline: Pick<Pipeline, "keys">) => pipeline.keys.filter((k) => k.status === "active");

/** How many keys that no longer work a card lists, newest first, after every live one. */
export const PAST_KEYS_SHOWN = 2;

/**
 * The keys a pipeline's card lists: every live key, so each keeps its revoke
 * button and last use, then the newest few that stopped. A revoked key is
 * left out while the pipeline still works; once it's revoked, they all are.
 */
export function shownKeys(pipeline: Pick<Pipeline, "keys" | "status">): PipelineKey[] {
  const live = liveKeys(pipeline);
  const past = pipeline.keys
    .filter((k) => k.status !== "active" && (k.status !== "revoked" || pipeline.status === "revoked"))
    .slice(-PAST_KEYS_SHOWN);
  return [...live, ...past.reverse()];
}

/**
 * A key's lifetime as a request sends it. The default is left to the server,
 * which keeps it within its own limit (PIPELINE_KEY_MAX_DAYS), so a server
 * with a lower limit still takes it.
 */
export function keyLifetime(days: number): { expiresInDays?: number } {
  return days === DEFAULT_KEY_DAYS ? {} : { expiresInDays: days };
}

/** What the owner and the workspace's Owners and Admins may do with a pipeline. */
export function pipelineActions(pipeline: Pipeline, me: string | null, manages: boolean) {
  const owns = !!me && pipeline.owner?.id === me;
  const live = pipeline.status !== "revoked";
  return {
    /** A key of their own: only its owner makes one, while it isn't revoked. */
    addKey: owns && live && liveKeys(pipeline).length < MAX_LIVE_KEYS,
    revokeKey: (owns || manages) && live,
    revoke: (owns || manages) && live,
    handOver: manages && live,
  };
}

/**
 * The body a new pipeline is made with, or why the form can't send it yet.
 * `places` null is the whole workspace; an empty list is not allowed.
 */
export function newPipelineBody(form: {
  name: string;
  whole: boolean;
  places: PipelinePlace[];
  operations: PipelineOperation[];
  days: number;
}): { body: { name: string; places: PipelinePlace[] | null; operations: PipelineOperation[]; expiresInDays?: number } } | { problem: string } {
  const name = form.name.replace(/\s+/g, " ").trim();
  if (!name) return { problem: "Give it a name" };
  if (!form.whole && form.places.length === 0) return { problem: "Choose at least one place, or the whole workspace" };
  if (form.operations.length === 0) return { problem: "Choose at least one operation" };
  return {
    body: {
      name,
      places: form.whole ? null : form.places,
      operations: OPERATIONS.map((op) => op.id).filter((id) => form.operations.includes(id)),
      ...keyLifetime(form.days),
    },
  };
}

/** What a Run ran as, for its "Ran as" row; null for a Run from before it was recorded. */
export function ranAsText(execution: RunExecution | undefined): string | null {
  if (!execution) return null;
  return identityText(execution.ranAs, execution.initiatedBy.name);
}

/** Whose access a Run used and how, for its "Authorized by" row. */
export function authorizedByText(execution: RunExecution | undefined, names: PlaceNames): string | null {
  if (!execution) return null;
  return authorityText(execution.authorizedBy, execution.initiatedBy.name, names);
}

/** Who finished a Run, when it wasn't who started it the same way; null otherwise. */
export function finishedByText(execution: RunExecution | undefined): string | null {
  const finished = execution?.finishedBy;
  if (!execution || !finished) return null;
  const same =
    finished.user.id === execution.initiatedBy.id &&
    finished.ranAs.kind === execution.ranAs.kind &&
    (finished.ranAs.key ?? null) === (execution.ranAs.key ?? null) &&
    (finished.ranAs.via ?? null) === (execution.ranAs.via ?? null);
  return same ? null : identityText(finished.ranAs, finished.user.name);
}

type Identity = RunExecution["ranAs"];
type Authority = RunExecution["authorizedBy"];

function identityText(ranAs: Identity, person: string | null | undefined): string {
  const who = person || "someone";
  if (ranAs.kind === "pipeline") {
    const key = ranAs.hint ? `, key …${ranAs.hint}` : "";
    return `Pipeline ${ranAs.name ?? "(unnamed)"}${key}, for ${who}`;
  }
  if (ranAs.kind === "agent") {
    const via = ranAs.via ?? "";
    if (via.startsWith("mcp:")) return `Claude, through ${via.slice(4)}, for ${who}`;
    return `Claude, in ${possessive(who)} chat`;
  }
  return who;
}

function authorityText(authority: Authority, person: string | null | undefined, names: PlaceNames): string {
  const whose = `${possessive(person || "someone")} access`;
  if (authority.kind === "pipeline-key") {
    const where = authority.places == null ? "the whole workspace" : placesText(authority.places, names);
    return `${whose}, narrowed to ${where}: ${operationsText(authority.operations) || "no operations"}`;
  }
  if (authority.kind === "storage-token") return `${whose}, through Claude`;
  return `${whose}, signed in`;
}

const possessive = (name: string) => (name.endsWith("s") ? `${name}'` : `${name}'s`);

/** "A", "A and B", "A, B and C". */
function list(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/**
 * An audit entry about a pipeline, in the Activity tab's words ("made the
 * pipeline Nightly import"); null for any other action. `pipeline` names one
 * by id when the reader can see it, `person` a user by id.
 */
export function pipelineActivity(
  action: string,
  target: Record<string, unknown>,
  pipeline: (id: unknown) => string | undefined,
  person: (id: unknown) => string,
): string | null {
  const name = typeof target.name === "string" ? target.name : pipeline(target.pipeline);
  const which = name ? `the pipeline ${name}` : "a pipeline";
  switch (action) {
    case "pipeline.create":
      return `made ${which}`;
    case "pipeline.update":
      return `changed ${which}`;
    case "pipeline.handover": {
      const revoked = Number(target.keysRevoked ?? 0);
      const keys = revoked ? `, revoking ${revoked === 1 ? "its key" : `its ${revoked} keys`}` : "";
      return `handed ${which} over to ${person(target.toUser)}${keys}`;
    }
    case "pipeline.revoke":
      return `revoked ${which}`;
    case "pipeline.key.create":
      return `made a key for ${which}`;
    case "pipeline.key.revoke":
      return `revoked a key of ${which}`;
    default:
      return null;
  }
}
