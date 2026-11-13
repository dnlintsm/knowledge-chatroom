import type { IncomingMessage } from "node:http";

import type { Membership } from "./access";
import type { Storage } from "./index";

/**
 * Which workspace a request acts in (issue #226, docs/workspaces.md, "How a
 * request finds its workspace"), as services/api-py/api_py/workspaces.py
 * resolves it: the X-Knowledge-Workspace header, the `?workspace=` parameter
 * and a token's `ws` claim must agree, and naming none means the default
 * workspace. A token without `ws` (a legacy one) is bound to the default
 * workspace. An unknown, malformed or foreign workspace answers 404, the same
 * for all three, and never falls back to the default one.
 */

export const WS_HEADER = "x-knowledge-workspace";
export const WS_PARAM = "workspace";
export const NOT_FOUND = "Workspace not found";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class WorkspaceError extends Error {
  constructor(
    readonly status: 400 | 404,
    message: string,
  ) {
    super(message);
  }
}

/** The workspaces the header and the query parameter name (as sent, lower-cased). */
export function namedSelectors(req: Pick<IncomingMessage, "headers">, url: URL): string[] {
  const header = req.headers[WS_HEADER];
  const named = [Array.isArray(header) ? header[0] : header, url.searchParams.get(WS_PARAM) ?? undefined];
  return named.filter((v): v is string => v !== undefined).map((v) => v.trim().toLowerCase());
}

/** What a token without `ws` (a legacy one) is bound to: the default workspace. */
export const LEGACY_TOKEN = "legacy:default";

/** The workspace a token is bound to; undefined when the request carries no token. */
export type Bound = string | undefined;

/** A token's `ws` claim, or LEGACY_TOKEN when it has none. */
export function tokenWorkspace(claims: { ws?: unknown }): string {
  return typeof claims.ws === "string" ? claims.ws : LEGACY_TOKEN;
}

/**
 * `storage` acting in the request's workspace, and the user's role there.
 * Throws WorkspaceError (400 when the selectors disagree, 404 when the
 * workspace is unknown, malformed, archived or not the user's).
 */
export async function resolveWorkspace(
  storage: Storage,
  req: Pick<IncomingMessage, "headers">,
  url: URL,
  userId: string,
  bound: Bound = undefined,
): Promise<{ storage: Storage; membership: Membership }> {
  const chosen = new Set(namedSelectors(req, url));
  if (bound !== undefined) chosen.add(bound === LEGACY_TOKEN ? storage.defaultWorkspaceId : bound.toLowerCase());
  if (chosen.size > 1) throw new WorkspaceError(400, "The request names more than one workspace");
  const id = chosen.size ? [...chosen][0] : storage.defaultWorkspaceId;
  if (!UUID.test(id)) throw new WorkspaceError(404, NOT_FOUND);
  const view = storage.inWorkspace(id);
  const membership = await view.access.membership(userId);
  if (!membership) throw new WorkspaceError(404, NOT_FOUND);
  return { storage: view, membership };
}

/**
 * For the routes this server still serves for the default workspace only (the
 * storage and skills APIs, which the Python API server in front serves for
 * every workspace): a 400 message when the request names another one, by
 * selector or token, rather than serve it in the wrong workspace; else null.
 */
export function onlyDefault(storage: Storage, req: Pick<IncomingMessage, "headers">, url: URL, bound: Bound = undefined): string | null {
  const named = new Set(namedSelectors(req, url));
  if (bound !== undefined) named.add(bound === LEGACY_TOKEN ? storage.defaultWorkspaceId : bound.toLowerCase());
  if (named.size > 1) return "The request names more than one workspace";
  if (named.size && !named.has(storage.defaultWorkspaceId)) {
    return "This server serves the default workspace only; other workspaces go through the API server (services/api-py)";
  }
  return null;
}
