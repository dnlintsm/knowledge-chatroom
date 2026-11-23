# Settings

Every environment variable the code reads, by the process that reads it. `.env.example`
has the ones people usually set, with longer explanations; this page is the complete list.

A check keeps it honest: `node scripts/settings-check.mjs` (part of `pnpm check:web`, and
of the Python job in CI) fails when a process reads a setting its table doesn't list, or a
table lists one the code no longer names. A pull request that adds, removes or renames a
setting changes this page.

How to read the tables:

- **Default** is what the code assumes when the variable is unset. "unset" means nothing is
  assumed and the feature is off or the next fallback applies. "required" means the process
  refuses to start, or the feature to work, without it; the last column says when.
- Each process reads its own environment. A setting that appears in two tables has to be
  given to both processes. [Deployment](deployment.md#after-deploying-settings-that-must-agree)
  lists the ones that must have the same value.
- The Docker images set some of these differently from the code's defaults; see
  [In the Docker images](#in-the-docker-images).

## Web app

The Next.js UI (`apps/web`, with `packages/contracts`).

| Setting | Default | What it does |
| --- | --- | --- |
| `AGENT_URL` | `http://127.0.0.1:9300` | Chat backend: runs are posted to `<AGENT_URL>/agent/report`; `local` sends the chat to `LOCAL_AGENT_URL` instead (only the e2e mock agent serves that). |
| `APP_URL` | the origin of the incoming request | Public address of the app, used for the sign-in redirect and secure cookies; with login in production the app refuses to start without it. |
| `AUTH_ALLOW_HTTP` | unset | Only `true`, and only outside production, lets `OIDC_ISSUER` and `APP_URL` use plain http on hosts other than localhost. |
| `AUTH_MODE` | oidc when AUTH_SECRET is set, otherwise local; a production build with neither refuses to start | Whether people sign in: `oidc` or `local`; any other value stops startup. Must be the same on api-py, agent-py and every MCP server. |
| `AUTH_SECRET` | required | Signs the session cookie and identity tokens; needed with `AUTH_MODE=oidc`, at least 32 characters, refused with `AUTH_MODE=local`. api-py must have the same value. |
| `CHAT_STEPS` | `compact` | How much of each answer's steps the chat shows until a user chooses: `compact` or `detailed`; anything but `detailed` is compact. |
| `CHAT_SUGGESTIONS` | unset | `static` keeps the first-round follow-up chips; any other value, or none, has api-py's `/suggest` write new chips after each reply. |
| `CPK_INTELLIGENCE_API_KEY` | unset | When set, chat threads are kept in CopilotKit Intelligence instead of the app's own chat store; also read at build time. |
| `IDENTITY_FORMAT` | unset | Removed setting: the shared startup check rejects any value but `v2`, but the web app does not call that check, so it has no effect here. |
| `INTELLIGENCE_API_URL` | unset | Address of a self-hosted CopilotKit Intelligence API; read only when `CPK_INTELLIGENCE_API_KEY` is set. |
| `INTELLIGENCE_GATEWAY_WS_URL` | unset | WebSocket address of a self-hosted CopilotKit Intelligence gateway; read only when `CPK_INTELLIGENCE_API_KEY` is set. |
| `LOCAL_AGENT_URL` | `http://localhost:8000` | Address of api-py, where the app forwards storage, skills, hub, memory, workspaces and follow-up chip requests. |
| `MCP_SERVER_URL` | unset | An MCP app server every chat run connects to; unset, no run contacts an outside host. |
| `OIDC_ASSUME_EMAIL_VERIFIED` | unset | Only `true` makes the app trust a sign-in email when the provider sends no `email_verified` claim; an explicit false is never trusted. |
| `OIDC_CLIENT_ID` | required | The app's client id at the OpenID Connect provider; with `AUTH_MODE=oidc` the app refuses to start without it. |
| `OIDC_CLIENT_SECRET` | unset | The client secret for the provider; unset, the app signs in as a public client protected by PKCE only. |
| `OIDC_ISSUER` | required | The OpenID Connect provider's URL; with `AUTH_MODE=oidc` the app refuses to start without it, and it must be https except on localhost. |
| `RULES_API_URL` | unset | Rules API the server calls for Generate Rules (`GET <url>?run=<title>&experiment=<id>`); unset, the built-in mock answers. |
| `STORAGE_TOKEN_SECONDS` | `3600` | Lifetime of the storage and memory tokens signed for a remote backend: whole seconds from 60 to 86400, else signing fails. api-py must have the same value. |

Next.js sets `NODE_ENV` and `NEXT_RUNTIME` itself. In a production build (`NODE_ENV=production`)
missing login settings stop startup and `AUTH_ALLOW_HTTP` is ignored. `next.config.ts` also
loads the repository root's `.env`; values already in the environment win.

## api-py

Storage, access, skills, memory and search (`services/api-py`).

| Setting | Default | What it does |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | unset | Key for the small model's Messages API calls (sent as `x-api-key`); with neither this nor `ANTHROPIC_AUTH_TOKEN`, those calls fail. |
| `ANTHROPIC_AUTH_TOKEN` | unset | Bearer token for the small model's Messages API calls, used instead of or beside `ANTHROPIC_API_KEY`. |
| `ANTHROPIC_BASE_URL` | `https://api.anthropic.com` | Base URL of the Messages API the small model is called on; `/v1/messages` is added. |
| `ANTHROPIC_MODEL` | unset | Main model name used when `CLAUDE_MODEL` is unset; here it only decides the small model's fallback. |
| `API_PY_HOST` | `127.0.0.1` | Address the server listens on. |
| `API_PY_PORT` | `8000` | Port the server listens on; anything but a number from 1 to 65535 stops startup. |
| `AUTH_MODE` | required | `oidc` (login) or `local` (no login, one user); startup is refused unless this or `AUTH_SECRET` is set; same value on every process. |
| `AUTH_SECRET` | required | The app's signing secret, at least 32 characters; required when `AUTH_MODE=oidc`, refused when `AUTH_MODE=local`; must equal the web app's. |
| `BUILTIN_SKILLS_DIR` | services/api-py/skills under the repository root (found from the code's own location) | Folder the built-in skills are read from. |
| `CLAUDE_MODEL` | `claude-sonnet-5` | Main model name; here it only decides which small model is used when `SUGGESTIONS_MODEL` is unset. |
| `DATABASE_URL` | unset | Postgres connection string; unset means no storage, and `python -m api_py.migrate` refuses to run without it. |
| `EMBEDDING_API_KEY` | unset | Bearer key for the embedding endpoint; read only when `EMBEDDING_BASE_URL` is set. |
| `EMBEDDING_BASE_URL` | unset | OpenAI-style embedding endpoint to use instead of the local model; needs `EMBEDDING_MODEL` or startup is refused. |
| `EMBEDDING_CACHE_DIR` | .cache/knowledge-chatroom/models under the user's home folder | Folder the local embedding model is downloaded to. |
| `EMBEDDING_DIMENSIONS` | unset | Vector size asked of the embedding endpoint, a positive whole number; read only when `EMBEDDING_BASE_URL` is set. |
| `EMBEDDING_MODEL` | `Xenova/multilingual-e5-small` | Model for search by meaning; `off` leaves search to words only. |
| `HUB_ADMINS` | unset | Emails or login subjects, split by commas or spaces, who moderate the skill hub and verify memory packs. |
| `MAX_UPLOAD_BYTES` | `52428800` | Largest file one upload may add, in bytes; a value that is not a positive number stops startup. |
| `MCP_SERVERS` | unset | Outside MCP servers as JSON or a path to a JSON file; unset serves an empty tools menu; give agent-py the same value. |
| `MEMORY` | unset | Turns on each user's memory routes when `on`, `1`, `true` or `yes` (any case); anything else is off. |
| `MEMORY_IDLE_MINUTES` | `10` | Minutes a chat must be quiet before the learner reads it; an invalid or negative value falls back to 10. |
| `MEMORY_LEARN` | unset | Learning from quiet chats runs with memory on unless this is `off`, `0`, `false` or `no` (any case). |
| `MEMORY_MODEL` | unset | Model for memory import and learning; unset uses the suggestions model. |
| `MIGRATIONS` | unset | `off` makes the server wait for another process to apply the SQL migrations; any other value applies them at startup. |
| `MIGRATIONS_DIR` | services/api-py/migrations under the repository root (found from the code's own location) | Folder of SQL migrations to apply and expect in the database. |
| `PLATFORM_ADMINS` | unset | Emails or login subjects, split by commas or spaces, who see the workspace inventory and may add an Owner; unset means nobody. |
| `RECOVERY_IDLE_DAYS` | `90` | Days since last sign-in within which a member counts as holding Full access; must be a whole number of at least 1. |
| `ROW_SECURITY` | `optional` | `required` refuses to serve storage unless Postgres row-level security is enforced; `optional` only logs it; other values stop startup. |
| `S3_ACCESS_KEY_ID` | unset | Access key for the blob store; without both keys boto3 looks for credentials itself. |
| `S3_BUCKET` | `knowledge` | Bucket the file bytes are kept in. |
| `S3_ENDPOINT` | unset | URL of the S3-compatible store; unset uses AWS S3. |
| `S3_FORCE_PATH_STYLE` | `true` | Path-style bucket addressing unless set to exactly `false`. |
| `S3_PUBLIC_URL` | unset | The store's URL as browsers reach it, for signed download links; unset sends bytes through the app. |
| `S3_REGION` | `us-east-1` | Region of the blob store. |
| `S3_SECRET_ACCESS_KEY` | unset | Secret key for the blob store, used only together with `S3_ACCESS_KEY_ID`. |
| `SEARCH_MIN_SIMILARITY` | 0.82 for a model with "e5-" in its name, otherwise 0.5 | How similar a passage must be to count as a search result by meaning. |
| `SKILL_SCRIPTS` | unset | Exactly `on` reports that skills' scripts run; agent-py, which runs them, must have the same value. |
| `STORAGE_TOKEN_SECONDS` | `3600` | Lifetime of the storage token sent with a tools-menu call; whole seconds from 60 to 86400, else startup is refused. |
| `SUGGESTIONS_MODEL` | `claude-haiku-5-5` when the main model's name starts with "claude-", otherwise the main model | Small model that writes the chat's follow-up chips, and the fallback for `MEMORY_MODEL`. |
| `TOOLS_CALL_TIMEOUT_MS` | `120000` | Milliseconds a tools-menu call to an outside MCP server may take. |
| `TS_AGENT_URL` | unset | An older TypeScript server to forward unknown routes to; unset turns forwarding off. |
| `WORKSPACE_CREATORS` | unset | Emails or login subjects, split by commas or spaces, who may create workspaces; unset lets every signed-in user. |

## agent-py

The chat agent (`services/agent-py`).

| Setting | Default | What it does |
| --- | --- | --- |
| `AGENT_PY_HOST` | `127.0.0.1` | Address the agent listens on. |
| `AGENT_PY_PORT` | `9300` | Port the agent listens on. |
| `AGENT_PY_WORKDIR` | a new empty temp folder (prefix agent-py-) made at each start | Folder holding each user's working folder, with their skills and workspace copy. |
| `AGENT_RUN_TIMEOUT_SECONDS` | `1800` | Seconds after which a run is stopped; `0` means never. |
| `AGENT_WORKDIR` | unset | `off` removes the workspace copy and the Read, Glob and Grep tools from runs; any other value keeps them. |
| `AGENT_WORKDIR_MAX_FILE_MB` | `25` | Largest single file, in MB, copied into the working folder; a value that is not above zero falls back to 25. |
| `AGENT_WORKDIR_MAX_MB` | `500` | Most MB the workspace copy may hold; a value that is not above zero falls back to 500. |
| `ANTHROPIC_API_KEY` | unset | Real key the key proxy adds to script runs' requests; otherwise only Claude Code reads it. |
| `ANTHROPIC_AUTH_TOKEN` | unset | Bearer token the key proxy uses when `ANTHROPIC_API_KEY` is unset; otherwise only Claude Code reads it. |
| `ANTHROPIC_BASE_URL` | `https://api.anthropic.com` | Where the key proxy sends script runs' model requests; otherwise only Claude Code reads it. |
| `ANTHROPIC_MODEL` | unset | Default chat model when `CLAUDE_MODEL` is unset. |
| `AUTH_MODE` | required | `oidc` (login) or `local` (no login); startup is refused unless this, `KNOWLEDGE_PUBLIC_KEY` or `AUTH_SECRET` is set; same value as api-py. |
| `AUTH_SECRET` | unset | Only its presence is read: with no `AUTH_MODE` and no key it counts as login on, so every run is refused. |
| `CHAT_MODELS` | unset | Comma-separated extra model names users may pick in the chat, listed after the default. |
| `CLAUDE_MODEL` | `claude-sonnet-5` | Default chat model; dots in a "claude-" name become dashes. |
| `KNOWLEDGE_PUBLIC_KEY` | unset | api-py's public key (its `GET /identity/public-key`) that checks who a run is for; set with login, refused with `AUTH_MODE=local`. |
| `LOCAL_AGENT_URL` | `http://localhost:8000` | Base URL of api-py, where storage, skills and memory calls go. |
| `LOG_LEVEL` | `INFO` | Python logging level name for the process. |
| `MCP_SERVERS` | unset | Outside MCP servers as JSON or a path to a JSON file; must be the same value as api-py's. |
| `SKILL_SCRIPTS` | unset | Exactly `on` lets skills' scripts run with Bash in Claude Code's sandbox; set the same value on api-py. |
| `SKILL_SCRIPTS_DENY_READ` | unset | Comma-separated absolute paths that scripts also may not read; read only when `SKILL_SCRIPTS=on`. |

## papers-mcp

Paper search as an MCP server (`services/papers-mcp`).

| Setting | Default | What it does |
| --- | --- | --- |
| `ARXIV_URL` | `https://export.arxiv.org/api/query` | arXiv API address used for new preprints. |
| `AUTH_MODE` | required | `oidc` (login) or `local` (no login); startup is refused unless this, `KNOWLEDGE_PUBLIC_KEY` or `AUTH_SECRET` is set; same value as api-py. |
| `AUTH_SECRET` | unset | Only its presence is read: with no `AUTH_MODE` and no key it counts as login on, so every call is refused. |
| `KNOWLEDGE_PUBLIC_KEY` | unset | api-py's public key (its `GET /identity/public-key`) that checks the signed caller; set with login, refused with `AUTH_MODE=local`. |
| `KNOWLEDGE_STORAGE_URL` | `http://127.0.0.1:8000` | Base URL of api-py, whose storage API `save_paper` writes through. |
| `OPENALEX_API_KEY` | unset | Optional OpenAlex key added to each OpenAlex request. |
| `OPENALEX_MAILTO` | unset | Optional contact email added to each OpenAlex request. |
| `OPENALEX_URL` | `https://api.openalex.org` | OpenAlex API address. |
| `PAPERS_HOST` | `127.0.0.1` | Address the server listens on. |
| `PAPERS_HTTP_TIMEOUT` | `30` | Seconds allowed for each request to a paper source. |
| `PAPERS_MAX_PDF_BYTES` | `30000000` | Largest PDF, in bytes, that `read_paper` and `save_paper` download. |
| `PAPERS_MAX_PDF_PAGES` | `500` | Most pages of a PDF that `read_paper` reads. |
| `PAPERS_NAME` | `papers` | The server's name; must match its name in `MCP_SERVERS`, since forwarded users are signed for it. |
| `PAPERS_PORT` | `9200` | Port the server listens on. |

## lab-tools

The sample MCP server (`services/lab-tools`).

| Setting | Default | What it does |
| --- | --- | --- |
| `AUTH_MODE` | required | `oidc` (login) or `local` (no login); startup is refused unless this, `KNOWLEDGE_PUBLIC_KEY` or `AUTH_SECRET` is set; same value as api-py. |
| `AUTH_SECRET` | unset | Only its presence is read: with no `AUTH_MODE` and no key it counts as login on, so every call is refused. |
| `KNOWLEDGE_PUBLIC_KEY` | unset | api-py's public key (its `GET /identity/public-key`) that checks the signed caller; set with login, refused with `AUTH_MODE=local`. |
| `KNOWLEDGE_STORAGE_URL` | `http://127.0.0.1:8000` | Base URL of api-py, used for workspace files and the user's memory. |
| `LAB_TOOLS_HOST` | `127.0.0.1` | Address the server listens on. |
| `LAB_TOOLS_NAME` | `lab` | The server's name; must match its name in `MCP_SERVERS`, since forwarded users are signed for it. |
| `LAB_TOOLS_PORT` | `9100` | Port the server listens on. |

## Scripts, tests and CI

Read only by the developer scripts, the test runners, the mock servers in `e2e/`, or
`docker-compose.yml`. The check above does not cover this table.

| Setting | Default | What it does |
| --- | --- | --- |
| `AGENT_PORT` | `8000` | Port the e2e mock agent (`e2e/mock-agent.mjs`) listens on; the Playwright config overwrites it with `E2E_AGENT_PORT`. |
| `ANTHROPIC_API_KEY` | required | Needed for `E2E_MODE=live` (the Playwright config refuses to load without it) and blanked in other modes; docker-compose passes it to api and agent-py. |
| `CI_TEST_REPORT_DIR` | `knowledge-chatroom-tests/<run id>/<job>` under the runner's or the system's temp folder, with `local` for a missing id or job | Folder where `scripts/ci-tests.mjs` keeps each suite's counts between the `run` and `summary` steps. |
| `CONFORMANCE_OWNER` | `conformance\|alice` | Login subject the workspaces conformance suite expects to own the default workspace. |
| `CONFORMANCE_SAMPLES` | unset | A file path: the storage conformance suite empties it and writes every matching request and answer to it as JSON lines. |
| `DATABASE_URL` | required | Postgres for the e2e `storage`, `login` and `python-storage` modes (config refuses to load without it); optional in `live`, blanked in the other modes. |
| `E2E_AGENT_PORT` | `8000` | Port of the mock agent in e2e runs; a whole number from 1 to 65535. |
| `E2E_MODE` | `browser` | Which e2e suite Playwright runs: `browser`, `storage`, `login`, `live`, `python` or `python-storage`; `scripts/run-e2e.mjs` sets it from its first argument. |
| `E2E_MODEL_PORT` | `9500` | Port of the scripted model (`e2e/mock-anthropic.mjs`) in the `python` and `python-storage` modes. |
| `E2E_OIDC_PORT` | `9400` | Port of the mock sign-in provider (`e2e/mock-oidc.mjs`) in the `login` mode. |
| `E2E_PY_AGENT_PORT` | `9300` | Port agent-py is started on in the `python`, `python-storage` and `live` modes. |
| `E2E_STORAGE_PORT` | `8001` | Port api-py is started on in the e2e modes that use storage. |
| `E2E_UI_PORT` | `3000` | Port the web app is started on for e2e runs, and the tests' base URL. |
| `KNOWLEDGE_PUBLIC_KEY` | unset | `scripts/dev-py.mjs` starts a Python service with `AUTH_MODE=local` only when this, `AUTH_MODE` and `AUTH_SECRET` are all unset. |
| `MOCK_MODEL_PORT` | `9500` | Port the scripted model server (`e2e/mock-anthropic.mjs`) listens on; the Playwright config sets it from `E2E_MODEL_PORT`. |
| `OIDC_PORT` | `9400` | Port the mock sign-in provider (`e2e/mock-oidc.mjs`) listens on; the Playwright config sets it from `E2E_OIDC_PORT`. |
| `PLAYWRIGHT_CHROMIUM_PATH` | unset | Path of an installed Chromium for Playwright to launch instead of its downloaded browser. |
| `S3_BUCKET` | `knowledge-conformance` | Bucket `pnpm test:conformance` gives api-py when none is set. |
| `S3_ENDPOINT` | required | Object store address: `pnpm test:conformance` and the e2e storage modes refuse to run without it. |
| `STORAGE_URL` | unset | The mock agent forwards storage routes to this api-py; the conformance suites test the API at it and skip without it and `AUTH_SECRET`. |
| `TEST_DATABASE_URL` | required | Disposable Postgres for `pnpm test:conformance`, which refuses to run without it and drops its public schema first. |

`docker-compose.yml` also hands these from `.env` to the containers that read them, as
described in the tables above: `ANTHROPIC_BASE_URL`, `CHAT_MODELS`, `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`, `CLAUDE_CODE_AUTO_COMPACT_WINDOW`, `CLAUDE_CODE_MAX_CONTEXT_TOKENS`, `CLAUDE_MODEL`, `EMBEDDING_API_KEY`, `EMBEDDING_BASE_URL`, `EMBEDDING_DIMENSIONS`, `EMBEDDING_MODEL`, `MCP_SERVERS`, `MEMORY`, `MEMORY_IDLE_MINUTES`, `MEMORY_LEARN`, `MEMORY_MODEL`, `OPENALEX_API_KEY`, `OPENALEX_MAILTO`, `SEARCH_MIN_SIMILARITY`, `SUGGESTIONS_MODEL`. Its own default
for the app's `AGENT_URL` is `http://agent-py:9300`.

GitHub Actions sets these itself and the scripts only read them: `CI`, `GITHUB_EVENT_NAME`,
`GITHUB_JOB`, `GITHUB_OUTPUT`, `GITHUB_RUN_ID`, `GITHUB_STEP_SUMMARY`, `RUNNER_TEMP`.

## Passed through

Variables this repository's code does not use as a setting of its own, but hands to
something else.

- **`${VAR}` in `MCP_SERVERS`** (api-py and agent-py): any variable named as `${NAME}` in a server's `headers` or stdio `env` is read from the process environment; unset becomes empty with a warning. api-py sends expanded headers with its tools-menu calls and only checks stdio `env`; agent-py gives both to Claude Code.
- **agent-py, runs with skills' scripts** (`SKILL_SCRIPTS=on` and a skill that ships scripts): the environment Claude Code gets is rebuilt (`services/agent-py/agent_py/scripts.py`):
  - Kept as they are: `PATH` (minus folders scripts cannot read), `HOME`, `USER`, `LOGNAME`, `SHELL`, `LANG`, `LANGUAGE`, `LC_*`, `TZ`, `TERM`, `TMPDIR`, `ANTHROPIC_MODEL`, `ANTHROPIC_SMALL_FAST_MODEL`, `ANTHROPIC_DEFAULT_*_MODEL`, `CLAUDE_CODE_AUTO_COMPACT_WINDOW`, `CLAUDE_CODE_MAX_CONTEXT_TOKENS`, `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`.
  - Every other variable of the server is passed as an empty string.
  - Set for the child: `ANTHROPIC_BASE_URL` (the key proxy on 127.0.0.1), `ANTHROPIC_API_KEY` (a stand-in only the proxy accepts), `NO_PROXY` and `no_proxy` (`127.0.0.1,localhost`).
- **agent-py, runs without scripts**: Claude Code inherits the server's environment unchanged, so `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL` and the Claude Code context settings above are read by Claude Code itself, not by this repo's code.
- **api-py blob store**: with no `S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY`, boto3 finds credentials its own way (AWS environment variables, profile, instance role); the repo's code reads none of those.
- **papers-mcp**: `HTTPS_PROXY` is honoured by Python's urllib, not read by the repo's code.

## In the Docker images

The images set these with `ENV`, so inside a container they differ from the defaults above:

| Image | Set to |
| --- | --- |
| api-py | `API_PY_HOST=0.0.0.0`, `API_PY_PORT=8000`, `MIGRATIONS_DIR=/app/migrations`, `BUILTIN_SKILLS_DIR=/app/skills`, `EMBEDDING_CACHE_DIR=/var/lib/knowledge/models` |
| agent-py | `AGENT_PY_HOST=0.0.0.0`, `AGENT_PY_PORT=9300`, `AGENT_PY_WORKDIR=/var/lib/agent-py` |
| papers-mcp | `PAPERS_HOST=0.0.0.0`, `PAPERS_PORT=9200` |
| lab-tools | `LAB_TOOLS_HOST=0.0.0.0`, `LAB_TOOLS_PORT=9100` |
