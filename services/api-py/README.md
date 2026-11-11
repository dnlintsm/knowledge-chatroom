# Python API server

The agent server's HTTP API in Python, on FastAPI. It is phase 3 of moving the
backend to Python (issue #169), done one route group at a time under issue #190.

api-py is the front door at `LOCAL_AGENT_URL`. It serves the route groups moved to
Python so far (`api_py/routes.py`). Every other request goes to the TypeScript agent
server (`apps/agent`) at `TS_AGENT_URL`, streamed both ways and unchanged: method,
path (percent-encoding kept), query, headers, body, status, and server-sent events.
So the app, the Python chat agent and the MCP servers keep one address while routes
move. The URLs and `packages/contracts/openapi/storage.yaml` stay the contract, and
the conformance suite runs through api-py.

Step 1 is the skeleton, and every route still passes through. It has:

- `GET /health`, which answers `{"status":"ok"}` when the TypeScript server answers
  and the database is fine, and 503 with what isn't;
- the database pool, and `db.as_user()`, the row-security transaction
  (`SET LOCAL ROLE knowledge_user` plus `app.user_id`, as `asUser()` in
  `apps/agent/src/storage/db.ts`);
- identity tokens (`api_py/tokens.py`), signed and checked byte for byte as
  `packages/contracts/src/identity-token.ts` does them;
- the migration check described below.

## Migrations

The TypeScript server still applies the SQL migrations (`apps/agent/src/storage/migrations`)
until the last step of #190. api-py only checks the database:

- **The same migrations:** it serves.
- **Some not applied yet:** it serves, and waits for the TypeScript server to apply
  them as it starts.
- **Migrations it doesn't know:** the database is newer than this server, so it
  refuses to start.

## Run it

You need Python 3.11+ and [uv](https://docs.astral.sh/uv/). `pnpm dev` at the
repository root runs it on :8000 with the TypeScript server behind it on :8100, and
the UI. `pnpm dev:ts` runs without it, with the TypeScript server on :8000 as before.
On its own:

```bash
cd services/api-py
uv run python -m api_py.app          # http://127.0.0.1:8000
```

| Variable | Default | What it does |
| --- | --- | --- |
| `TS_AGENT_URL` | `http://127.0.0.1:8100` | The TypeScript agent server, for every route not moved yet. |
| `API_PY_HOST`, `API_PY_PORT` | `127.0.0.1`, `8000` | Where it listens. |
| `DATABASE_URL` | unset | The same Postgres as the TypeScript server. Unset means no storage. |
| `AUTH_MODE`, `AUTH_SECRET` | | Login, with the TypeScript server's rules and the same secret. |
| `MIGRATIONS_DIR` | `apps/agent/src/storage/migrations` | The migrations to expect. |

`pnpm dev` reads the repository's `.env`. As with the agent server, keep its port private.

With Docker, the demo's `api` service builds `services/api-py/Dockerfile` and runs it in
front of the `agent` service.

## Tests

```bash
uv run pytest -q
TEST_DATABASE_URL=postgres://knowledge:knowledge@localhost:5432/postgres uv run pytest -q
```

The second form also runs the database tests. They need a Postgres where the test may
create and drop databases. `pnpm test:conformance` and `pnpm test:e2e:storage` and
`:login` run through api-py. Use `CONFORMANCE_TARGET=ts` or `E2E_API_PY=off` to test
the TypeScript server alone.
