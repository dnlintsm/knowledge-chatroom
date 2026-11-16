import { localAgentUrl } from "./agent-target";
import { IDENTITY_HEADER, authSecret, identityHeader, type SessionUser } from "./auth";
import { DEFAULT_SLUG, type WorkspaceInfo } from "./workspace-request";

/**
 * Which workspace a page's `/w/<slug>` names (issue #226, docs/workspaces.md):
 * looked up once, on the server, among the user's own workspaces, which the
 * API server (services/api-py) lists at GET /workspaces.
 *
 * - found: the user belongs to it.
 * - missing: there is no such workspace, or it isn't the user's (the same
 *   answer for both, as the API server gives).
 * - unavailable: the server has no workspaces (the agent server alone, or no
 *   storage, answers 404), or can't be reached right now. The default
 *   workspace still opens then, as before workspaces; others can't.
 */
export type WorkspaceLookup =
  | { status: "found"; workspace: WorkspaceInfo }
  | { status: "missing" }
  | { status: "unavailable"; reason: "none" | "down" };

const ROLES = new Set(["owner", "admin", "member"]);

function parseWorkspaces(body: unknown): WorkspaceInfo[] | null {
  const list = (body as { workspaces?: unknown } | null)?.workspaces;
  if (!Array.isArray(list)) return null;
  return list.flatMap((w) => {
    const { id, slug, name, role } = (w ?? {}) as Record<string, unknown>;
    return typeof id === "string" && typeof slug === "string" && typeof name === "string" && typeof role === "string" && ROLES.has(role)
      ? [{ id, slug, name, role: role as WorkspaceInfo["role"] }]
      : [];
  });
}

/** The user's workspaces, or why there are none to list. `user` is null without login. */
export async function listWorkspaces(
  user: SessionUser | null,
  base = localAgentUrl(),
): Promise<WorkspaceInfo[] | { unavailable: "none" | "down" }> {
  const headers = new Headers();
  if (user && authSecret()) headers.set(IDENTITY_HEADER, identityHeader(user));
  let res: Response;
  try {
    res = await fetch(`${base}/workspaces`, { headers, cache: "no-store", signal: AbortSignal.timeout(10_000) });
  } catch {
    return { unavailable: "down" };
  }
  if (res.status === 404 || res.status === 405) {
    await res.body?.cancel();
    return { unavailable: "none" };
  }
  const list = res.ok ? parseWorkspaces(await res.json().catch(() => null)) : null;
  if (!res.ok) await res.body?.cancel();
  return list ?? { unavailable: "down" };
}

/** The workspace `/w/<slug>` names for `user`. */
export async function findWorkspace(user: SessionUser | null, slug: string, base?: string): Promise<WorkspaceLookup> {
  const listed = await listWorkspaces(user, base);
  if (!Array.isArray(listed)) return { status: "unavailable", reason: listed.unavailable };
  const wanted = slug.toLowerCase();
  const workspace = listed.find((w) => w.slug === wanted);
  return workspace ? { status: "found", workspace } : { status: "missing" };
}

/** Where `/` and other URLs without a workspace go: the default workspace, keeping the query. */
export function defaultWorkspacePath(search = ""): string {
  const query = search && !search.startsWith("?") ? `?${search}` : search;
  return `/w/${DEFAULT_SLUG}${query === "?" ? "" : query}`;
}
