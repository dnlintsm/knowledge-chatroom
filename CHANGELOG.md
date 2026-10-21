# Changelog

## Unreleased

### Upgrading

- Runs are experiments now (#82). The Traverse view, Focus mode, `?run=` links and
  `RUN_DIR_MARKERS` are gone; a run is an experiment with a `report.md`. Existing run
  folders (holding `xdoe-report/`) are listed in the Runs view, where **Make run** moves
  each into a new experiment with its history. Runs need server storage. Migration
  `015_runs.sql` runs on start.
- The rules API (`RULES_API_URL`) is now asked `?run=<run title>&experiment=<id>`
  instead of `?run=<folder>`.
- `AGENT_URL` now names a remote agent backend for the chat. This repo's agent server
  moved to `LOCAL_AGENT_URL` (default `http://localhost:8000`). Remove
  `AGENT_URL=http://localhost:8000` from your `.env`, or rename it to
  `LOCAL_AGENT_URL`. The docker demo already sets `LOCAL_AGENT_URL`.

### Added

- A remote agent backend for the chat (`AGENT_URL`): runs go to
  `${AGENT_URL}/agent/report`, and this repo's own Claude agent and follow-up chips are
  off while storage and skills stay on this repo's server. Every chat run carries the
  user and where they are (node, experiment, open file) in
  `forwardedProps.knowledge_chatroom` (version 2: `experiment` with its `state` and
  `report`, no `run_dir`). See `docs/remote-agent.md`.
- The Runs view (#82) replaces Traverse: every run here and below, a **+** to start one,
  and a **Runs** tab comparing them by state, place, parameters and results. Runs can
  sit at the workspace root, have a state (ready, running, done, failed), and open from a
  link (`?experiment=<id>`). The app name goes to the workspace root's Runs view.

## 0.1.1

Bring your own tools and models, an admin panel for workspace owners, smarter chat
suggestions, and login that fails closed in production.

### Upgrading from 0.0.1

- Set `AUTH_MODE` (#64, #66): `oidc` for login or `local` for one built-in user. A
  production server with neither `AUTH_MODE` nor `AUTH_SECRET` now refuses to start
  instead of running without login. With login, `APP_URL` is required in production,
  and the issuer and `APP_URL` must use https unless on localhost
  (`AUTH_ALLOW_HTTP=true` for development). The docker demo sets `AUTH_MODE=local`.
- Migrations `013` (whoever adds a knowledge node owns it) and `014_last_seen.sql`
  (`users.last_seen_at` for the admin panel) apply at agent startup. Back up first, as
  for any upgrade.
- Serving over HTTPS: see the new HTTPS section in `docs/deployment.md`.

### Added

- Admin panel for workspace owners (#67, #68): see everyone who has signed in and
  when they were last active, set their workspace role, create and nest groups and
  manage members, and read recent access changes.
- Outside MCP servers with `MCP_SERVERS`, optionally forwarding the signed-in user
  (#61), and a sample that brings a Python agent in as a skill plus a FastMCP server
  (`examples/python-agent`, #71).
- Chat suggestions (#57): first chips follow what is open (#58), and after each reply
  a small model suggests follow-ups (#59; `SUGGESTIONS_MODEL`,
  `CHAT_SUGGESTIONS=static` to turn off).
- Search by meaning through any OpenAI-compatible embeddings API such as LiteLLM or
  OpenRouter (`EMBEDDING_BASE_URL`, `EMBEDDING_MODEL`, `EMBEDDING_DIMENSIONS`), with
  background re-embedding when the model changes (#55, #56).
- Claude gets a read-only copy of the user's workspace files in its run folder and
  can search it with Read, Glob and Grep; skill scripts can read it, and `save_file`
  stores files they make (`AGENT_WORKDIR=off` to turn off) (#77, #78).
- Rename files from the file list; history and open tabs follow (#72).
- Delete workspace skills from the Skills panel (#54).
- `read_file` pages through long files with `offset`/`limit` (#63).

### Fixed

- Files can be renamed: anyone who can edit a place (workspace owners included) gets a
  Rename button next to Delete in the file list. The file keeps its history and open
  tab; read-only files and names already taken are refused. API: `PATCH
  /api/files/<path>` with `{"path": "<new path>"}`.

### Changed

- Chat history moved into the chat pane, next to New chat; the top-right chat
  button opens the chat with the cursor in the message box (#69, #70).
- Knowledge tree buttons show on touch screens, and whoever adds a node owns it, so
  editors can delete nodes they created (#62).
- Non-Claude model ids behind a gateway are kept as written; the docker demo passes
  `ANTHROPIC_BASE_URL` to the agent (#53).
- Dependencies (#73): CopilotKit 1.79 with AG-UI 1.0, Claude Agent SDK 0.3 with the
  AG-UI adapter 0.0.7, Anthropic SDK 0.135, Next.js 16.4.2, transformers.js 4.3 and
  patch updates across both packages.

### Fixed

- Post-login redirects stay on the app's origin (#65).
- The agent no longer accepts unsigned chat requests when login is on without a
  database (#66).

### Known limitations

- `npm audit` still reports `@fastify/busboy` (high) through CopilotKit runtime's
  Vertex AI provider, which this app doesn't use; no upstream fix yet.
- Login sessions can't be revoked on the server yet: a removed role applies on the
  next request, but the session cookie itself stays valid until it expires (#64).

## 0.0.1 — first demo release

The first tagged version of Knowledge Chatroom: an AI-assisted workspace where you
browse runs, keep a knowledge tree and work with Claude (Claude Agent SDK over
AG-UI, rendered with CopilotKit) on the files you have open.

### Try it

`docker compose --profile demo up --build` with `ANTHROPIC_API_KEY` in `.env`, then
open <http://localhost:3000> (#51). See the README for running from source.

### Workspace

- Three panes: files on the left, preview/editor in the middle, Claude on the right (#3).
- Claude sees the open file and selected lines, and its answers link back to files and
  lines (#6).
- Runs: Traverse to browse them, Focus to work in one; New Chat and Generate/Open
  Rules actions, which Claude can drive too (#13: #14, #16–#19, #32).

### Knowledge and storage

- Versioned file storage on PostgreSQL and any S3-compatible store; files stay in the
  browser when no database is configured (#5, #8).
- Knowledge tree (tech › module › loop › process, levels configurable) with files per
  node (#9).
- Experiments: fork a node, record hypotheses, parameters and results, compare side by
  side (#20).
- Search by words and paths, and by meaning with a local multilingual embedding model
  when pgvector is available (#25, #31).
- Proposed changes: Claude's edits to knowledge nodes and promoted experiments wait for
  review as diffs (#33).

### Access

- Optional OpenID Connect login, users, groups, viewer/editor/owner grants and an
  audit log (#11, #12).
- PostgreSQL row-level security and five-minute signed download links (#15).

### Skills

- Auto, Manual or Off per skill, set for everyone, for yourself or for one chat;
  `/name` to invoke; a status bar of skills each turn used (#34, #35).
- A skill hub per deployment: publish, install, update, fork, `.zip` import/export,
  with publish-time checks, verified versions, reports and update diffs (#37, #38).
- Optional skill scripts in the SDK's sandbox with `SKILL_SCRIPTS=on` (#44).

### Quality

- Locked installs, type checks, lint, unit, storage integration and browser/storage/
  login E2E in CI, with UI previews on every pull request (#2, #10, #22–#24, #26,
  #27, #39, #45).
- Next.js 16.4.0 and patched dependencies, with no known critical advisories (#50).
- Workspace sync hardened against failed saves, reconnects and permission changes
  (#40–#43, #46, #47).

### Known limitations

- Single-user demo defaults: the Docker stack runs without login and with local
  storage credentials. See `docs/deployment.md` before sharing it.
- Chat needs an Anthropic API key; search by meaning downloads its model (about
  120 MB) on first start.
