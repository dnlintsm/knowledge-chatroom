# Testing

Run from the repository root with Node 22. Root `npm ci` installs both packages.
The default test command runs only fast units; integration and E2E are explicit.

| Command | Services/credentials | Coverage |
| --- | --- | --- |
| `npm run check` | None | ESLint, both TypeScript projects, all unit tests |
| `npm test` / `npm run test:unit` | None | Frontend pure tests and agent unit tests |
| `npm run test:integration` | Disposable PostgreSQL + S3 | Storage, ACL/RLS, identity, events, experiments and HTTP |
| `npm run test:e2e` | Chromium | Browser-only UI with canned AG-UI replies |
| `npm run test:e2e:storage` | Chromium + PostgreSQL + S3 | Real storage/knowledge/experiments with mock chat |
| `npm run test:e2e:login` | Chromium + fresh PostgreSQL + S3 | Test OIDC login, sharing and read-only access |
| `npm run test:live` | Chromium + Anthropic key | Opt-in live provider smoke coverage |

Units use `playwright.unit.config.ts`, start no server and do not require a
browser installation. Put new pure frontend specs under `tests/unit`.

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
npm run test:integration
```

Create each database once. This bucket name matches the integration fixtures and
avoids reserving separate SeaweedFS volume collections for each suite. Test blobs
are disposable. Missing `TEST_DATABASE_URL` or `S3_ENDPOINT` fails before testing;
integration does not fall back to `DATABASE_URL`.

## Browser, storage and login

```bash
npx playwright install chromium
npm run test:e2e
DATABASE_URL=postgres://knowledge:knowledge@localhost:5432/knowledge_e2e npm run test:e2e:storage
DATABASE_URL=postgres://knowledge:knowledge@localhost:5432/knowledge_login npm run test:e2e:login
```

Export the S3 values above before storage/login tests. Login uses a local mock
OIDC provider and a public test signing key supplied by the config. Its database
must be fresh so Alice is the first sign-in and owner; recreate only that test
database before a repeat login run. Browser mode clears storage/login settings.
All required modes ignore ambient Anthropic/Intelligence keys and launch mock
chat explicitly. Missing storage prerequisites fails instead of skipping cases.

The runner owns its servers and refuses existing ones. Defaults: UI 3000, mock
agent 8000, storage agent 8001, test OIDC 9400. Override `E2E_UI_PORT`,
`E2E_AGENT_PORT`, `E2E_STORAGE_PORT`, `E2E_OIDC_PORT` to isolate local runs.
`PLAYWRIGHT_CHROMIUM_PATH` selects an already installed Chromium.

CI builds first and serves that build. Locally the runner starts development
mode. Forward Playwright arguments after `--`, for example
`npm run test:e2e -- --retries=0 --reporter=list`. Reports/videos/traces are
generated artifacts and are ignored by git. Preview screenshots go in `preview/`.

For an intentional live run, export `ANTHROPIC_API_KEY` and use `npm run test:live`.
Live coverage may cost money and depends on the provider/network. Mock-specific
answer checks are excluded from live mode; it is not a replacement for required
mock coverage. It is not run by required CI.

## CI and failures

- `quality.yml`: locked root/agent install, lint/types/units, unchanged lockfiles.
- `storage.yml`: real PostgreSQL/S3 integration for storage-related changes.
- `ui-preview.yml`: production build, explicit browser/storage/login runs,
  artifacts and the combined outcome in the preview comment.

Inspect the first failed assertion and retained trace, not just the screenshot.
Check test counts and skips in the list/TAP output. A prerequisite failure must
be fixed by providing disposable services, not by weakening an assertion. Tests
should cover observable behavior and boundaries rather than mirror an implementation.
