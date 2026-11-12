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
| 3 | `/files` at the workspace root and in nodes: list, read, versions, write, rename, delete, and `?watch` (server-sent change events). | `storage_routes.py`, `files.py`, `blobs.py`, `text_index.py`, `events.py`, `paths.py` |
| 4a | `/experiments` (create, fork, runs with inputs, finish, rerun, status, delete) and an experiment's files (`/files?experiment=`) | `storage_routes.py`, `experiments.py`, `run_report.py`, `session.py` |
| 4b | Proposals: `PUT /files/<path>?propose`, `/proposals` (list, content, accept, reject, withdraw, promote an experiment) and the multipart `POST /experiments/upload` | `storage_routes.py`, `proposals.py`, `uploads.py`, `session.py` |
| 5 | `GET /search` (words through Postgres full-text search, meaning through pgvector) and the search indexer: indexing files stored before search existed, and embedding passages with the local model (ONNX Runtime) or an `EMBEDDING_*` API | `storage_routes.py`, `search.py`, `semantic.py`, `app.py` |
| 6 | `/chats`: each user's chat history (list, open, replay a chat's runs, save a finished run, rename, archive, delete), theirs alone and out of storage tokens' reach | `storage_routes.py`, `chats.py`, `session.py` |
| 7a | `/skills` (lists, modes at three levels, `/skills/run` and `/skills/used` for outside agents, .zip export and import, delete) and the skill hub `/hub` (publish, install, fork, diff, verify, yank, reports) | `skills_routes.py`, `skills.py`, `skill_catalog.py` |
| 7b | `/tools`: the chat's "+" menu (`MCP_SERVERS` entries with a `ui` block) and the app's calls to their `ui.tools` as the signed-in user, while `MCP_SERVERS` is set here | `tools.py` |
| 8a | `/memory`'s own notes (read, write, restore, archive, delete), `/memory/settings`, the inbox's accept and reject, `/memory/activity` with Undo, and `/memory/export`, with `MEMORY=on` | `memory_routes.py`, `memory.py` |
| 8b | The memory overview (`GET /memory`), shared notes at the workspace, a node or a group (share, edit, delete, modes, proposals and their decisions), and memory packs (`/memory/packs`, `/memory/installs`: publish, install, fork, uninstall, verify, yank) | `memory_routes.py`, `shared_memory.py`, `memory_packs.py` |
| 8c | `/memory/import`: pasted memory, `.md` files and `.zip` exports into the inbox, with plain text sorted into notes by the small model (`llm.py`, the same Messages API call and model choice as the agent server). `/memory/agent` for a remote backend's run (a memory token `via` `remote`): the prompt's memory section and the `memory_*` and `chats_*` tools, with search by meaning when the embedding model is set here; outside MCP servers' memory tokens still go to the TypeScript server | `memory_import.py`, `llm.py`, `memory_agent.py` |
| 8d | The background learner: chats quiet for `MEMORY_IDLE_MINUTES` are read by the small model, which adds, updates or deletes notes (with Undo) or, in Ask first, proposes them; start the TypeScript server with `MEMORY_LEARN=off` | `memory_learn.py`, `app.py` |
| 9a | `GET /identity/public-key` (the key outside services verify tokens with), `POST /identity/mcp-tokens` (a remote backend's run tokens traded for its MCP servers' tokens) and `POST /suggest` (the chat's follow-up chips: one small-model call, answered as AG-UI events) | `server_routes.py`, `mcp_tokens.py`, `suggest.py` |

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
- **Files** (`files.py`, `blobs.py`). Bytes go to the same S3-compatible bucket, keyed by
  their sha256, and each write adds a version and the full-text index of its text
  (`text_index.py`, cut into the same chunks as the TypeScript server cuts them). Path rules follow
  `packages/contracts/src/files.ts` (`paths.py`). Binary files get a five-minute signed
  link when `S3_PUBLIC_URL` is set.
- **Experiments and runs** (`experiments.py`, `run_report.py`). Only an experiment's
  author changes it or its files, and an archived one is read only. A run's `report.md`
  front matter is written as `JSON.stringify` writes it, numbers included, so a report
  reads the same whichever server last refreshed it.
- **Search** (`search.py`, `semantic.py`). Words and meaning are ranked together as the
  TypeScript server ranks them. The indexer runs here, and only here: start the TypeScript
  server with `SEARCH_INDEXER=off` (`pnpm dev`, compose and the e2e do). Embeddings use the
  same `EMBEDDING_*` settings and give the same vectors under the same model id, so
  switching servers doesn't re-embed. The local model, `Xenova/multilingual-e5-small` by
  default, is the ONNX file transformers.js loads (`onnx/model_quantized.onnx`), run with
  ONNX Runtime and cached under `EMBEDDING_CACHE_DIR` (default
  `~/.cache/knowledge-chatroom/models`). The TypeScript server still embeds queries for
  Claude's search tool, and searches by meaning only while the stored vectors come from its
  own model.
- **Skills** (`skill_catalog.py`, `skills.py`). SKILL.md front matter, the file limits,
  the publish scan and the hub's version fingerprints follow `apps/agent/src/skills`.
  Lists sort as JavaScript's `localeCompare` sorts them (`collation.py`: the Unicode
  Collation Algorithm with CLDR's root table, the one Node's ICU uses), so both servers
  order skills, and fingerprint a version's files, the same way. The built-in skills are read from `apps/agent/skills`.
- **Outside tools** (`tools.py`). `MCP_SERVERS` is read as `apps/agent/src/mcp.ts` reads
  it, and a call goes out with the MCP Python SDK, on a connection of its own, with the
  tokens a chat run's call would carry: the user's identity for `forwardIdentity`, signed
  for `mcp:<server>`, and a storage token for `storageAccess`. With `MCP_SERVERS` unset
  here, `/tools` passes through, so the TypeScript server answers with its own list.
- **Change events** go out and come in on the same `LISTEN/NOTIFY` channel (`events.py`),
  so each server's file watch tells browsers about changes made on either, each to the
  people who may see it.

## Migrations

The TypeScript server still applies the SQL migrations (`apps/agent/src/storage/migrations`)
until the last step of #190. api-py only checks the database:

- **The same migrations:** it serves its routes.
- **Some not applied yet:** it passes its routes through to the TypeScript server, which
  applies them as it starts, and serves them itself from the first request after that.
- **Migrations it doesn't know:** the database is newer than this server, so it
  refuses to start.

## Run it

You need Python 3.12+ and [uv](https://docs.astral.sh/uv/). `pnpm dev` at the
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
| `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_FORCE_PATH_STYLE`, `S3_PUBLIC_URL` | as the TypeScript server | The blob store; give both servers the same values. |
| `MAX_UPLOAD_BYTES` | `52428800` (50 MB) | The largest file one upload may add. |
| `HUB_ADMINS`, `SKILL_SCRIPTS` | unset | As the TypeScript server reads them: who moderates the skill hub (and verifies memory packs), and `on` when skills' scripts run. |
| `BUILTIN_SKILLS_DIR` | `apps/agent/skills` | The built-in skills (`/app/skills` in the image). |
| `MEMORY` | unset | `on`: each user's memory, as the TypeScript server reads it; give both the same value. Off leaves `/memory` to the TypeScript server. |
| `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `MEMORY_MODEL`, `SUGGESTIONS_MODEL`, `CLAUDE_MODEL` | unset | As the TypeScript server reads them: the small model that makes the chat's follow-up chips, sorts imported plain-text memory into notes and learns from chats. Without a key, the chips' request ends with an error (no chips), and imported text waits in the inbox as one note, as there. |
| `MEMORY_LEARN`, `MEMORY_IDLE_MINUTES` | unset, `10` | As the TypeScript server reads them: `MEMORY_LEARN=off` stops learning from chats, which otherwise runs here once a chat has been quiet that many minutes. Set `MEMORY_LEARN=off` on the TypeScript server. |
| `MCP_SERVERS` | unset | The outside MCP servers, as the TypeScript server reads them; give both the same value. Unset leaves `/tools` to the TypeScript server. |
| `TOOLS_CALL_TIMEOUT_MS`, `STORAGE_TOKEN_SECONDS` | `120000`, `3600` | How long a "+" menu call may take, and how long its storage token lasts. |

`pnpm dev` reads the repository's `.env`. As with the agent server, keep its port private.

With Docker, the demo's `api` service builds `services/api-py/Dockerfile` and runs it in
front of the `agent` service.

## Tests

```bash
uv run pytest -q
TEST_DATABASE_URL=postgres://knowledge:knowledge@localhost:5432/postgres uv run pytest -q
```

The second form also runs the database tests. They need a Postgres where the test may
create and drop databases. The file tests also need an S3-compatible store: add
`S3_ENDPOINT` (and `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`); each test makes a bucket
of its own. `pnpm test:conformance` and `pnpm test:e2e:storage` and
`:login` run through api-py. Use `CONFORMANCE_TARGET=ts` or `E2E_API_PY=off` to test
the TypeScript server alone.
