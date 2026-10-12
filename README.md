# knowledge-chatroom

An IDE-style knowledge workspace with editable files, a knowledge tree,
experiments and Claude chat. The Next.js UI talks to a TypeScript Claude Agent SDK
agent over [AG-UI](https://docs.ag-ui.com), using [CopilotKit](https://copilotkit.ai).

Files can stay in this browser or sync through PostgreSQL and S3-compatible
storage. Optional OpenID Connect login supports sharing and read-only access.
The left pane explores knowledge/files, the middle pane previews or edits them,
and the right pane chats with Claude using the open file and selection as context.

## Quick start

Use **Node 22** (`.nvmrc`) and npm. A real chat needs an Anthropic API key; unit
and mock browser tests do not.

```bash
nvm use                        # if using nvm
cp .env.example .env            # add ANTHROPIC_API_KEY for real chat
npm ci                         # also installs agent/ from its lockfile
npm run dev                    # UI :3000, agent :8000
```

Open <http://localhost:3000>. Enable server storage and login using the instructions
in [Development](docs/development.md). Keep local credentials in `.env`.

## Contributor guide

- [Development](docs/development.md): dependencies, local services and environment variables.
- [Testing](docs/testing.md): fast checks, integration, E2E and CI coverage.
- [Architecture](docs/architecture.md): component boundaries, file APIs, access and experiments.
- [Deployment](docs/deployment.md): production build, private agent, login and storage.

Before opening a PR:

```bash
npm run check                  # lint + frontend/agent types + service-free units
npm run build                  # production compile, including TypeScript checks
```

Use `npm run test:e2e` for browser changes; storage changes also need the integration
and storage/login E2E suites described in [Testing](docs/testing.md). Keep changes
small, add coverage for changed behavior and explain validation in the PR.

## Project map

| Directory | Responsibility |
| --- | --- |
| `src/app` | Next.js routes, providers, authentication and storage proxies |
| `src/components/workspace` | File/editor UI, workbench API and workspace state |
| `src/app/declarative-generative-ui`, `src/hooks` | Starter examples and A2UI renderers |
| `agent/src` | Claude adapter, AG-UI server and storage services/tools |
| `agent/src/storage/migrations` | Ordered database schema and access policies |
| `tests/unit` | Frontend pure tests, no application server or browser |
| `e2e` | Browser/storage/login specs, mock AG-UI and OIDC providers |
| `.github/workflows` | Fast quality gate, real storage tests and UI previews |

## PR previews

UI preview CI builds the app and runs deterministic browser, server-storage and
login tests. Screenshots and a walkthrough GIF appear in a sticky PR comment;
videos, traces and reports are attached as artifacts. Adding an Anthropic secret
does not change required mock coverage. Live provider smoke tests are opt-in.
Images on the `ui-previews` branch are removed when the PR closes.

## Origin and license

Based on CopilotKit's MIT-licensed
[claude-sdk-typescript starter](https://github.com/CopilotKit/CopilotKit/tree/main/examples/integrations/claude-sdk-typescript).
See [LICENSE](LICENSE), [Claude Agent SDK](https://docs.claude.com/en/api/agent-sdk/overview),
[CopilotKit docs](https://docs.copilotkit.ai) and [Next.js docs](https://nextjs.org/docs).
