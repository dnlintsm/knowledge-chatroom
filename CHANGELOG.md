# Changelog

## Unreleased

### Changed

- The Python workspace, including the `knowledge-chatroom` library, now requires
  Python 3.12 or later; Python 3.10 and 3.11 are no longer supported.

### Added

- The Python API server, `services/api-py` (issue #190, phase 3 of #169). It sits in front
  of the agent server at `LOCAL_AGENT_URL`, and the agent's routes move to it one group at a
  time. For now it passes every request through unchanged, SSE included, and checks that the
  database has exactly the migrations it knows. It refuses to start on a newer database. The
  agent server still applies the migrations. `pnpm dev` runs it on :8000 with the agent server
  on :8100, so `pnpm dev` now needs [uv](https://docs.astral.sh/uv/). `pnpm dev:ts` runs the UI
  and the agent server alone, as before. The demo compose file has a new `api` service, and the
  app, `agent-py`, `lab-tools` and `papers` reach the agent through `http://api:8000`. The
  conformance suite and the storage and login e2e run through it (`CONFORMANCE_TARGET=ts` and
  `E2E_API_PY=off` test the agent alone). A deployment without it keeps working while it only
  passes requests through ([Deployment](docs/deployment.md)).
- api-py now serves `/access` and `/nodes` itself (issue #190, step 2): people, groups,
  grants, the admin panel's lists, the audit log and the knowledge tree, with the same
  answers, refusals, audit entries, row-level security and change events as the agent
  server. It passes them through until the database has the migrations it knows. Run
  api-py in front of the agent server from this release on: without it these routes still
  work on the agent server alone, which keeps them until phase 4.
- api-py now serves `/files` too (issue #190, step 3): listing, reading, versions, writes,
  renames and deletes at the workspace root and in knowledge nodes, signed store links for
  binary files, the full-text index a write adds, and the `?watch` event stream, which
  hears changes from both servers through Postgres. An experiment's files (`?experiment=`)
  and proposed versions (`?propose`) still go to the agent server until step 4. api-py now
  reads the same `S3_*` and `MAX_UPLOAD_BYTES` settings as the agent server, so give both
  the same values; the demo compose file does.
- api-py now serves `/experiments` and an experiment's files too (issue #190, step 4a):
  creating and forking experiments, runs with their inputs, finishing and rerunning them,
  status changes and deletes, with each run's `report.md` front matter written byte for
  byte as the agent server writes it. Proposals (`/proposals`, `?propose`) and
  `/experiments/upload` still go to the agent server until step 4b.
- api-py now serves proposals and experiment uploads too (issue #190, step 4b): proposing a
  file with `?propose`, listing proposals, accepting (the new version is credited to its
  proposer), rejecting and withdrawing them, promoting an experiment's changes to its node,
  and the multipart `POST /experiments/upload`, read part by part as the agent server reads
  it. With this, all of step 4 is in Python.
- api-py now serves `/search` and runs the search indexer (issue #190, step 5): words and
  meaning ranked as the agent server ranks them, indexing files stored before search
  existed, and embedding passages with the same local model (through ONNX Runtime) or
  `EMBEDDING_*` API, giving the same vectors, so nothing is re-embedded. Start the agent
  server with the new `SEARCH_INDEXER=off` so only api-py indexes (`pnpm dev`, the e2e and
  the compose file do), and give api-py the same `EMBEDDING_*` and `SEARCH_MIN_SIMILARITY`
  settings and a writable `EMBEDDING_CACHE_DIR`. The compose `api` service caches its model
  in a new `api-models` volume.
- api-py now serves `/chats` too (issue #190, step 6): each user's chat history, listed a
  page at a time, opened, replayed run by run, saved as each run finishes, renamed, archived
  and deleted, with the same answers and row-level security as the agent server: a chat is
  its user's alone, workspace owners included, and storage tokens can't reach it. Searching
  past chats for Claude stays on the agent server with memory until step 8.

- api-py now serves `/skills` and the skill hub (`/hub`) too (issue #190, step 7a): skill
  lists and modes (yours, the workspace's, a chat's), what an outside agent's run gets
  (`/skills/run`, `/skills/used`), .zip export and import, deleting a workspace skill, and
  publishing, installing, forking, diffing, verifying, yanking and reporting hub skills, with
  the same scan flags, fingerprints and sort order as the agent server. Give api-py the same
  `HUB_ADMINS` and `SKILL_SCRIPTS` as the agent. `/tools` follows in step 7b.
- api-py serves the chat's "+" menu, `/tools`, too (issue #190, step 7b): the menu of
  `MCP_SERVERS` entries with a `ui` block, and the app's calls to their `ui.tools` over
  streamable HTTP or SSE, as the signed-in user, with the same identity and storage tokens,
  refusals and answers as the agent server. It does this only when `MCP_SERVERS` is set
  for api-py, so give it the same `MCP_SERVERS` (and `TOOLS_CALL_TIMEOUT_MS`,
  `STORAGE_TOKEN_SECONDS`) as the agent; without it `/tools` stays with the agent server.
  The demo compose file passes `MCP_SERVERS` to both.
- api-py serves each user's own memory notes too (issue #190, step 8a): reading, writing,
  restoring, archiving and deleting notes, the memory mode and incognito chats, the inbox's
  accept and reject, Claude's recent changes and their Undo, and the .zip export, with the
  same checks, versions, answers and row-level security as the agent server. It does this
  only with `MEMORY=on` for api-py, so give it the same `MEMORY` as the agent. The memory
  overview (`GET /memory`), shared notes, packs, import and `/memory/agent` stay on the agent
  server for now; chats keep using memory there.
- The Python chat agent runs with the app: `pnpm dev:python` starts it beside the UI and
  the agent server with `AGENT_URL` pointing at it, the `python-agent` compose profile
  builds `services/agent-py/Dockerfile`, and `pnpm test:e2e:python` (also in CI) runs the
  chat against it with a real Claude Code engine and a scripted model
  (`e2e/mock-anthropic.mjs`), so it needs no key (issue #176).

- Start, rerun and finish runs over the storage API, as the agent's own run tools do:
  `POST /experiments/runs` (`{nodeId?, title?, hypothesis?, params?, inputs?, rerunOf?,
  provenance?}`) starts a run in state running with its inputs linked read-only and a
  report.md whose front matter records where it came from, and
  `POST /experiments/{id}/finish` (`{results, state?: done|failed}`) finishes it. Storage
  tokens may use both, so a remote backend can run analyses (issue #176).
- A run's skills over HTTP, for backends outside the agent server:
  `GET /skills/run?thread=<id>` lists the skills a run gets in that chat (mode, source,
  files in base64) and `POST /skills/used` (`{thread, run?, skill, trigger}`) records a
  use. Both take the run's storage token (issue #176).
- `POST /identity/mcp-tokens` on the agent server: a remote backend trades its run's
  `X-Knowledge-Storage` (and `X-Knowledge-Memory`) tokens for its outside MCP servers'
  tokens, as the agent signs them for its own servers (`forwardIdentity`, `storageAccess`,
  `memoryAccess`): same user and chat, expiring no later. A remote backend needs no
  `AUTH_SECRET` for them (issue #176).
- Memory for a remote backend's chat agent: for each run with `AGENT_URL` the app also sends
  an `X-Knowledge-Memory` token for that chat (`via` `remote`; unsigned `local.` form without
  login). With it, `/memory/agent` treats the backend as Claude in the chat: the past-chat
  tools too, changes made with Undo until the run has used another tool (`?tainted=1`), and
  each tool answer lists the notes it read or changed (`events`, `tainted`). Outside MCP
  servers' memory tokens work as before (issue #176).
- `services/agent-py`: the chat agent in Python (FastAPI and `ag_ui_claude_sdk`), for
  `AGENT_URL` (issue #176, step 1 of phase 2 of #169). It chats with the app's own tools,
  checks the run's user, and gives the model the user's open file and place on every run.
  It works on the workspace's files through the storage API with the run's storage token,
  with the TypeScript agent's file and run tools (step 2), and has the user's skills, as
  on the agent server: auto and manual modes, `/name`, `skill_used` events and usage
  history, without scripts (step 3), and the user's memory in the chat: the memory prompt,
  the `memory_*` and `chats_*` tools and `memory` events (step 4), and the outside MCP
  servers in `MCP_SERVERS` with the chat's tool chips (step 5). Follow-up chips follow in
  a later step. The uv workspace now needs Python 3.11 or later (the AG-UI
  adapter does).
- The storage API's HTTP contract as an OpenAPI spec (`packages/contracts/openapi/storage.yaml`),
  with TypeScript types generated from it and checks that keep the spec, the generated types
  and the agent's own types in step (issue #169). No change to how the API behaves.
- A storage API conformance suite (`pnpm test:conformance`) that calls every operation in the
  spec against a running backend and checks each answer against it; CI runs it against the
  agent in the Storage tests workflow (issue #169).
- Upload an experiment with its files in one request: `POST /experiments/upload`
  (`/api/experiments/upload` through the UI) takes `multipart/form-data` with a `meta`
  part, `{id, path, title, hypothesis?, params?, results?, state?}`, and one part per file,
  named by its path in the experiment. `id` is the experiment's id, chosen by the caller (a
  UUID; 409 when any experiment ever had it). `path` names a knowledge node at every level,
  as `"Tech/Module/Loop/Process"` or a list; an empty name means a node called `None`
  (`"Etch/Module 3//"`), and nodes that don't exist yet are added, which needs editor access
  where they go. The experiment holds only the uploaded files, not a copy of its node's, and
  everything is written in one transaction, so a failed upload leaves nothing behind. Each
  file is limited by `MAX_UPLOAD_BYTES`, as for `PUT /files`, and `meta` to 256 KiB; the body
  is read as it streams in, so an oversized part is refused without being held in memory.
  Storage tokens can't use it.

  ```bash
  curl -X POST http://localhost:8000/experiments/upload \
    -F 'meta={"id":"0b8f6c2e-3d1a-4f5b-9c7e-2a4d6e8f0a1b","path":"Etch/Module 3/Endpoint/Recipe tuning","title":"Higher RF"}' \
    -F 'report.md=@./report.md' -F 'data/metrics.csv=@./metrics.csv'
  ```
- The spec and the conformance suite also cover memory, skills, the skill hub, the "+" menu's tools,
  follow-up suggestions, the identity public key and the health check (issue #169).
- Python models of the whole API: `knowledge_chatroom.api` (`packages/knowledge-py`, install
  the `api` extra for pydantic) is generated from the OpenAPI spec, and CI checks that it is
  up to date and that it parses every request and answer of the conformance run (issue #169).

### Changed

- Follow-up chips work with a remote backend (`AGENT_URL`): the app keeps asking this
  repo's agent server's `POST /suggest`, which needs only the messages, instead of
  keeping the first-round chips. The agent server no longer answers 404 there when it
  sees `AGENT_URL` (issue #176).
- Files no longer have a read-only flag: roles alone decide who may write, rename or delete a
  file (a node's or the root's editors, an experiment's author while it isn't archived), the
  same as for everything else. A run's generated `models/general_rules.md` is now an ordinary
  file of the run: its author can edit, rename or delete it, others who can see the run read
  it, and once it is deleted the run's **Open Rules** action turns back into
  **Generate Rules**, which asks the rules API again. An experiment's linked inputs
  (`inputs/…`) can also be changed or deleted by its author now; the run's provenance still
  records the versions it linked.
- The app and Claude call the existing object an **experiment** everywhere: the sidebar's
  **Experiments** view (was Runs), **New experiment**, **Compare experiments**, the compare
  tab, the experiment header and Claude's prompts and tool descriptions (#185). The frontend
  tools keep the names `listRuns` and `openRun`, so saved chats keep working; storage API
  names don't change.
- The experiment list keeps its own scope, in the URL as `?list=<nodeId>` (and `&direct=1`
  for a node's own experiments only), instead of following the place you're in: opening an
  experiment no longer narrows a list of all experiments to its Process. The scope shows as a
  chip with an ✕ back to all, and **Include sub-levels** is on by default. Moving to a node
  in the Knowledge tree or the breadcrumb points the list there (#186).
- Read-only badges say why: view access to the node, someone else's experiment (with its
  author's name), or an archived one, and the experiment shows the step you can take:
  **Restore** for its author, **Rerun as your own** for others who can see it, which starts
  a new experiment of yours. Access refusals from the storage API say what you can do there
  ("You can only view here; this needs editor access") (#187).

### Fixed

- A rerun reads its inputs at the content the earlier run recorded again, as it did before
  #175 made `inputs/` editable: it no longer silently picks up an edited copy. If a recorded
  input is gone, or an old record doesn't say what it held, the rerun fails and says which;
  passing `inputs` reads those files at their current versions instead (#187).
- `POST /experiments/upload` reads part names (the files' paths) as UTF-8. The agent server
  read them as Latin-1, so a file named `métrics.csv` was stored under a garbled path.

### Upgrading

- Migration `022_drop_read_only.sql` drops `files.read_only`. Files that were read-only (rules
  files, linked inputs, locked skill files) become ordinary files when it runs.
- Storage API: `PUT /files` no longer reads `X-Read-Only`, `GET /files/<path>` no longer sends
  `X-File-Read-Only`, and `FileInfo` and 403 errors no longer carry `readOnly`. Clients that
  relied on them should check the user's role instead. Deleting a skill no longer refuses
  because one of its files is read-only.

## 0.2.3

Search papers from the chat (OpenAlex and arXiv) with a new "+" menu, Papers chip and paper
cards; each answer's thinking and tool steps fold into one "Worked for 14s · 5 steps" line;
and Claude edits files in place instead of rewriting them, so chats fit smaller models.
Nothing is removed or renamed in this release.

### Upgrading from 0.2.2

- No database migrations, no removed or renamed settings, and no breaking changes: pull,
  then rebuild and restart the app and the agent (with Docker,
  `docker compose up --build -d` with the profile you use).
- `npm run env:check` lists four new optional settings: `CLAUDE_CODE_MAX_CONTEXT_TOKENS`,
  `CLAUDE_CODE_AUTO_COMPACT_WINDOW`, `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` and `CHAT_STEPS`.
  `npm run env:upgrade` appends them commented out; nothing changes until you set them.
- Paper search is opt-in: run the `papers` MCP server (`docker compose --profile papers`, or
  `examples/papers-mcp`) and add it to `MCP_SERVERS` with its `ui` block, as in
  `.env.example`. Without it the "+" menu has no Search papers entry.
- Remote agent backends keep working: forwarded props stay at version 2 and only gain an
  optional `tools` field (the chips the user turned on). A Python backend that wants the
  Papers chip follows step 8 in `docs/remote-agent.md`.

### Added

- Paper search MCP server, `examples/papers-mcp` (#151, #152): `search_papers` (OpenAlex,
  with year, author, venue and open-access filters, sorting and paging), `get_paper`
  (abstract, BibTeX; `openalex:`, `doi:` or `arxiv:` ids, with an arXiv fallback for new
  papers), `read_paper` (open-access PDF text, paged by lines, with section headings),
  `related_papers` (cites, cited by, similar) and `save_paper` (a markdown note at
  `papers/<title>.md` in the current place, optionally with the PDF; a proposal in a
  knowledge node). Callers are checked with the forwarded identity, like the Python agent
  sample. `docker compose --profile papers` runs it, and CI tests it.
- Paper search in the chat (#151, #153). The composer's "+" menu lists MCP tools whose
  `MCP_SERVERS` entry has a `ui` block; **Search papers** turns on a **Papers** chip above
  the message box, kept per chat. Search results show as paper cards (title, authors, venue,
  year, citations, open access, abstract) with **Save to workspace**, **Ask about this**,
  **PDF** and **Page**. The agent serves the menu at `GET /tools` and single tool calls at
  `POST /tools/<server>/<tool>` (proxied as `/api/tools`), only for tools listed in the
  `ui` block. New built-in `paper-search` skill.
- `edit_file` tool, and `editWorkspaceFile` for browser-only workspaces (#126, #127). Claude
  replaces one exact piece of text (or every match with `replaceAll`) and gets the changed
  lines back, instead of reading and rewriting a whole file. Same rules as `write_file`:
  proposals in knowledge nodes and skills, read-only files refused, every write versioned.
- Context-window settings for models the engine doesn't know, such as a local model behind
  `ANTHROPIC_BASE_URL` (#127): `CLAUDE_CODE_MAX_CONTEXT_TOKENS`,
  `CLAUDE_CODE_AUTO_COMPACT_WINDOW` and `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`, passed to the
  agent by docker compose when set.

### Changed

- Each answer's thinking, tool calls and narration fold into one line above the answer,
  "Worked for 14s · 5 steps" (#154, #155). While Claude works it is a live status with a
  timer; clicking it opens the steps, and each step its arguments and result. Paper cards,
  charts, A2UI surfaces, questions for the user and errors stay visible. A **Compact /
  Detailed** button in the chat header switches per user; `CHAT_STEPS=detailed` on the UI
  makes Detailed the default. Durations survive a reload from chat history.
- `read_file` returns at most 50,000 characters per read (was 200,000), so one read stays
  under the engine's limit for a single tool result (#127). Paging with `offset`/`limit`
  works as before.

### Fixed

- From the second turn of a chat, a turn's thinking block disappeared when the reply
  finished (#156, #157).

### Known limitations

- Paper search was tested against recorded OpenAlex and arXiv responses, not the live APIs.
- The steps line doesn't count failed tool calls: the Claude adapter's tool results don't
  say whether a tool failed.

## 0.2.2

Files load faster when the app opens, you can upload files straight into an existing
run and add them as its inputs, a failed Claude run says why, and a new
`npm run env:check` / `npm run env:upgrade` keeps your `.env` in step with each release.
Nothing is removed or renamed in this release.

### Upgrading from 0.2.1

- No database migrations, no new or renamed settings, and no breaking changes: pull,
  then rebuild and restart the app and the agent (with Docker,
  `docker compose up --build -d` with the profile you use).
- Run `npm run env:check` after pulling (#112). It should report nothing to change when
  you come from 0.2.1. When you come from an older release, it lists the settings later
  releases removed (`IDENTITY_FORMAT`, `RUN_DIR_MARKERS`) or renamed (`AGENT_URL` on port
  8000 becomes `LOCAL_AGENT_URL`), and `npm run env:upgrade` applies that after backing up
  `.env`. Still follow the "Upgrading" steps of each release you skip.
- If chat showed "SDK resume/run failed; check the original files, tools, credentials and
  execution configuration.", the chat and the agent log now show the real reason after
  this upgrade (#116).

### Added

- `npm run env:check` and `npm run env:upgrade` for an outdated `.env` (#112). The check
  lists settings a release removed (`IDENTITY_FORMAT`, `RUN_DIR_MARKERS`) or renamed
  (an old `AGENT_URL` on port 8000, in a `.env` without `LOCAL_AGENT_URL`, becomes
  `LOCAL_AGENT_URL`), settings new in
  `.env.example`, and settings `.env.example` doesn't know. The upgrade backs up `.env`
  to `.env.backup-<time>`, comments out removed settings, renames, and appends the new
  settings commented out with their explanations, so nothing else changes until you
  uncomment them. Only names are printed, never values.
- Upload files into an existing run (#114, #115). The run panel has an **Add files**
  section (button and drop zone), and the Runs view an **Add files to ‹run›** button that
  opens it. Files go to the run's `uploads/`; with **Add as run inputs** (on by default)
  each one is also linked read-only under `inputs/` and recorded in the run's provenance,
  so a rerun reads it too. A finished (done or failed) run keeps the inputs it ran with,
  so its files go to `uploads/` only. Only the run's author can add files, and not to an
  archived run. The agent server has a matching `POST /experiments/<id>/inputs`, which
  storage tokens may call too.

### Changed

- Faster page loads with server storage (#118, #119, #120). The file list now comes from
  metadata only, and a text file's content is fetched when it is opened (or when Claude is
  given a run's `report.md`), instead of every text file being downloaded on every page
  load and every move between places. Account, tree, proposals and the last place's
  listing load in parallel. Until storage answers, the side panel shows "Loading files…",
  the editor a spinner and the top bar "Loading files", instead of briefly showing local
  files and swapping them out; a file being fetched shows "Loading ‹name›…" with a retry
  if it fails.

### Fixed

- A failed Claude run says why in the chat and the agent log (for example a bad API key,
  an unknown model or a gateway error) instead of only "SDK resume/run failed; check the
  original files, tools, credentials and execution configuration." (#116, #117).

### Known limitations

- Claude runs that fail only for some non-owner accounts, while the owner's runs work,
  are not fixed yet. With #117 the chat now shows the reason, which should point to the
  cause.

## 0.2.1

Files preview in the editor pane (images, PDFs, audio, video, code, HTML, TSV), the file
tree remembers which folders you collapsed, and two leftovers kept for one release are
removed: `v1` identity tokens and old `xdoe-report/` run folders. Those removals can break
an upgrade, so follow the steps below.

### Upgrading from 0.2.0

- **Check `IDENTITY_FORMAT` first.** `IDENTITY_FORMAT=v1` is gone (#100, #106). Identity,
  storage and memory tokens are only `v2` (Ed25519), and `v1` HMAC tokens are refused. If
  the app or agent still has `IDENTITY_FORMAT=v1` (or any value other than `v2`) set, the
  agent refuses to start and says why: remove the variable from `.env` and the compose
  file, and make sure remote backends and MCP servers verify with the public key from
  `GET /identity/public-key` (see `docs/remote-agent.md`). Deployments without outside
  services only need the variable unset, if it was set.
- **Convert old run folders before upgrading** (#107). Folders holding `xdoe-report/` can
  no longer be turned into runs, and a run's report is only its top-level `report.md`.
  Use **Make run** on 0.2.0 for any such folder you still want as a run, then upgrade. A
  run made from one earlier keeps its files, but its report no longer opens by itself:
  rename its `xdoe-report/report.md` to `report.md`. Folders never converted stay
  ordinary folders.
- No database migrations in this release, and no new settings.
- File previews load stored files through their signed S3 links, so `S3_PUBLIC_URL` must
  be reachable from the browser (and https when the app is https). If it isn't, the image
  viewer now says so instead of showing a broken image.

### Added

- Previews in the editor pane (#103, #104). Images get a viewer with Fit / Actual size,
  pixel size and an Open link; PDFs open in the browser's viewer; audio and video play in
  native players; code is highlighted with Preview / Edit like markdown (chat line
  references highlight here too); HTML renders in a fully sandboxed frame with the source
  under Edit; TSV shows as a table like CSV. Anything else shows "No preview" with a
  Download link. More file types get the right MIME type (bmp, ico, avif, apng, tsv, htm,
  common audio and video), and more text extensions (go, rs, java, c/cpp, rb, php, swift,
  log, ini, jsonl, ipynb, vue, svelte and others) can be read by Claude too.
- Folders you collapse in the file tree stay collapsed when you switch views or reload,
  separately for the workspace root, each knowledge node and each run (#109). This is
  kept per browser, like open tabs and the pane layout.

### Fixed

- An image that can't be loaded, or a format browsers don't show (HEIC, TIFF), no longer
  shows a silent broken-image icon; the viewer explains the likely cause and offers Open /
  Download (#103). Files with extensions missing from the MIME table, previously stored as
  `application/octet-stream`, now preview by extension.

### Removed

- The `v1` (HMAC with `AUTH_SECRET`) identity token format and the `IDENTITY_FORMAT`
  setting, kept in 0.2.0 for one release while services moved to the public key.
- The `xdoe-report/` run folder marker (#82): the Runs view's **Make run** list of old run
  folders, `POST /experiments/from-folder`, and `xdoe-report/report.md` as a run's report.
  The sample run folders in the browser-only workspace keep their report at `report.md`.

### Known limitations

- No previews for Office files (docx, xlsx, pptx) or HEIC/TIFF images, which need a
  converter; notebooks show as JSON. Signed links last five minutes, so a long video
  paused past that may need a reload to seek.
- Memory still hasn't been tried with real Claude (#108). Server sessions and CSRF checks
  (#64) and the audit finding in CopilotKit's unused Vertex AI provider (#75) are still
  open.

## 0.2.0

Claude remembers: with `MEMORY=on`, Claude keeps notes about each user that only they
see, learns from quiet chats, finds notes by meaning and searches your past chats, and
shares notes with a workspace, node or group under review. Chat history moves to the
server, one private list per user, and outside services verify users with a public key
and get their own storage tokens.

### Upgrading from 0.1.2

- **Back up Postgres first.** Migrations `017_chats.sql` to `021_memory_packs.sql` run on
  agent start.
- Chats kept before this release are not carried over. Without server storage they were
  only in the app's memory anyway; from now on each user's chats are saved (#91).
- Memory is off until you set `MEMORY=on` (the Docker compose file passes it through),
  and it needs server storage. Learning from chats uses `MEMORY_MODEL` (default: the
  follow-up chips' Haiku), so with memory on expect a small model call per chat once it
  has been quiet for `MEMORY_IDLE_MINUTES` (default 10). `MEMORY_LEARN=off` keeps memory
  but stops learning.
- MCP servers get nothing new unless their `MCP_SERVERS` entry opts in with
  `"storageAccess": true` or `"memoryAccess": true`. Remote backends (`AGENT_URL`) now
  receive an `X-Knowledge-Storage` token with every run.
- Identity tokens (`X-Knowledge-User`) are now signed with a key pair derived from
  `AUTH_SECRET` (`v2`, Ed25519) instead of HMAC with the secret itself (#88). Outside
  services verify them with the public key from the agent's `GET /identity/public-key`
  (also logged at startup), so they no longer need `AUTH_SECRET`. Remote backends and MCP
  servers that verify `v1` tokens: switch to the public key (see `docs/remote-agent.md`
  and `examples/python-agent`), or set `IDENTITY_FORMAT=v1` on the app and the agent until
  you do. `IDENTITY_FORMAT=v1` will be removed in the next release.
  Deployments without outside services need no change.

### Added

- Search by meaning over memory, and Claude searching past chats (#93, step 5). When the
  agent runs an embedding model (the one file search uses), `memory_search` also lists
  notes close in meaning to the query. In chats with memory, Claude can find and read
  the user's earlier chats with `chats_search` and `chats_read`; incognito chats are
  never found, and changes to memory after reading a past chat wait in the inbox.
- Memory for Python MCP servers (#93, step 5). With `"memoryAccess": true` in
  `MCP_SERVERS`, runs where memory is on send the server an `X-Knowledge-Memory` token
  for that chat. Through the agent's `/memory/agent` API the server gets the chat's
  memory prompt and the same memory tools as Claude; its changes always wait in the
  user's Memory inbox. The sample Python agent's `recall_user_notes` tool shows how.
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
