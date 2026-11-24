/**
 * The one helper every browser call to this app's `/api/…` goes through, so
 * each one names the workspace the page is in (docs/workspaces.md,
 * "How a request finds its workspace"). The page resolves its `/w/<slug>` to
 * an id once (src/app/w/[slug]/page.tsx) and sets it here; fetches then carry
 * it as the X-Knowledge-Workspace header, and plain links, images and
 * EventSource, which can't send headers, as `?workspace=<id>`. The app's
 * proxy forwards both to the API server unchanged.
 *
 * Switching workspace cancels every request still pending, and an answer that
 * arrives after the switch is dropped (it throws an AbortError), so nothing
 * from the old workspace lands in the new one.
 *
 * Without a workspace (no workspaces API: the e2e mock, or api-py without
 * storage) requests name none, which means the default workspace.
 */

export const WORKSPACE_HEADER = "X-Knowledge-Workspace";
export const WORKSPACE_PARAM = "workspace";

let current: { id: string | null; controller: AbortController } = { id: null, controller: new AbortController() };

/** The workspace requests are sent for now; null for none (the default workspace). */
export function requestWorkspace(): string | null {
  return current.id;
}

/**
 * Sends later requests for workspace `id`. When that changes, every request
 * sent for the previous one is cancelled.
 */
export function setRequestWorkspace(id: string | null): void {
  if (id === current.id) return;
  current.controller.abort(switched());
  current = { id, controller: new AbortController() };
}

const switched = () => new DOMException("The workspace changed", "AbortError");

/** Whether `url` is one of this app's own API routes, the only ones that get the workspace. */
function isAppApi(url: string): boolean {
  if (url.startsWith("/api/")) return true;
  if (typeof window === "undefined") return false;
  try {
    const parsed = new URL(url, window.location.href);
    return parsed.origin === window.location.origin && parsed.pathname.startsWith("/api/");
  } catch {
    return false;
  }
}

/**
 * `url` with `?workspace=<id>` added, for a request that can't carry the
 * header: an EventSource, a link, an image or a download. Unchanged without a
 * workspace, or when it isn't one of this app's API routes.
 */
export function workspaceUrl(url: string, id: string | null = current.id): string {
  if (!id || !isAppApi(url)) return url;
  const hash = url.indexOf("#");
  const [base, fragment] = hash === -1 ? [url, ""] : [url.slice(0, hash), url.slice(hash)];
  const query = base.indexOf("?");
  if (query !== -1 && new URLSearchParams(base.slice(query + 1)).has(WORKSPACE_PARAM)) return url;
  const separator = query === -1 ? "?" : /[?&]$/.test(base) ? "" : "&";
  return `${base}${separator}${WORKSPACE_PARAM}=${encodeURIComponent(id)}${fragment}`;
}

/**
 * fetch, for the workspace the page is in: this app's API routes get the
 * X-Knowledge-Workspace header. Cancelled when the workspace changes, along
 * with `init.signal`; an answer that comes after the change throws an
 * AbortError instead of being returned.
 *
 * A request that already names its workspace (the header in `init.headers`,
 * e.g. a save scheduled before a switch) goes to that workspace as it is,
 * never to the page's, and a switch doesn't cancel it.
 */
export async function workspaceFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const { id, controller } = current;
  const headers = new Headers(init.headers);
  const named = headers.get(WORKSPACE_HEADER);
  if (id && !named && isAppApi(input)) headers.set(WORKSPACE_HEADER, id);
  // Bound to its own workspace: no switch can move it, so none cancels it.
  if (named) return fetch(input, { ...init, headers });
  const signal = init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal;
  const res = await fetch(input, { ...init, headers, signal });
  if (controller.signal.aborted) {
    await res.body?.cancel().catch(() => {});
    throw controller.signal.reason ?? switched();
  }
  return res;
}

/** Whether `err` is a request cancelled on purpose (a workspace switch, or the caller's own signal). */
export function isAborted(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

/** A workspace the user belongs to, as the API server lists it (GET /workspaces). */
export interface WorkspaceInfo {
  id: string;
  slug: string;
  name: string;
  role: "owner" | "admin" | "member";
  /** "archived" only in the list of archived workspaces an Owner may restore. */
  status?: "active" | "archived";
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Whether `id` can name a workspace (a lower-case UUID); anything else names none of them. */
export const isWorkspaceId = (id: string) => UUID.test(id);

/**
 * The workspace a request to this app's server names in its
 * X-Knowledge-Workspace header (lower-cased): null for none (the default
 * workspace), undefined when what it names can't be a workspace.
 */
export function workspaceFromHeaders(headers: Headers | Record<string, string> | undefined): string | null | undefined {
  const raw =
    headers instanceof Headers
      ? headers.get(WORKSPACE_HEADER)
      : Object.entries(headers ?? {}).find(([name]) => name.toLowerCase() === WORKSPACE_HEADER.toLowerCase())?.[1];
  const value = raw?.trim().toLowerCase();
  if (!value) return null;
  return isWorkspaceId(value) ? value : undefined;
}

/** The default workspace's slug, which `/` and URLs without a workspace go to. */
export const DEFAULT_SLUG = "default";
