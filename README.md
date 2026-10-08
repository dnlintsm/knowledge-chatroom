# knowledge-chatroom

Demo frontend for agents built with the Claude Agent SDK, talking over the
[AG-UI protocol](https://docs.ag-ui.com) with [CopilotKit](https://copilotkit.ai) as the UI layer.

This repo starts from CopilotKit's official
[`claude-sdk-typescript` starter](https://github.com/CopilotKit/CopilotKit/tree/main/examples/integrations/claude-sdk-typescript)
(MIT, see `LICENSE`), with the Slack/Teams channel host and showcase Docker files removed.

## Workspace layout

The UI is an IDE-style workspace, heading toward a personal knowledge container:

- **Left:** an icon rail (Files, Skills, Uploads, Artifacts, Chats) and its panel. Drop files
  onto the panel to upload them.
- **Middle:** tabs that preview or edit the open file (Markdown, CSV, images, plain text), plus
  the shared todo board.
- **Right:** the Claude chat. Claude gets the open file and your selection as context, plus
  tools to list, read and write files and to open a file or the task board. Files it writes
  open automatically and are badged "Written by Claude".

Panes resize by dragging and collapse from the title bar; below 1024px one pane shows at a
time. With [file storage](#file-storage) running, files are saved on the server (the title bar
says "Saved"); without it they stay in this browser's localStorage ("This browser").

### Runs: Focus and Traverse modes

A **run** (RUN_DIR) is a plain folder holding one experiment run's artifacts. Any folder that
contains a marker folder is a run, `xdoe-report/` by default (set `RUN_DIR_MARKERS`,
comma-separated, to add more). The workspace works in one of two modes:

- **Traverse** (`/`): the **Traverse** view on the icon rail lists every run. There is no chat.
- **Focus** (`/?run=runs/etch-2026-10-01`): the panes work on that run. The Files view is
  rooted at it (new notes and uploads land in it), the title bar shows where you are with a
  button to leave, and Claude gets the run as context (its path, files and
  `xdoe-report/report.md`). Picking a run opens its report.

The URL is the source of truth, so links open a run directly and back/forward move between
runs. A link to a run that isn't there falls back to Traverse with a notice.

### Actions

In Focus mode the Files view ends with a foldable **Actions** block (like VS Code's Outline
and Timeline sections), whose buttons act on the current run:

| Action | Role | Does |
| --- | --- | --- |
| **New Chat** | viewer | starts an empty conversation, still about the same run |

Actions are entries in one registry (`src/components/workspace/actions.tsx`), each with an
id, the role it needs, whether Claude may run it, a `view(ctx)` that gives its label, icon
and state for the current run, and a `run(ctx)` that acts only through the workbench
contract and the file API. One runner serves the block and Claude: it refuses disabled,
unauthorized or already-running actions, so a double click never runs one twice. Until
login lands (#4) the single user has every role.

### Workbench contract

Everything that moves panes goes through one typed API, `useWorkbench()`
(`src/components/workspace/workbench.tsx`): title bar buttons, the icon rail, the phone pane
switcher, file references in answers, and Claude's open-file tools.

| Part | Does |
| --- | --- |
| `mode`, `runDir`, `runs` | Focus or Traverse, the focused run, every run in the workspace |
| `run.focus(path) / leave()` | moves to a run (a new history entry) or back to Traverse |
| `panes.isOpen / show / hide / toggle(pane)` | `"explorer"`, `"editor"` or `"chat"`; on phones `show` switches to that pane |
| `panes.resize / resetSize(pane, width)` | splitter drags, clamped to each pane's range |
| `sidebar.select / show(view)` | the icon rail (`select` on the active view collapses the panel) |
| `editor.open(path, lines?)` | opens a file or the task board, optionally at cited lines |
| `chat.newThread() / focus()` | starts an empty conversation / puts the cursor in the chat (Focus mode only) |
| `notify(message, level)` | a short notice in the corner |

The layout itself is plain data changed by a reducer (`layout.ts`), so its rules are unit
tested (`e2e/workbench.spec.ts`), and a test fails if anything outside the workbench starts
keeping its own pane state.

### File references in answers

Claude's answers can point at a file, or at lines in it, and a click opens them in the middle
pane. A reference is a plain Markdown link to the workspace path, with a GitHub-style line
fragment (the format Claude Code uses in IDEs):

| Claude writes | A click opens |
| --- | --- |
| `[welcome.md](notes/welcome.md)` | the file |
| `[welcome.md:12](notes/welcome.md#L12)` | the file at line 12 |
| `[welcome.md:12-18](notes/welcome.md#L12-L18)` | the file at lines 12–18 |

Paths are relative to the workspace root; lines are 1-based and inclusive. The preview
highlights the paragraphs, list items, table rows or code blocks the lines belong to, and the
editor selects the lines themselves. Links to files that aren't in the workspace show greyed
out, and web links work as before.

Claude learns the format from the system prompt (`agent/src/agent.ts`), and file content
reaches it with numbered lines (the open file in context, and `readWorkspaceFile`), so it can
cite them. The contract lives in `src/components/workspace/file-refs.ts`, whose parser also
accepts `#L12-18` and `notes/welcome.md:12`.

---

## About the starter

A starter template for building AI agents with the [Claude Agent SDK](https://docs.claude.com/en/api/agent-sdk/overview)
and [CopilotKit](https://copilotkit.ai). It pairs a modern Next.js frontend with a TypeScript
agent that speaks the [AG-UI protocol](https://docs.ag-ui.com), and shows CopilotKit driving
**interactive UI beyond chat**:

- a shared-state **todos canvas** the agent and the user both edit,
- **charts** rendered from queried data,
- **flight cards** and **dynamic dashboards** via A2UI generative UI,
- a **human-in-the-loop** meeting picker,
- a light/dark **theme toggle**, and
- the SDK **threads drawer** (activated with a CopilotKit Intelligence license).

The agent is powered by Claude (`claude-sonnet-5` by default) and exposes three backend tools —
`query_data`, `search_flights`, and `generate_a2ui` — while the todo board is shared state the
agent updates through the adapter's built-in `ag_ui_update_state` tool.

## Prerequisites

- **Node.js 20.9+**
- An **Anthropic API key** — create one at <https://console.anthropic.com/>

## Getting Started

1. **Copy the environment file:**

   ```bash
   cp .env.example .env
   ```

2. **Add your Anthropic API key** to `.env`:

   ```bash
   ANTHROPIC_API_KEY=sk-ant-...
   ```

   The other values are optional and already set to sensible defaults:
   `CLAUDE_MODEL=claude-sonnet-5` and `AGENT_URL=http://localhost:8000`.

3. **Install dependencies:**

   ```bash
   npm install
   ```

   > This installs the Next.js frontend and, via the `postinstall` script, the
   > agent's dependencies (`cd agent && npm install`).

4. **Start the app:**

   ```bash
   npm run dev
   ```

   This runs the Next.js UI on **http://localhost:3000** and the Claude agent on
   **http://localhost:8000** concurrently.

5. **Open [http://localhost:3000](http://localhost:3000)** and try the suggested prompts
   (add todos, draw a chart, search flights, build a dashboard, schedule a meeting).

6. **(Optional) Enable the Threads drawer.** Set `CPK_INTELLIGENCE_API_KEY` in
   `.env` to activate live thread history; without it the drawer shows a locked
   state. The license token and `INTELLIGENCE_*` URLs are only for self-hosted
   or offline Intelligence deployments.

## Available scripts

- `npm run dev` — start the UI and agent together (dev mode)
- `npm run dev:ui` — start only the Next.js UI (port 3000)
- `npm run dev:agent` — start only the Claude agent (port 8000)
- `npm run build` — build the Next.js app for production
- `npm start` — start the production server
- `npm run install:agent` — (re)install the agent's dependencies
- `npm run typecheck` — type-check the frontend and the agent
- `npm run test:preview` — capture UI preview screenshots and videos with Playwright (see below)

## File storage

Workspace files can live in Postgres + an S3-compatible object store instead of
the browser (plan and next steps: issue #4). It is optional; without
`DATABASE_URL` the app runs as before.

```bash
docker compose up -d   # Postgres + SeaweedFS (self-hosted S3)
# copy the "Workspace file storage" values from .env.example into .env
npm run dev
```

- **Postgres** (15 or newer) holds the file tree, every version of every file, and who
  wrote it (`agent/src/storage/migrations`). Migrations run when the agent starts.
- **Object store** holds the bytes, keyed by their sha256, so identical content is
  stored once and old versions stay readable. Any S3-compatible store works:
  SeaweedFS or Garage self-hosted, or AWS S3, Cloudflare R2, Backblaze B2.
- **API**: the agent server serves `/files` and Next.js forwards `/api/files/*` to it.
  `GET /api/files` lists files, `GET|PUT|DELETE /api/files/<path>` reads, writes
  (request body = bytes) and deletes one, `?versions` returns its history, and
  `GET /api/files?watch` streams every change as server-sent events (Postgres
  LISTEN/NOTIFY, so it works across processes). There is no login yet, so keep the
  agent port private.
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
  table. Moving an experiment's results into the node comes with proposed edits (step 7 of
  issue #4).
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
  `write_file`, `list_experiments`, `create_experiment` and `update_experiment` tools on the agent server
  (`agent/src/storage/tools.ts`), so it works with files even when no browser tab is open.
  The file tools take a `node` or an `experiment`; the chat context says where the user is,
  and inside an experiment Claude writes only there. Its writes are versions authored by the
  agent.
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

## UI previews on pull requests

Every PR runs `.github/workflows/ui-preview.yml`: it builds the app, walks the key screens with
Playwright (`e2e/preview.spec.ts`, plus `e2e/knowledge.spec.ts` for server storage), and posts a sticky PR comment with a walkthrough GIF and
screenshots, so reviewers can see the UI without running it locally. Full-size `.webm` videos
and the Playwright HTML report are attached to the workflow run as an artifact. Comment images
live on the `ui-previews` branch and are removed when the PR closes.

The preview doesn't need an Anthropic key: without the `ANTHROPIC_API_KEY` repository secret, a
canned AG-UI server (`e2e/mock-agent.mjs`) stands in for the agent. Add the secret to preview
against real Claude instead. CI also starts Postgres and SeaweedFS, so the knowledge tree and
server-saved files show up; there the agent server runs on :8001 for storage and the mock
forwards `/files` and `/nodes` to it. `preview.spec.ts` answers the storage API with 404, so its
screens show the browser-only workspace.

To run it locally (first time: `npx playwright install chromium`):

```bash
npm run test:preview          # reuses `npm run dev` if it's already running, else starts the UI + mock agent
open preview/screenshots      # screenshots; videos are under test-results/
```

With `docker compose up -d` and the storage values from `.env.example` exported,
`npm run test:preview` runs `knowledge.spec.ts` too; without `DATABASE_URL` it is skipped.

The preview only shows the screens these specs visit, so a PR that adds or changes UI should add
a step that calls `shot(page, "NN-name")` for it.

## Project structure

```
├── src/
│   ├── app/
│   │   ├── page.tsx                       # Main page: the three-pane workspace
│   │   ├── layout.tsx                     # CopilotKit v2 provider + A2UI catalog
│   │   └── api/copilotkit/[[...slug]]/     # CopilotKit runtime route (HttpAgent → :8000)
│   ├── components/
│   │   ├── workspace/                     # Sidebar, editor, chat pane, file store, agent tools
│   │   └── …                              # Todo canvas, generative UI, UI primitives
│   └── hooks/                             # Example suggestions + generative-UI examples
├── e2e/                                   # Playwright UI preview + mock agent for CI
└── agent/                                 # TypeScript Claude agent (AG-UI on port 8000)
    ├── package.json                       # Agent dependencies
    ├── src/
    │   ├── server.ts                       # AG-UI SSE server (entry point)
    │   ├── agent.ts                        # The agent: backend tools → ClaudeAgentAdapter
    │   ├── model.ts                        # Model resolution (CLAUDE_MODEL)
    │   ├── query.ts                        # query_data tool
    │   ├── a2ui_fixed_schema.ts            # search_flights tool (fixed A2UI schema)
    │   ├── a2ui_dynamic_schema.ts          # generate_a2ui tool (LLM-designed dashboard)
    │   ├── a2ui.ts                         # A2UI operation helpers
    │   ├── db.csv                          # Sample data for query_data
    │   └── a2ui/schemas/flight_schema.json
    └── tsconfig.json
```

## How it works

- The **frontend** uses CopilotKit's v2 React hooks. Shared state (like the todo list) lives in
  the agent and syncs bidirectionally with the UI.
- The **runtime route** (`src/app/api/copilotkit/[[...slug]]/route.ts`) connects to the agent
  over HTTP with `HttpAgent` from `@ag-ui/client`.
- The **agent** is a thin layer on the official
  [`@ag-ui/claude-agent-sdk`](https://www.npmjs.com/package/@ag-ui/claude-agent-sdk) adapter.
  `src/agent.ts` defines the three backend tools and hands them to `ClaudeAgentAdapter`; the
  adapter drives Claude through the Claude Agent SDK, bridges CopilotKit frontend tools +
  human-in-the-loop, and manages the shared `todos` state via its built-in `ag_ui_update_state`
  tool. (Unlike the Python package, the TS adapter ships no FastAPI-style server helper, so
  `src/server.ts` is a minimal `node:http` equivalent that serves the adapter.)

To customize: add or edit tools in `agent/src/` and the system prompt in `agent/src/agent.ts`,
and the UI in `src/app/home.tsx` and `src/components/`.

## Troubleshooting

**"I'm having trouble connecting to my tools" / agent unreachable**

- Make sure the agent is running on port 8000 (`npm run dev:agent`) and that
  `ANTHROPIC_API_KEY` is set in `.env`.
- Confirm the agent's health check: `curl http://localhost:8000/health` → `{"status":"ok"}`.

**Agent dependency errors**

- Reinstall the agent's dependencies: `cd agent && npm install`.

## Learn more

- [Claude Agent SDK](https://docs.claude.com/en/api/agent-sdk/overview)
- [CopilotKit documentation](https://docs.copilotkit.ai)
- [AG-UI protocol](https://docs.ag-ui.com)
- [Next.js documentation](https://nextjs.org/docs)

## License

MIT — see [LICENSE](./LICENSE).
