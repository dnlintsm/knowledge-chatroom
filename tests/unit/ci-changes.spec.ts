import { test, expect } from "@playwright/test";
import { affectedSuites, allSuites } from "../../scripts/ci-changes.mjs";

const none = { node: false, python: false, browser: false, storage: false, pyagent: false };

test("documentation-only changes skip every suite", () => {
  expect(affectedSuites(["docs/ci.md", "README.md", "CHANGELOG.md"])).toEqual(none);
  // The project's own guides and templates, outside docs/.
  expect(affectedSuites([
    "SECURITY.md", "CONTRIBUTING.md", "AGENTS.md", "CLAUDE.md",
    ".github/pull_request_template.md", ".github/ISSUE_TEMPLATE/bug_report.md",
  ])).toEqual(none);
  // The settings reference is compared with the code by a unit test.
  expect(affectedSuites(["docs/settings.md"])).toEqual({ ...none, node: true });
  // A workflow is not documentation: it still runs everything.
  expect(affectedSuites([".github/workflows/quality.yml"])).toEqual(allSuites());
});

test("Python services run only the E2E suites that start them", () => {
  expect(affectedSuites(["services/papers-mcp/papers_mcp/server.py"])).toEqual({ ...none, python: true });
  expect(affectedSuites(["services/api-py/api_py/app.py"])).toEqual({ ...none, python: true, storage: true });
  expect(affectedSuites(["services/agent-py/agent_py/app.py"])).toEqual({ ...none, python: true, storage: true, pyagent: true });
  expect(affectedSuites(["uv.lock"])).toEqual({ ...none, python: true, storage: true, pyagent: true });
  expect(affectedSuites(["packages/knowledge-py/src/knowledge_chatroom/api.py"])).toEqual({ ...none, python: true, storage: true, pyagent: true });
});

test("api-py's migrations and built-in skills run every suite", () => {
  for (const path of ["services/api-py/migrations/024_example.sql", "services/api-py/skills/tldr/SKILL.md"]) {
    expect(affectedSuites([path]), path).toEqual(allSuites());
  }
});

test("suites from several paths add up", () => {
  expect(affectedSuites(["services/api-py/x.py", "services/agent-py/y.py", "docs/a.md"])).toEqual({ ...none, python: true, storage: true, pyagent: true });
});

test("anything without a rule runs every suite", () => {
  for (const path of ["apps/web/src/app/page.tsx", "packages/contracts/openapi/storage.yaml", ".github/workflows/quality.yml", "e2e/login.spec.ts", "scripts/ci-changes.mjs", "pnpm-lock.yaml", "new-dir/file"]) {
    expect(affectedSuites([path]), path).toEqual(allSuites());
  }
  // A prefix match needs the directory separator.
  expect(affectedSuites(["docs-site/index.html"])).toEqual(allSuites());
  expect(affectedSuites(["services/api-py-v2/app.py"])).toEqual(allSuites());
});
