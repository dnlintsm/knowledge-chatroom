import { test, expect } from "@playwright/test";
import { stopThreadId } from "../../apps/web/src/lib/chat-routes";

/** Which requests the copilotkit route treats as "stop this thread" (issue #297). */

test("a stop request names its thread, with or without a trailing slash", () => {
  expect(stopThreadId("/agent/default/stop/t-1")).toBe("t-1");
  expect(stopThreadId("/agent/default/stop/t-1/")).toBe("t-1");
  expect(stopThreadId("/agent/default/stop/a%20b")).toBe("a b");
  // A malformed id is left for the runtime to answer.
  expect(stopThreadId("/agent/default/stop/%E0%A4%A")).toBe("%E0%A4%A");
});

test("something in front of the path doesn't hide a stop request from the owner check", () => {
  // The runtime routes by the end of the path, so these reach its stop handler too.
  expect(stopThreadId("/x/agent/default/stop/t-1")).toBe("t-1");
  expect(stopThreadId("/a/b/agent/suggester/stop/t-2/")).toBe("t-2");
});

test("other requests aren't stop requests", () => {
  for (const path of ["/agent/default/run", "/agent/default/stop", "/agent/default/stop/t/extra", "/xagent/default/stop/t", "/info", ""]) {
    expect(stopThreadId(path), path).toBeNull();
  }
});
