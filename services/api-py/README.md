# Python API server

The app's HTTP API in Python, on FastAPI: storage, skills, memory, chat history and every
route but the chat itself. It was ported from the TypeScript agent server one route group
at a time (issue #190), and replaced it (issue #264).

api-py is the API at `LOCAL_AGENT_URL`. `pnpm dev` and the demo run it with the Python
chat agent (`services/agent-py`). `GET /health` checks this API's storage readiness,
unknown routes return 404, and storage that is still starting returns 503.
`TS_AGENT_URL` (unset by default) forwards unknown routes to an older release's
TypeScript server instead, for comparisons while upgrading.

PostgreSQL and S3 are required for storage, skills and persisted history. api-py
applies the SQL migrations itself. Without a database, the UI can still
use browser-local files and chat, but skills and persisted history are unavailable.
With no `MCP_SERVERS`, api-py serves an empty tools menu.

What it serves, by the step of issue #190 that ported it:

| Step | Routes | Code |
| --- | --- | --- |
| 1 | `GET /health`: `{"status":"ok"}` when the database and storage are ready, 503 with what isn't | `app.py` |
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
| 8c | `/memory/import`: pasted memory, `.md` files and `.zip` exports into the inbox, with plain text sorted into notes by the small model (`llm.py`). `/memory/agent` for a chat run or a remote backend's run: the prompt's memory section and the `memory_*` and `chats_*` tools, with search by meaning when the embedding model is set here | `memory_import.py`, `llm.py`, `memory_agent.py` |
| 8d | The background learner: chats quiet for `MEMORY_IDLE_MINUTES` are read by the small model, which adds, updates or deletes notes (with Undo) or, in Ask first, proposes them | `memory_learn.py`, `app.py` |
| #226 | `/workspaces` (list, create, members, exact-email lookup, add a member), served only here, and the workspace of every storage, memory and skills request: the `X-Knowledge-Workspace` header, `?workspace=` or a token's `ws` claim, with membership checked each time ([design](../../docs/workspaces.md)). | `workspaces.py`, `storage.py` |
| 9a | `GET /identity/public-key` (the key outside services verify tokens with), `POST /identity/mcp-tokens` (a remote backend's run tokens traded for its MCP servers' tokens) and `POST /suggest` (the chat's follow-up chips: one small-model call, answered as AG-UI events) | `server_routes.py`, `mcp_tokens.py`, `suggest.py` |

Behind them:

- **Who is asking** (`identity.py`). The local user without login. With login, the
  `X-Knowledge-User` token, or an `X-Knowledge-Storage` token for Claude acting through
  an outside service, acting as Claude for that user. Tokens are signed
  and checked byte for byte as `packages/contracts/src/identity-token.ts` does
  (`tokens.py`). The first person to sign in to a new deployment owns the default
  workspace, once (`sign_in_memberships` in `023_workspace_members.sql`).
- **The permission core** (`session.py`). Roles come from `effective_role` in SQL, and
  `need()` refuses with the same messages: a node you can't see is "not found", and too
  low a role is "You can only view here; this needs editor access".
- **Row-level security** (`db.as_user()`). Node queries run as `knowledge_user` with
  `app.user_id` set.
- **Files** (`files.py`, `blobs.py`). Bytes go to the same S3-compatible bucket, keyed by
  their sha256, and each write adds a version and the full-text index of its text
  (`text_index.py`). Path rules follow
  `packages/contracts/src/files.ts` (`paths.py`). Binary files get a five-minute signed
  link when `S3_PUBLIC_URL` is set.
- **Experiments and runs** (`experiments.py`, `run_report.py`). Only an experiment's
  author changes it or its files, and an archived one is read only. A run's `report.md`
  front matter is written as `JSON.stringify` writes it, numbers included, so a report
  reads the same as one the TypeScript server wrote.
- **Search** (`search.py`, `semantic.py`). Words and meaning are ranked together. The
  indexer runs here. Embeddings give the same vectors under the same model id as the
  TypeScript server did, so upgrading doesn't re-embed. The local model,
  `Xenova/multilingual-e5-small` by default, is the ONNX file transformers.js loads (`onnx/model_quantized.onnx`), run with
  ONNX Runtime and cached under `EMBEDDING_CACHE_DIR` (default
  `~/.cache/knowledge-chatroom/models`).
- **Skills** (`skill_catalog.py`, `skills.py`). SKILL.md front matter, the file limits,
  the publish scan and the hub's version fingerprints are those the TypeScript server had.
  Lists sort as JavaScript's `localeCompare` sorts them (`collation.py`: the Unicode
  Collation Algorithm with CLDR's root table, the one Node's ICU uses), so skills keep
  their order, and a version's fingerprint stays the same. The built-in skills are read from `services/api-py/skills`.
- **Outside tools** (`tools.py`). `MCP_SERVERS` is read as agent-py reads it, and a call goes out with the MCP Python SDK, on a connection of its own, with the
  tokens a chat run's call would carry: the user's identity for `forwardIdentity`, signed
  for `mcp:<server>`, and a storage token for `storageAccess`.
- **Change events** go out and come in on the same `LISTEN/NOTIFY` channel (`events.py`),
  so each server process's file watch tells browsers about changes made by any of them,
  each to the people who may see it.

## Migrations

api-py applies the SQL migrations (`services/api-py/migrations`, `MIGRATIONS_DIR`)
as it starts (`db.migrate`): the ones not applied yet, in order, in one transaction,
recorded in `schema_migrations`, under an advisory lock, so two servers starting at once
never both apply one. Then it checks the database:

- **The same migrations:** it serves its routes.
- **Some not applied yet:** it applies them, and tries again every 2 seconds while the
  database is down or a migration fails (the error is logged; nothing of a failed run is
  kept). Its storage routes answer 503 until then.
- **Migrations it doesn't know:** the database is newer than this server, so it
  refuses to start.

With `MIGRATIONS=off`, it only waits for another process to apply them.

## Run it

You need Python 3.12+ and [uv](https://docs.astral.sh/uv/). `pnpm dev` at the
repository root runs it on :8000 with the chat agent on :9300 and the UI. On its own:

```bash
cd services/api-py
uv run python -m api_py.app          # http://127.0.0.1:8000
```

| Variable | Default | What it does |
| --- | --- | --- |
| `TS_AGENT_URL` | unset | An older release's TypeScript server to forward unknown routes to. Unset disables forwarding. |
| `API_PY_HOST`, `API_PY_PORT` | `127.0.0.1`, `8000` | Where it listens. |
| `DATABASE_URL` | unset | Postgres. Only api-py connects to it. Unset means no storage. |
| `AUTH_MODE`, `AUTH_SECRET` | | Login: `oidc` with the app's `AUTH_SECRET`, or `local` for none. One of them is required: with neither, api-py refuses to start (`pnpm dev` passes `local`). Without login, a request signed for a user is answered 401. |
| `MIGRATIONS_DIR` | `services/api-py/migrations` | The migrations to apply and expect. |
| `MIGRATIONS` | unset | `off`: don't apply the migrations, wait for another process to. Otherwise api-py applies them. |
| `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_FORCE_PATH_STYLE`, `S3_PUBLIC_URL` | | The blob store. Only api-py reads these. |
| `MAX_UPLOAD_BYTES` | `52428800` (50 MB) | The largest file one upload may add. |
| `HUB_ADMINS`, `SKILL_SCRIPTS` | unset | Who moderates the skill hub (and verifies memory packs), and `on` when skills' scripts run (set it on agent-py too, which runs them). |
| `BUILTIN_SKILLS_DIR` | `services/api-py/skills` | The built-in skills (`/app/skills` in the image). |
| `MEMORY` | unset | `on`: each user's memory. Off disables `/memory`. agent-py does not read it. |
| `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `MEMORY_MODEL`, `SUGGESTIONS_MODEL`, `CLAUDE_MODEL` | unset | The small model that makes the chat's follow-up chips, sorts imported plain-text memory into notes and learns from chats. Without a key, the chips' request ends with an error (no chips), and imported text waits in the inbox as one note. |
| `MEMORY_LEARN`, `MEMORY_IDLE_MINUTES` | unset, `10` | `MEMORY_LEARN=off` stops learning from chats, which otherwise runs here once a chat has been quiet that many minutes. |
| `MCP_SERVERS` | unset | The outside MCP servers; give agent-py the same value. Unset serves an empty `/tools` menu (unless `TS_AGENT_URL` is set). |
| `TOOLS_CALL_TIMEOUT_MS`, `STORAGE_TOKEN_SECONDS` | `120000`, `3600` | How long a "+" menu call may take, and how long its storage token lasts. |

`pnpm dev` reads the repository's `.env`. Keep its port private.

With Docker, the demo's `api` service builds `services/api-py/Dockerfile` and runs
beside `agent-py`.

## Tests

```bash
uv run pytest -q
TEST_DATABASE_URL=postgres://knowledge:knowledge@localhost:5432/postgres uv run pytest -q
```

The second form also runs the database tests. They need a Postgres where the test may
create and drop databases. The file tests also need an S3-compatible store: add
`S3_ENDPOINT` (and `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`); each test makes a bucket
of its own. `pnpm test:conformance` and `pnpm test:e2e:storage` and
`:login` run against api-py.
