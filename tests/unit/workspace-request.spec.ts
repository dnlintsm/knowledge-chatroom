import { test, expect } from "@playwright/test";

import {
  WORKSPACE_HEADER,
  isAborted,
  requestWorkspace,
  setRequestWorkspace,
  workspaceFetch,
  workspaceFromHeaders,
  workspaceUrl,
} from "../../apps/web/src/lib/workspace-request";

/**
 * The one request helper the browser sends every /api call through (issue
 * #226, docs/workspaces.md): it names the page's workspace, and a switch
 * cancels what was still pending for the old one.
 */

const WS1 = "11111111-2222-4333-8444-555555555555";
const WS2 = "66666666-7777-4888-9999-aaaaaaaaaaaa";

test.describe("workspace requests", () => {
  const originalFetch = globalThis.fetch;
  test.afterEach(() => {
    globalThis.fetch = originalFetch;
    setRequestWorkspace(null);
  });

  test("API calls carry the workspace header; others don't", async () => {
    const sent: Headers[] = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      sent.push(new Headers(init?.headers));
      return new Response("{}");
    }) as typeof fetch;

    await workspaceFetch("/api/files");
    expect(sent[0].get(WORKSPACE_HEADER)).toBeNull(); // none: the default workspace

    setRequestWorkspace(WS1);
    expect(requestWorkspace()).toBe(WS1);
    await workspaceFetch("/api/files", { headers: { "Content-Type": "text/plain" } });
    expect(sent[1].get(WORKSPACE_HEADER)).toBe(WS1);
    expect(sent[1].get("content-type")).toBe("text/plain");
    await workspaceFetch("https://elsewhere.example.com/api/x");
    expect(sent[2].get(WORKSPACE_HEADER)).toBeNull();
  });

  test("switching cancels pending requests and drops late answers", async () => {
    let answer!: (res: Response) => void;
    let seen: AbortSignal | undefined;
    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
      seen = init?.signal ?? undefined;
      return new Promise<Response>((resolve) => (answer = resolve));
    }) as typeof fetch;

    setRequestWorkspace(WS1);
    const pending = workspaceFetch("/api/files");
    setRequestWorkspace(WS2);
    expect(seen?.aborted).toBe(true);
    // A server that answers anyway: the answer still doesn't reach the caller.
    answer(new Response("old workspace's files"));
    const err = await pending.catch((e: unknown) => e);
    expect(isAborted(err)).toBe(true);

    // Setting the same workspace again changes nothing.
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen = init?.signal ?? undefined;
      return new Response("ok");
    }) as typeof fetch;
    setRequestWorkspace(WS2);
    expect(await (await workspaceFetch("/api/files")).text()).toBe("ok");
    expect(seen?.aborted).toBe(false);
  });

  test("a request that names its workspace keeps it after a switch", async () => {
    // A save scheduled in WS1 that is sent once the page is in WS2 still goes to WS1.
    const sent: { ws: string | null; aborted: boolean | undefined }[] = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      sent.push({ ws: new Headers(init?.headers).get(WORKSPACE_HEADER), aborted: init?.signal?.aborted });
      return new Response("{}");
    }) as typeof fetch;
    setRequestWorkspace(WS2);
    const res = await workspaceFetch("/api/files/notes/a.md", { method: "PUT", headers: { [WORKSPACE_HEADER]: WS1 } });
    expect(res.ok).toBe(true);
    expect(sent).toEqual([{ ws: WS1, aborted: undefined }]);
  });

  test("the caller's own signal still cancels", async () => {
    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) =>
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)),
      )) as typeof fetch;
    setRequestWorkspace(WS1);
    const mine = new AbortController();
    const pending = workspaceFetch("/api/search?q=x", { signal: mine.signal });
    mine.abort(new DOMException("mine", "AbortError"));
    expect(isAborted(await pending.catch((e: unknown) => e))).toBe(true);
  });

  test("links, images and EventSource name the workspace in the URL", () => {
    expect(workspaceUrl("/api/files?watch")).toBe("/api/files?watch"); // no workspace yet
    setRequestWorkspace(WS1);
    expect(workspaceUrl("/api/files?watch")).toBe(`/api/files?watch&workspace=${WS1}`);
    expect(workspaceUrl("/api/memory/export")).toBe(`/api/memory/export?workspace=${WS1}`);
    expect(workspaceUrl("/api/files/a.png?node=n&v=1#top")).toBe(`/api/files/a.png?node=n&v=1&workspace=${WS1}#top`);
    expect(workspaceUrl(`/api/files?workspace=${WS1}`)).toBe(`/api/files?workspace=${WS1}`);
    expect(workspaceUrl("data:image/png;base64,AAAA")).toBe("data:image/png;base64,AAAA");
    expect(workspaceUrl("/api/x", WS2)).toBe(`/api/x?workspace=${WS2}`);
  });

  test("the server reads the workspace a request names", () => {
    expect(workspaceFromHeaders(new Headers())).toBeNull();
    expect(workspaceFromHeaders(new Headers({ [WORKSPACE_HEADER]: ` ${WS1.toUpperCase()} ` }))).toBe(WS1);
    expect(workspaceFromHeaders({ "x-knowledge-workspace": WS2 })).toBe(WS2);
    expect(workspaceFromHeaders({ "x-knowledge-workspace": "default" })).toBeUndefined();
    expect(workspaceFromHeaders({ "x-knowledge-workspace": "" })).toBeNull();
    expect(workspaceFromHeaders(undefined)).toBeNull();
  });
});
