import { test, expect } from "@playwright/test";
import { NextRequest } from "next/server";
import { requestWithHeaders } from "../../apps/web/src/lib/request-forwarding";

test("NextRequest JSON reaches the runtime through Node's Request with replaced headers", async () => {
  const next = new NextRequest("http://localhost/api/copilotkit/agent/default/run?x=1", {
    method: "POST",
    headers: { "content-type": "application/json", "x-knowledge-user": "untrusted" },
    body: JSON.stringify({ threadId: "t-1", messages: [{ role: "user", content: "hello" }] }),
  });
  const headers = new Headers(next.headers);
  headers.set("x-knowledge-user", "signed");
  const forwarded = await requestWithHeaders(next, headers);
  expect(forwarded).toBeInstanceOf(Request);
  expect(forwarded.url).toBe(next.url);
  expect(forwarded.method).toBe("POST");
  expect(forwarded.headers.get("x-knowledge-user")).toBe("signed");
  expect(await forwarded.json()).toEqual({ threadId: "t-1", messages: [{ role: "user", content: "hello" }] });
});

test("GET forwarding has no body and carries cancellation", async () => {
  const controller = new AbortController();
  const next = new NextRequest("http://localhost/api/copilotkit/info", { signal: controller.signal });
  const forwarded = await requestWithHeaders(next, new Headers());
  expect(forwarded.body).toBeNull();
  controller.abort();
  expect(forwarded.signal.aborted).toBe(true);
});
