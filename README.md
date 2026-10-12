# knowledge-chatroom

An IDE-style knowledge workspace with editable files, a knowledge tree,
experiments and Claude chat. The Next.js UI talks to a TypeScript Claude Agent SDK
agent over [AG-UI](https://docs.ag-ui.com), using [CopilotKit](https://copilotkit.ai).

Files can stay in this browser or sync through PostgreSQL and S3-compatible
storage. Optional OpenID Connect login supports sharing and read-only access.
The left pane explores knowledge/files, the middle pane previews or edits them,
and, in Focus mode, the right pane chats with Claude using the focused run, open
file and selection as context. Traverse mode lists runs; choosing a run enters Focus.

## Quick start

Use **Node 22** (`.nvmrc`) and npm. A real chat needs an Anthropic API key; unit
and mock browser tests do not.

```bash
nvm use                        # if using nvm
cp .env.example .env            # add ANTHROPIC_API_KEY for real chat
npm ci                         # also installs agent/ from its lockfile
npm run dev                    # UI :3000, agent :8000
```

Open <http://localhost:3000> and choose a run in Traverse to open its report and chat.
Enable server storage and login using the instructions
in [Development](docs/development.md). Keep local credentials in `.env`.
- **Postgres** (15 or newer) holds the file tree, every version of every file, and who
  wrote it (`agent/src/storage/migrations`). Migrations run when the agent starts.
- **Object store** holds the bytes, keyed by their sha256, so identical content is
  stored once and old versions stay readable. Any S3-compatible store works:
  SeaweedFS or Garage self-hosted, or AWS S3, Cloudflare R2, Backblaze B2.
- **API**: the agent server serves `/files` and Next.js forwards `/api/files/*` to it.
  `GET /api/files` lists files, `GET|PUT|DELETE /api/files/<path>` reads, writes
  (request body = bytes) and deletes one, `?versions` returns its history, and
  `GET /api/files?watch` streams every change as server-sent events (Postgres
  LISTEN/NOTIFY, so it works across processes). A `PUT` with `If-None-Match: *` only creates
  (412 if the file exists), and `X-Read-Only: true` makes a new file read-only: after that,
  `PUT` and `DELETE` answer 403, for every role. There is no login yet, so keep the agent
  port private.
- **Knowledge tree**: files live at the workspace root or in a node of a tree whose levels
  are data (`node_types`, seeded as tech › module › loop › process). Nodes are stored with
  Postgres `ltree`, and the database checks that each node sits exactly one level below its
  parent. Each node has its own files. `GET|POST /api/nodes` lists and adds nodes,
  `GET|PATCH|DELETE /api/nodes/<id>` reads (with its ancestors), renames and deletes one
  (with everything below it), and every `/api/files` route takes `?node=<id>`.
- **Experiments**: anyone who can view a node (usually a process) can fork it into an
  experiment. The experiment gets its own copy of the node's file list, pointing at the same
  stored bytes, and from then on every change, by the user or by Claude, stays in the
  experiment. It records a hypothesis, parameters and results as JSON, so the experiments on
  one node compare side by side. A draft is seen only by its author; shared and archived ones
  by everyone who can view the node; only the author changes it, and an archived one is read
  only until restored. `GET|POST /api/experiments` lists (optionally `?node=<id>`) and
  forks, `GET|PATCH|DELETE /api/experiments/<id>` reads, changes and deletes one, and every
  `/api/files` route takes `?experiment=<id>`. In the Knowledge view, experiments sit under
  their node with their status, and the Experiment tab holds the details and a comparison
  table. Its author brings its results to the node by proposing them (below).
- **Proposed changes**: a change to a node's file can wait for review instead of landing at
  once (`008_proposals.sql`). Claude's edits in a node arrive this way, and so does an
  experiment's work when its author proposes it from the Experiment tab (only files the
  experiment changed, so a proposal never undoes someone else's later work on the node).
  Anyone who can view a node may propose; editors there accept or reject in the Proposed
  changes tab, which shows each one as a diff against the file as it is now, and accepting
  writes it as the file's next version, credited to whoever proposed it. Proposing again
  revises your open proposal. `GET /api/proposals` lists open ones (`?node=`,
  `?experiment=`, `?status=`), `PUT /api/files/<path>?node=<id>&propose` proposes, `POST
  /api/proposals {experimentId, paths?, note?}` promotes an experiment, and `POST
  /api/proposals/<id>/accept|reject|withdraw` decides.
- **Search**: every text file is indexed when it is written (`006_search.sql`): its text is
  split into passages and stored once per distinct content, so versions, experiment copies and
  duplicates share one entry. `GET /api/search?q=<text>` finds the files you can read whose
  words (with their forms, so etch finds etching) or exact text (part numbers, CJK) or path
  match, with the passage that matched. `&scope=<node id>` keeps to one node and everything
  below it, and `&near=<node id>` or `&experiment=<id>` ranks files near there first. Files
  stored before search existed are indexed in the background when the agent starts. The
  Search view in the left rail searches as you type and opens a result where it lives.
- **Search by meaning**: with pgvector in Postgres (the `docker compose` image has it), a
  small multilingual embedding model (`Xenova/multilingual-e5-small`, MIT) runs inside the
  agent, so nothing leaves your server. It downloads once (about 120 MB, to
  `~/.cache/knowledge-chatroom/models` or `EMBEDDING_CACHE_DIR`), then embeds every passage
  in the background, and search also finds passages close in meaning ("chamber wall
  buildup" finds "polymer deposition on the liner"), marked "Similar meaning". Word
  matches still rank first; "quotes" or -word ask for exact words only. Without pgvector,
  or with `EMBEDDING_MODEL=off`, search matches words. Changing `EMBEDDING_MODEL` re-embeds
  everything.
- **Access**: users belong to groups in an org tree (company › dept › team), and a grant
  gives a user or group a role on a node and everything below it, or on the whole
  workspace. Roles are additive: viewer reads; editor also writes and deletes files (a deleted
  file keeps its history) and adds and renames nodes; owner also deletes nodes and manages
  grants. A grant to a group covers members of its sub-groups too.
  The API (`/api/access`: users, groups and members, grants, audit log) and Claude's tools
  check access in one place (`agent/src/storage/session.ts`), and every change is written to
  `audit_log` with who made it and whether Claude made it for them. Without login there is
  one built-in user who owns everything, so nothing changes for a single-user setup.
- **Login** (optional): set `AUTH_SECRET` (the same value for the app and the agent, at least
  32 characters, e.g. `openssl rand -hex 32`) and an OpenID Connect provider (`OIDC_ISSUER`,
  `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` if the client has one; Keycloak, Authentik, Google,
  Entra ID and others work). Register `<APP_URL>/api/auth/callback` as the redirect URI, and
  set `APP_URL` when the app sits behind a proxy. Users then sign in before the workspace
  opens; the app keeps them in a signed cookie and signs each request it forwards to the agent
  (`X-Knowledge-User`, valid for five minutes), so the agent port must stay private. The first
  person to sign in owns the workspace and shares nodes from the title bar's Share button
  (people show up there once they have signed in). Viewers get the files read only, and
  Claude's tools in a chat act as the person chatting.
- **Database-enforced access**: file and node queries made for a user run in Postgres as
  the restricted role `knowledge_user`, with row-level security policies
  (`agent/src/storage/migrations/004_row_security.sql`, `005_experiments.sql` for
  experiments and `006_search.sql` for indexed text) that apply the same grants. If a
  check in the app were ever missed, Postgres would still refuse. The migration creates the
  role when the database user may (`CREATEROLE` or superuser, as with `docker compose`);
  otherwise the agent logs that row-level security is off, and an admin can enable it with
  `CREATE ROLE knowledge_user NOLOGIN; GRANT knowledge_user TO <app user>;` before the next
  start.
- **Download links**: set `S3_PUBLIC_URL` to the object store's address as browsers reach it
  (e.g. `http://localhost:8333` with `docker compose`, or `https://s3.<region>.amazonaws.com`)
  and images and other binary files download straight from the store. After the access
  check, the API answers with a redirect to a signed link that works for five minutes.
  Text files are still served by the app, which the editor reads them through.
- **Claude** gets `list_nodes`, `create_node`, `list_files`, `read_file`, `search_files`,
  `write_file`, `list_experiments`, `create_experiment`, `update_experiment` and
  `propose_experiment` tools on the agent server
  (`agent/src/storage/tools.ts`), so it works with files even when no browser tab is open.
  The file tools take a `node` or an `experiment`; the chat context says where the user is,
  and inside an experiment Claude writes only there. Its writes are versions authored by the
  agent; in a knowledge node they are proposed changes until someone accepts them.
- **UI**: on load the workspace checks `/api/files`. If it answers, files load from the
  server, edits save there (debounced), and the change stream brings in Claude's writes and
  edits from other tabs. Without login, the first visit to an empty server uploads this
  browser's files.
  The Knowledge view in the left rail shows the tree; clicking a node moves the workspace
  there (the title bar shows where you are), and each node keeps its own open tabs.
  If it doesn't answer, everything stays in localStorage and the browser-side file tools
  are used instead.
- **Tests**: `cd agent && npm test` with `TEST_DATABASE_URL` and the `S3_*` vars set
  (see `agent/src/storage/storage.test.ts`); CI runs them on every PR that touches `agent/`.

## Contributor guide

- [Development](docs/development.md): dependencies, local services and environment variables.
- [Testing](docs/testing.md): fast checks, integration, E2E and CI coverage.
- [Architecture](docs/architecture.md): runs, actions/rules, file APIs, search, access and experiments.
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
