# Contributing

Set up a working copy with [Development](docs/development.md). This page is what to do
before you open a pull request, and where things live.

## Before opening a pull request

Run the checks for what you changed. CI runs the same ones
([CI merge gates](docs/ci.md)).

**Web app, contracts, scripts**

```bash
pnpm check:web
```

```bash
pnpm build
```

`check:web` is lint, types and the unit tests that need no server. Use `pnpm test:e2e` for
browser changes.

**Python services** (`services/*`, `packages/knowledge-py`)

```bash
uv run --locked --no-sync ruff check packages/knowledge-py services examples/python-agent
```

```bash
uv run --locked --no-sync ruff format --check packages/knowledge-py services examples/python-agent
```

```bash
uv run --locked --no-sync pyrefly check --error-stale-baseline
```

```bash
uv run pytest -q
```

Without `TEST_DATABASE_URL` and `S3_ENDPOINT`, api-py's storage tests are skipped. A change
to storage, access, memory or skills needs them, plus `pnpm test:conformance` and the
storage and login E2E runs. [Testing](docs/testing.md) has the disposable services and the
exact commands.

**The API contract** (`packages/contracts/openapi/storage.yaml`)

The spec is the source of truth for every route api-py serves. When a route, a status code
or a field changes, change the spec, the conformance suite and both generated models in the
same pull request:

```bash
pnpm -C packages/contracts openapi
```

```bash
cd packages/knowledge-py && uv run --locked datamodel-codegen
```

## What a pull request needs

- **Keep it small**, and about one thing. A fix found on the way that isn't part of it goes
  in its own commit, and says so.
- **Say what behaviour changed** and anything an operator or user will notice (a new
  setting, a refused request that used to go through).
- **Say how you checked it**: which suites you ran, and what you did not test.
- **A test for the change.** A bug fix comes with the test that failed before it.
- **UI changes** add a `shot()` step to `e2e/preview.spec.ts` (or the storage specs), so the
  preview comment on the pull request shows the change.
- **Docs in the same pull request**: the guide under `docs/` that describes the behaviour.
  A setting gets a row in [docs/settings.md](docs/settings.md), which `pnpm check:web`
  compares with the code, and an entry in `.env.example` when people are meant to set it.
  The changelog is written at release time.
- **A setting that is removed or renamed** adds a row to `MIGRATIONS` in
  `scripts/env-upgrade-plan.mjs`, so `pnpm env:upgrade` can carry people over.

Security problems are reported privately: see [SECURITY.md](SECURITY.md).

## Project map

| Directory | Responsibility |
| --- | --- |
| `apps/web` | The Next.js UI (`@knowledge-chatroom/web`) |
| `apps/web/src/app` | Next.js routes, providers, authentication, and storage proxies |
| `apps/web/src/components/workspace` | File/editor UI, workbench controls, admin panel, and workspace state |
| `apps/web/src/hooks` | Starter examples (charts, meeting picker) |
| `services/api-py` | Python storage, access, skills, memory and suggestions API at `LOCAL_AGENT_URL` |
| `services/api-py/migrations` | Database schema and access policies |
| `services/api-py/skills` | Built-in skills (`analysis`, `paper-search`, `tldr`, `write-skill`) |
| `services/agent-py` | The chat agent in Python, served to the app through `AGENT_URL` |
| `services/papers-mcp` | Paper search (OpenAlex + arXiv) as an MCP server for Claude |
| `services/lab-tools` | The Python agent sample's tools as an MCP server |
| `packages/contracts` | `@knowledge-chatroom/contracts`: contracts the UI shares with the backend (files, identity tokens, text edits, and the storage API's OpenAPI spec in `openapi/storage.yaml`) and the API conformance suite |
| `packages/knowledge-py` | `knowledge_chatroom`: identity, storage and memory clients shared by the Python services |
| `examples/python-agent` | Guide: bringing a Python agent in (its prompt as a skill, its tools as `services/lab-tools`) |
| `scripts` | The E2E and conformance runners, CI summaries, and `env:check`/`env:upgrade` |
| `infra/seaweedfs` | The S3 store's local credentials (`s3.json`) used by compose and CI |
| `tests/unit` | Pure frontend tests without an application server or browser |
| `e2e` | UI specs, mock AG-UI agent, and test OIDC provider |
| `.github/workflows` | Quality checks, storage tests, and UI previews |

The UI uses Next.js/React and CopilotKit. The chat agent runs the Claude Agent SDK
(Python) over AG-UI; optional server storage uses PostgreSQL and an S3-compatible store.

Working with a coding agent? [AGENTS.md](AGENTS.md) has the rules it should keep.
