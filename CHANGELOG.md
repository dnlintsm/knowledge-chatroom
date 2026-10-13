# Changelog

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
