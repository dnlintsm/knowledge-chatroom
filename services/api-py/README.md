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

What it serves itself so far:

| Step | Routes | Code |
| --- | --- | --- |
| 1 | `GET /health`: `{"status":"ok"}` when the TypeScript server answers and the database is fine, 503 with what isn't | `app.py` |
| 2 | `/access` (people, groups, grants, the admin panel's lists, the audit log) and `/nodes` (the knowledge tree) | `storage_routes.py`, `session.py`, `access.py`, `nodes.py` |

Behind them:

- **Who is asking** (`identity.py`). The local user without login. With login, the
  `X-Knowledge-User` token, or an `X-Knowledge-Storage` token for Claude acting through
  an outside service, with the same limits as on the TypeScript server. Tokens are signed
  and checked byte for byte as `packages/contracts/src/identity-token.ts` does
  (`tokens.py`), and the first person to sign in owns the workspace.
- **The permission core** (`session.py`). Roles come from `effective_role` in SQL, and
  `need()` refuses with the same messages: a node you can't see is "not found", and too
  low a role is "You can only view here; this needs editor access".
- **Row-level security** (`db.as_user()`). Node queries run as `knowledge_user` with
  `app.user_id` set, as `asUser()` in `apps/agent/src/storage/db.ts` does them.
- **Change events** go out on the same `LISTEN/NOTIFY` channel, so the TypeScript
  server's file watch tells browsers about node changes made here.

## Migrations

The TypeScript server still applies the SQL migrations (`apps/agent/src/storage/migrations`)
until the last step of #190. api-py only checks the database:

- **The same migrations:** it serves its routes.
- **Some not applied yet:** it passes its routes through to the TypeScript server, which
  applies them as it starts, and serves them itself from the first request after that.
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
