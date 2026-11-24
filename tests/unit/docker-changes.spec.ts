import { test, expect } from "@playwright/test";
import { affectedImages, allImages } from "../../scripts/docker-changes.mjs";

const build = (...images: string[]) => ({ images, compose: false });

test("application source builds the image that packages it", () => {
  expect(affectedImages(["apps/web/src/app/page.tsx"])).toEqual(build("app"));
  expect(affectedImages(["services/api-py/api_py/app.py"])).toEqual(build("api-py"));
  expect(affectedImages(["services/agent-py/agent_py/app.py"])).toEqual(build("agent-py"));
  expect(affectedImages(["services/lab-tools/lab_tools/server.py"])).toEqual(build("lab-tools"));
  expect(affectedImages(["services/papers-mcp/papers_mcp/server.py"])).toEqual(build("papers-mcp"));
});

test("api-py's migrations and built-in skills build its image", () => {
  expect(affectedImages(["services/api-py/migrations/0009_example.sql"])).toEqual(build("api-py"));
  expect(affectedImages(["services/api-py/skills/tldr/SKILL.md"])).toEqual(build("api-py"));
});

test("shared inputs build every image that uses them", () => {
  for (const path of ["packages/contracts/openapi/storage.yaml", "pnpm-lock.yaml", "package.json", "pnpm-workspace.yaml", "apps/web/package.json", "Dockerfile"]) {
    expect(affectedImages([path]), path).toEqual(build("app"));
  }
  for (const path of ["uv.lock", "pyproject.toml", "packages/knowledge-py/src/knowledge_chatroom/api.py"]) {
    expect(affectedImages([path]), path).toEqual(build("api-py", "agent-py", "lab-tools", "papers-mcp"));
  }
  expect(affectedImages([".dockerignore"])).toEqual(allImages());
  expect(affectedImages([".github/workflows/docker.yml"])).toEqual(allImages());
});

test("compose changes run only the compose check", () => {
  expect(affectedImages(["docker-compose.yml"])).toEqual({ images: [], compose: true });
  expect(affectedImages(["infra/seaweedfs/s3.json"])).toEqual({ images: [], compose: true });
});

test("changes outside the images build nothing", () => {
  expect(affectedImages(["docs/ci.md", "README.md", "e2e/login.spec.ts", "tests/unit/x.spec.ts", ".github/workflows/quality.yml"])).toEqual(build());
  expect(affectedImages(["SECURITY.md", "CONTRIBUTING.md", "AGENTS.md", "CLAUDE.md", ".github/pull_request_template.md"])).toEqual(build());
});

test("a rename or deletion counts on both sides", () => {
  // The workflow lists a rename as a deletion plus an addition (git diff --no-renames).
  expect(affectedImages(["apps/web/src/old.tsx", "services/api-py/api_py/new.py"])).toEqual(build("app", "api-py"));
  expect(affectedImages(["services/lab-tools/lab_tools/gone.py"])).toEqual(build("lab-tools"));
});

test("anything without a rule builds everything", () => {
  for (const path of ["tsconfig.json", "scripts/ci-changes.mjs", ".python-version", "new-dir/file"]) {
    expect(affectedImages([path]), path).toEqual(allImages());
  }
  // A prefix match needs the directory separator.
  expect(affectedImages(["services/api-py-v2/app.py"])).toEqual(allImages());
});
