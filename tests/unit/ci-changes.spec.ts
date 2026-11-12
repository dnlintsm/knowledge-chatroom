import { test, expect } from "@playwright/test";
import { affectedSuites, allSuites } from "../../scripts/ci-changes.mjs";

const none = { node: false, python: false, browser: false, storage: false, pyagent: false };

test("documentation-only changes skip every suite", () => {
  expect(affectedSuites(["docs/ci.md", "README.md", "CHANGELOG.md"])).toEqual(none);
});

test("Python services run only the E2E suites that start them", () => {
  expect(affectedSuites(["services/papers-mcp/papers_mcp/server.py"])).toEqual({ ...none, python: true });
  expect(affectedSuites(["services/api-py/api_py/app.py"])).toEqual({ ...none, python: true, storage: true });
  expect(affectedSuites(["services/agent-py/agent_py/app.py"])).toEqual({ ...none, python: true, pyagent: true });
  expect(affectedSuites(["uv.lock"])).toEqual({ ...none, python: true, storage: true, pyagent: true });
  expect(affectedSuites(["packages/knowledge-py/src/knowledge_chatroom/api.py"])).toEqual({ ...none, python: true, storage: true, pyagent: true });
});

test("suites from several paths add up", () => {
  expect(affectedSuites(["services/api-py/x.py", "services/agent-py/y.py", "docs/a.md"])).toEqual({ ...none, python: true, storage: true, pyagent: true });
});

test("anything without a rule runs every suite", () => {
  for (const path of ["apps/web/src/app/page.tsx", "packages/contracts/openapi/storage.yaml", ".github/workflows/quality.yml", "e2e/login.spec.ts", "scripts/ci-changes.mjs", "apps/agent/skills/tldr/SKILL.md", "pnpm-lock.yaml", "new-dir/file"]) {
    expect(affectedSuites([path]), path).toEqual(allSuites());
  }
  // A prefix match needs the directory separator.
  expect(affectedSuites(["docs-site/index.html"])).toEqual(allSuites());
  expect(affectedSuites(["services/api-py-v2/app.py"])).toEqual(allSuites());
});
