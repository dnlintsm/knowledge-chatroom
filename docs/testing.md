# Testing

Run from the repository root with Node 22. Root `pnpm install` installs the whole workspace.
The default test command runs only fast units; integration and E2E are explicit.

| Command | Services/credentials | Coverage |
| --- | --- | --- |
| `pnpm check` | None | ESLint, all TypeScript projects (root, web, agent, contracts), all unit tests |
| `pnpm test` / `pnpm test:unit` | None | Frontend pure tests and agent unit tests |
| `pnpm test:integration` | Disposable PostgreSQL + S3 | Storage, ACL/RLS, identity, events, experiments and HTTP |
| `pnpm test:conformance` | Disposable PostgreSQL + S3 | Every agent server operation (storage, memory, skills, hub, tools, ...) against `openapi/storage.yaml` |
| `pnpm test:e2e` | Chromium | Browser-only UI with canned AG-UI replies |
| `pnpm test:e2e:storage` | Chromium + PostgreSQL + S3 | Real storage, knowledge tree, experiments, runs and chat history with mock chat |
| `pnpm test:e2e:login` | Chromium + fresh PostgreSQL + S3 | Test OIDC login, sharing and read-only access |
| `pnpm test:e2e:python` | Chromium + uv (`uv sync --package agent-py`) | The chat on the Python agent (`services/agent-py`, `AGENT_URL`) with a real Claude Code engine and a scripted model: replies, a browser tool, a skill, follow-up chips |
| `pnpm test:live` | Chromium + Anthropic key | Opt-in live provider smoke coverage |

Units use `playwright.unit.config.ts`, start no server and do not require a
browser installation. Put new pure frontend specs under `tests/unit`. Agent test files
are listed one by one: service-free ones in `apps/agent/package.json` (`test:unit`), ones
that need PostgreSQL and S3 in `apps/agent/scripts/test-integration.mjs`. Add a new
`*.test.ts` to the matching list, or it never runs.

The Python side is one uv workspace (root `pyproject.toml`, one `uv.lock`):
`services/*` and `packages/knowledge-py`, each with its own pytest suite (Python 3.12+),
which CI runs on Python 3.12 and 3.14:

```bash
uv sync --all-packages
uv run --locked --no-sync ruff check packages/knowledge-py services examples/python-agent
uv run --locked --no-sync ruff format --check packages/knowledge-py services examples/python-agent
uv run --locked --no-sync pyrefly check --error-stale-baseline
cd services/papers-mcp        # or services/lab-tools, packages/knowledge-py
uv run pytest -q
```

The 3.12 CI run also reports coverage of handwritten Python source. It has no
percentage gate yet; use the report to identify important untested behavior.

Pyrefly checks the handwritten package and service source at the minimum supported Python
version. Existing findings are recorded in `pyrefly-baseline.json`; resolve them over time,
then run `uv run --locked --no-sync pyrefly check --prune-baseline`. Generated models and
tests are not yet included. The ordered baseline prevents new matching findings from being
silently absorbed. Do not regenerate the baseline merely to make CI pass.

## Disposable integration databases

The storage suite **drops the public schema** of `TEST_DATABASE_URL`. Never point
it at a personal or production database. Create separate databases in local compose:

```bash
docker compose up -d
docker compose exec postgres createdb -U knowledge knowledge_test
docker compose exec postgres createdb -U knowledge knowledge_e2e
docker compose exec postgres createdb -U knowledge knowledge_login
export TEST_DATABASE_URL=postgres://knowledge:knowledge@localhost:5432/knowledge_test
export S3_ENDPOINT=http://localhost:8333
export S3_ACCESS_KEY_ID=knowledge
export S3_SECRET_ACCESS_KEY=knowledge-secret
export S3_BUCKET=knowledge-test
export S3_PUBLIC_URL=http://localhost:8333
pnpm test:integration
```

Create each database once. This bucket name matches the integration fixtures and
avoids reserving separate SeaweedFS volume collections for each suite. Test blobs
are disposable. Missing `TEST_DATABASE_URL` or `S3_ENDPOINT` fails before testing;
integration does not fall back to `DATABASE_URL`.

`pnpm test:conformance` uses the same `TEST_DATABASE_URL` and S3 values. It resets the
database and starts the agent on it with a throwaway `AUTH_SECRET`. In front of the agent
it starts the Python API server (`services/api-py`, which needs uv), as `pnpm dev` does.
Then it runs `packages/contracts/conformance/storage.test.ts` through the API server
(`CONFORMANCE_TARGET=ts` runs it against the agent alone). That suite calls every operation in
`packages/contracts/openapi/storage.yaml` and fails when a status code isn't in the spec,
a JSON answer doesn't validate, an answer has a field the spec doesn't list, or an
operation was never called. It only speaks HTTP, so it can check any backend that
serves the storage API:
`STORAGE_URL=http://localhost:8010 AUTH_SECRET=... pnpm -C packages/contracts test:conformance`,
with the backend on a fresh database, since the suite's first user must become the
workspace owner, with `HUB_ADMINS=conformance|alice`, since that user also moderates
the skill hub and memory packs, and with `MEMORY=on` (and `MEMORY_LEARN=off`). When you add or change a route, add its calls there too.

With `CONFORMANCE_SAMPLES=<file>` the suite also writes every request and answer that
matched the spec to that file, one JSON line each. `packages/knowledge-py/tests/test_api.py`
parses them into the generated Python models (`knowledge_chatroom.api`) when
`API_SAMPLES` names the file, and checks no field is lost; CI does both:

```bash
CONFORMANCE_SAMPLES=/tmp/api-samples.jsonl pnpm test:conformance
cd packages/knowledge-py && API_SAMPLES=/tmp/api-samples.jsonl uv run pytest -q tests/test_api.py
```

After changing the spec, regenerate the models with `uv run datamodel-codegen` in
`packages/knowledge-py` (the Quality workflow runs it with `--check`).

The normal integration suite tests vector search using a deterministic embedder.
Set `EMBEDDING_TEST=1` to also run the real model-download test; it needs network
access and caches roughly 120 MB. For local UI tests, `EMBEDDING_MODEL=off` keeps
keyword-search coverage without downloading the model.

## Browser, storage and login

```bash
pnpm exec playwright install chromium
pnpm test:e2e
DATABASE_URL=postgres://knowledge:knowledge@localhost:5432/knowledge_e2e pnpm test:e2e:storage
DATABASE_URL=postgres://knowledge:knowledge@localhost:5432/knowledge_login pnpm test:e2e:login
```

Export the S3 values above before storage/login tests. Login uses a local mock
OIDC provider and a public test signing key supplied by the config. Its database
must be fresh so Alice is the first sign-in and owner; recreate only that test
database before a repeat login run. Browser mode clears storage/login settings.
All required modes ignore ambient Anthropic/Intelligence keys and launch mock
chat explicitly. Missing storage prerequisites fails instead of skipping cases.

The runner owns its servers and refuses existing ones. Defaults: UI 3000, mock
agent 8000, storage 8001 (the Python API server, in front of the storage agent on 8002), test OIDC 9400, Python agent 9300, scripted model
9500. Override `E2E_UI_PORT`, `E2E_AGENT_PORT`, `E2E_STORAGE_PORT`, `E2E_TS_STORAGE_PORT`, `E2E_OIDC_PORT`,
`E2E_PY_AGENT_PORT`, `E2E_MODEL_PORT` to isolate local runs. The storage and login
modes need uv for the API server. `E2E_API_PY=off` serves storage from the agent alone.

The Python mode runs `services/agent-py` with Claude Code pointed at
`e2e/mock-anthropic.mjs`, a stand-in for the Messages API that streams scripted turns
(a reply, a `writeWorkspaceFile` call, a TL;DR for `/tldr`), so the whole path from the
browser through the AG-UI adapter and the engine runs without a key. The mock agent
server hands that run its skills (`GET /skills/run`) and writes the follow-up chips.
`PLAYWRIGHT_CHROMIUM_PATH` selects an already installed Chromium.

CI builds first and serves that build. Locally the runner starts development
mode. Forward Playwright arguments after `--`, for example
`pnpm test:e2e -- --retries=0 --reporter=list`. Reports/videos/traces are
generated artifacts and are ignored by git. Preview screenshots go in `preview/`.

For an intentional live run, export `ANTHROPIC_API_KEY` and use `pnpm test:live`.
Live coverage may cost money and depends on the provider/network. Mock-specific
answer checks are excluded from live mode; it is not a replacement for required
mock coverage. It is not run by required CI.

## CI and failures

See [CI merge gates](ci.md) for the repository ruleset settings that enforce
successful checks before merging and for preview-step limits.

- `quality.yml`: the `checks` job (locked root/agent install, lint/types/units,
  unchanged lockfile) plus the `python` job: `uv sync --locked` and the pytest
  suites of `packages/knowledge-py` and every `services/*` project.
- `storage.yml`: real PostgreSQL/pgvector/S3 integration for storage-related changes,
  including the cached real embedding-model test (`EMBEDDING_TEST=1`), then the storage
  API conformance suite against the running agent.
- `ui-preview.yml`: the `preview` job: production build, explicit browser/storage/login
  runs, artifacts and the combined outcome in the preview comment.
- `docker.yml`: checks the compose file and builds the demo images when the
  `Dockerfile`, compose file, lockfiles or Python sample change.

Inspect the first failed assertion and retained trace, not just the screenshot.
Check test counts and skips in the list/TAP output. A prerequisite failure must
be fixed by providing disposable services, not by weakening an assertion. Tests
should cover observable behavior and boundaries rather than mirror an implementation.

## Workflow summaries

Each workflow appends a test-case table to the GitHub Actions job summary, with
passed, failed, skipped, cancelled, todo and flaky counts. Cases are counted once,
not once per retry. A step that never executes is shown as Not run; a failed runner
without a report is shown explicitly rather than as zero successful tests.
`scripts/ci-tests.mjs` retains failed commands' exit codes and rejects empty or
entirely skipped required suites. Local test commands keep their existing reporters.

## Synchronization regressions

`e2e/sync.spec.ts` drives the real provider with controlled HTTP/SSE transport:
ordered saves, navigation, failed writes, stale responses, reconnect, permission
revocation during a save, and storage outage/recovery. Failed edits in the current
place stay visible through remote events/reconnect until a subsequent edit saves;
a successful save of a different file must not hide their error. Permission
revocation changes the editor to read-only without replacing the unsaved content.
These drafts are held in memory: this policy does not promise durability across
reload or navigation after a failed save.

`e2e/sync-storage.spec.ts` runs only in storage mode. Two pages in one browser
context share a real workspace and receive its real stream. It checks both
persisted bytes and the other tab's editor, then confirms remote deletion closes
both tabs. Its fixture uses a dedicated note and removes it after testing.

## Chat history

`tests/unit/chat-history.spec.ts` checks the chat runner and history routes with
chats in memory: a chat replays after a new runner (as after a restart), and with
login on each user sees, continues and changes only their own chats. The storage
integration suite covers the `/chats` API and its row-level security, and
`e2e/chat-history.spec.ts` (storage mode) chats, finds the chat in Postgres,
reloads and reopens it from the history. `e2e/preview.spec.ts` does the same with
chats in memory.
