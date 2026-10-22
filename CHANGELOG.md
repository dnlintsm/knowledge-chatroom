# Changelog

## 0.2.0

Claude remembers: with `MEMORY=on`, Claude keeps notes about each user that only they
see, learns from quiet chats, and shares notes with a workspace, node or group under
review. Chat history moves to the server, one private list per user, and outside
services verify users with a public key and get their own storage tokens.

### Upgrading from 0.1.2

- **Back up Postgres first.** Migrations `017_chats.sql` to `021_memory_packs.sql` run on
  agent start.
- Chats kept before this release are not carried over. Without server storage they were
  only in the app's memory anyway; from now on each user's chats are saved (#91).
- Memory is off until you set `MEMORY=on`, and it needs server storage. Learning from
  chats uses `MEMORY_MODEL` (default: the follow-up chips' Haiku), so with memory on expect
  a small model call per chat once it has been quiet for `MEMORY_IDLE_MINUTES` (default
  10). `MEMORY_LEARN=off` keeps memory but stops learning.
- MCP servers get nothing new unless their `MCP_SERVERS` entry opts in with
  `"storageAccess": true`. Remote backends (`AGENT_URL`) now receive an
  `X-Knowledge-Storage` token with every run.
- Identity tokens (`X-Knowledge-User`) are now signed with a key pair derived from
  `AUTH_SECRET` (`v2`, Ed25519) instead of HMAC with the secret itself (#88). Outside
  services verify them with the public key from the agent's `GET /identity/public-key`
  (also logged at startup), so they no longer need `AUTH_SECRET`. Remote backends and MCP
  servers that verify `v1` tokens: switch to the public key (see `docs/remote-agent.md`
  and `examples/python-agent`), or set `IDENTITY_FORMAT=v1` on the app and the agent until
  you do. `IDENTITY_FORMAT=v1` will be removed in the next release.
  Deployments without outside services need no change.

### Added

- Memory packs and import (#93, step 4). A place's editors publish its shared notes to
  the hub as a memory pack, with numbered versions scanned like skills. Installing one
  in a workspace, node or group adds its notes there pinned to that version, read-only
  and Manual for everyone; installs can move to a newer version, be forked into the
  place's own notes, or be uninstalled. Hub admins verify versions, and publishers or
  admins yank them. "Import memory…" in the Memory view takes another assistant's
  memory (pasted, or a file) or a `.zip` export and puts every note in the inbox for
  review. Migration `021_memory_packs.sql` runs on start.
- Shared memory (#93, step 3). Notes can belong to the whole workspace, a knowledge node
  (and everything below it) or a group, and who reads and edits them follows the grants.
  Every chat gets the workspace's notes, its user's groups' notes and the notes of the
  node the user is in. Each one is Auto (in Claude's memory index), Manual (Claude finds
  it by searching) or Off, for everyone and per person. Claude never changes shared
  notes itself: its changes are proposals that the notes' editors accept or reject in the
  Memory view. "Share a copy" copies one of your own notes there, after you check its
  text, or sends it to the editors for review. Migration `020_shared_memory.sql` runs on
  start.
- Memory learns from chats (#93, step 2). Once a chat has been quiet for 10 minutes, a
  small model reviews it against the user's notes and adds, merges, corrects or retires
  notes (at most 5 changes per chat). A new "Ask first" mode sends every change, from chats
  and from learning, to a review inbox in the Memory view. Turns that read files, web pages
  or other tool output always go through the inbox, so text in them can't quietly rewrite
  memory. The Memory view also lists Claude's recent changes with Undo and marks notes
  unused for 60 days. `MEMORY_LEARN=off` turns learning off; `MEMORY_MODEL` and
  `MEMORY_IDLE_MINUTES` tune it. Migration `019_memory_learning.sql` runs on start.
- Personalized memory, experimental (#93). With `MEMORY=on` and server storage, Claude keeps
  short notes about each user across chats. Every chat's prompt gets an index of them, and
  Claude has memory tools to read, search, save, edit and delete notes. Only that user sees
  their notes, workspace owners included. The Memory view lists them, and each one opens in
  the middle pane to edit, restore an earlier version, archive or delete. Under the chat
  input, a line shows which notes Claude used or changed in the turn, with Undo. A chat can
  be made incognito so that Claude neither reads nor saves memory in it. Memory can be
  turned off per user and exported as a `.zip`. Migration `018_memory.sql` runs on start.
- Chat history is kept per user (#91). Chats survive reloads and restarts: with server
  storage in Postgres (migration `017_chats.sql`, run on start), without it in memory. The
  history button lists your own chats, which you can reopen, rename, archive or delete;
  nobody else sees them, workspace owners included. Before this, without CopilotKit
  Intelligence, chats were kept in the app's memory only, in one list shared by every
  signed-in user.
- Storage tokens for outside services (#88). MCP servers with `"storageAccess": true` and
  remote backends (`AGENT_URL`) get an `X-Knowledge-Storage` token with each run. With it they
  read and write workspace files through the storage API as Claude acting for the signed-in
  user: only that user's files, node writes as proposals, and no renaming, deleting, reviewing
  or sharing. The activity log records these changes as Claude's, with the service they came
  through. Tokens last `STORAGE_TOKEN_SECONDS` (default an hour), so long remote runs keep
  access. The Python sample gains `describe_column`, which reads a CSV from the workspace
  this way.

### Changed

- The AG-UI Claude adapter is 0.0.8 (still on Claude Agent SDK 0.3.296, which it pins).

### Known limitations

- Memory is experimental and hasn't been tried with real Claude yet. Turning notes into
  skills or knowledge nodes is planned for later (#93).
- Background jobs for long runs (#82), server sessions and CSRF checks (#64), and the
  `@fastify/busboy` audit finding in CopilotKit's unused Vertex AI provider (#75) are
  still open.

## 0.1.2

Runs become experiments: the Runs view replaces Traverse, Claude starts runs from your
files with an `analysis` skill and records where every result came from, and the chat
can go to a remote agent backend.

### Upgrading from 0.1.1

- Runs are experiments now (#82). The Traverse view, Focus mode, `?run=` links and
  `RUN_DIR_MARKERS` are gone; a run is an experiment with a `report.md`. Existing run
  folders (holding `xdoe-report/`) are listed in the Runs view, where **Make run** moves
  each into a new experiment with its history. Runs need server storage. Migrations
  `015_runs.sql` and `016_run_provenance.sql` run on start.
- The rules API (`RULES_API_URL`) is now asked `?run=<run title>&experiment=<id>`
  instead of `?run=<folder>`.
- `AGENT_URL` now names a remote agent backend for the chat. This repo's agent server
  moved to `LOCAL_AGENT_URL` (default `http://localhost:8000`). Remove
  `AGENT_URL=http://localhost:8000` from your `.env`, or rename it to
  `LOCAL_AGENT_URL`. The docker demo already sets `LOCAL_AGENT_URL`.
- Back up the database before upgrading, as for any release with migrations.

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
- Runs Claude starts (#82, step 2): `create_experiment` takes the files a run works from
  as `inputs`, linked in read only under `inputs/` at their current versions, and starts
  the run in state running with a `report.md`. `set_experiment_results` records the
  results and finishes it. Each run records its provenance (who, when, which chat, model,
  skill and tool versions, input versions and hashes) in the report's front matter and in
  the run panel.
- An `analysis` skill (#82, step 3), built in and Auto: Claude analyzes uploaded files as
  a run, with a report template and, with `SKILL_SCRIPTS=on`, a CSV profiling script.
  `create_experiment` takes `rerunOf` to run an earlier run again as a new run with the
  same inputs; the panel links a rerun to its original. A finished run can't be finished
  again with other results.

### Changed

- The app name in the title bar is a home link to the workspace root (#79).
- The chat shows everywhere, so a workspace with no runs can still chat about the
  files where you are (#81).

### Known limitations

- Analyses run within one chat turn; background jobs with progress for long runs are
  still open on #82.
- `npm audit` still reports `@fastify/busboy` (high) through CopilotKit runtime's
  unused Vertex AI provider (#75).
- Login sessions can't be revoked on the server yet (#64).

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
