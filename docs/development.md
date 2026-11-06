# Development

Use Node 22 from `.nvmrc`. Install both locked packages with `npm ci` at the root;
`npm run install:agent` repeats only the agent installation. Use `npm install`
only when intentionally changing dependencies, and include the relevant lockfile.

Copy `.env.example` to `.env`. For real chat set `ANTHROPIC_API_KEY`;
`CLAUDE_MODEL` defaults to `claude-sonnet-5`. `npm run dev` starts the UI on 3000
and the agent on 8000. `npm run dev:ui` and `npm run dev:agent` run them separately.
Check the agent with `curl http://localhost:8000/health`; storage can still be
migrating after this health endpoint answers.

After an upgrade, `npm run env:check` compares `.env` with `.env.example`: settings a
release removed or renamed, new settings, and ones `.env.example` doesn't know. Only
names are printed. `npm run env:upgrade` backs up `.env` to `.env.backup-<time>`,
comments out removed settings, applies renames, and appends new settings commented out
with their explanations. `--env` and `--example` point it at other files, e.g.
`node scripts/env-upgrade.mjs --env /srv/knowledge/.env`. A release that removes or renames a
setting adds a row to `MIGRATIONS` in `scripts/env-upgrade-plan.mjs`.

## Optional server storage

```bash
docker compose up -d
```

The compose file pins PostgreSQL/pgvector and SeaweedFS by verified image digest.
Uncomment the workspace storage values in `.env.example` when copying to `.env`:
`DATABASE_URL`, `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`,
`S3_SECRET_ACCESS_KEY`, `S3_FORCE_PATH_STYLE` and `S3_PUBLIC_URL`. Local defaults
are documented there and in `deploy/seaweedfs/s3.json`.

Migrations run at agent startup. PostgreSQL stores metadata/history; the object
store holds content keyed by SHA-256. Keep both volumes to retain the workspace.
`docker compose down` stops services without deleting volumes.

Without `DATABASE_URL`, files stay in localStorage and the title bar says
"This browser". With working storage it says "Saved"; save failures appear in the
UI. To isolate storage tests from personal files, create disposable databases as
shown in [Testing](testing.md).

## Runs, rules and semantic search

A run is an experiment with a report (`report.md`), so runs need server storage.
`RULES_API_URL` configures the server-side rules provider; when
unset, the built-in mock answers. Actions use the user's role in the run, and generated
rules files are read-only. See [Architecture](architecture.md).

With pgvector, semantic search downloads a local embedding model on first use
and caches it under `EMBEDDING_CACHE_DIR` or `~/.cache/knowledge-chatroom/models`.
`EMBEDDING_MODEL=off` disables embeddings while retaining keyword search.
Changing the model re-embeds the corpus. See `.env.example` for the default model,
and for `EMBEDDING_BASE_URL` to use an OpenAI-compatible embeddings API (LiteLLM,
OpenRouter, OpenAI) instead of the local model.

## Models and chat suggestions

`CLAUDE_MODEL` picks the chat model. To use a gateway (LiteLLM, OpenRouter) set
`ANTHROPIC_BASE_URL`; model ids that are not `claude-*` are passed through as
written, e.g. `openai/gpt-5.1`. Extended thinking for non-Claude models depends on
the gateway: enable reasoning there (LiteLLM `reasoning_effort`, OpenRouter
reasoning settings), since the agent's adaptive thinking request is dropped by
most proxies.

Each chat is one Claude engine session that compacts (summarizes) its history before it
outgrows the model's context window. For a model the engine doesn't know, such as a local
model behind `ANTHROPIC_BASE_URL`, it has to guess that window: set
`CLAUDE_CODE_MAX_CONTEXT_TOKENS` to the model's real window, and if chats still fail with
a context-length error, compact earlier with `CLAUDE_CODE_AUTO_COMPACT_WINDOW` (tokens) or
`CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` (percent of the window). They are read by the agent;
docker compose passes them through when set. Claude changes files with `edit_file` (one
exact replacement) and reads them in pages of at most 50,000 characters, so changing a
large file doesn't put the whole file into the history again.

The chips under the chat start from what is open (summarize the file, analyze the
run's report, search similar experiments with server storage). After each reply
the agent's `POST /suggest` makes one small-model call for follow-ups:
`SUGGESTIONS_MODEL` (default `claude-haiku-5-5`, or `CLAUDE_MODEL` when that is
not a Claude model). `CHAT_SUGGESTIONS=static` on the UI keeps the first-round chips
and makes no extra calls. See [Chat suggestions](architecture.md#chat-suggestions).

Each answer's thinking and tool calls fold into one "Worked for 14s · 5 steps" line above it.
The steps button in the chat header switches a user to Detailed (every step open, with its
arguments and result); `CHAT_STEPS=detailed` on the UI makes that the default. See
[Agent steps in the chat](architecture.md#agent-steps-in-the-chat).

## Skills

Built-in skills live in `agent/skills/`; with server storage, the agent also loads
workspace skills from `skills/<name>/SKILL.md` and skills installed from the hub. Users choose Auto, Manual, or Off, for
themselves or one chat; editors of the workspace root set the default for everyone.
Slash commands run only enabled skills; the status bar shows enabled and used
skills. `SKILLS_RUN_DIR` sets the agent's temporary per-user working directory; with server
storage it also holds a read-only copy of the user's files that Claude searches with
Read/Glob/Grep (`AGENT_WORKDIR=off` turns it off; see
[Working folder](architecture.md#working-folder)).
Skills are instructions; embedded shell commands are not executed. With
`SKILL_SCRIPTS=on` the agent runs skills' scripts in the SDK's sandbox, which needs
bubblewrap (`apt-get install bubblewrap`; macOS has its own) on the agent host; see
[Skill scripts](architecture.md#skill-scripts). `HUB_ADMINS`
(emails or login subjects, comma-separated) names who may verify hub skills and
dismiss reports; without login the built-in user is an admin. See
[Architecture](architecture.md#skills) for the behavior and limits.

## Outside MCP servers

`MCP_SERVERS` connects the agent to MCP servers beside its own tools, for example
a Python server holding the tools of an existing agent (#60). Its value is JSON,
or a path to a JSON file, shaped like Claude's `.mcp.json`:

```json
{"mcpServers": {
  "lab": {"url": "http://localhost:9100/mcp", "forwardIdentity": true, "storageAccess": true,
          "headers": {"Authorization": "Bearer ${LAB_TOKEN}"}},
  "local": {"type": "stdio", "command": "python", "args": ["tools.py"]}
}}
```

`type` is `http` (the default), `sse` or `stdio` (give stdio servers absolute paths:
runs with skills start in their own folder). `${VAR}` in `headers` and `env`
reads the agent's environment, so secrets stay out of the file. Every tool of a
configured server runs without asking, as `mcp__<name>__<tool>`; a server that is
down is left out and the chat carries on. With login on, `forwardIdentity` sends
the run's signed user as the `X-Knowledge-User` header (`v2.<payload>.<Ed25519
signature>`, valid for an hour; verify it with the public key from the agent's
`GET /identity/public-key` as in `examples/python-agent/lab_tools/identity.py`,
and check its `aud` is `mcp:<name>`). Give the server that public key, never
`AUTH_SECRET`: with the key it can check tokens but not sign them. The token is
signed for that server only, and the agent refuses it, so a server can't call the
agent's own APIs as the user.

`storageAccess` gives a server workspace files (#88): each run also sends an
`X-Knowledge-Storage` token, which the server passes on unchanged to the storage
API (`/files`, `/nodes`, `/experiments`, `/search`, `/proposals` on this agent
server). Requests with it are Claude acting for the signed-in user. They get that
user's access and nothing more, with the same limits as Claude's own file tools:
writes in a knowledge node (and to skills at the root) need `?propose`, and
nothing is renamed, deleted, reviewed or shared (experiments included). The activity log credits them to
Claude, `via` `mcp:<name>`. The token lasts `STORAGE_TOKEN_SECONDS` (default an
hour), and only the storage API takes it. Servers must not connect to the database
or object store directly: the app's connection owns the tables, so row security
doesn't apply to it, and presigned links skip every check.

A `ui` block puts a server in the chat's "+" menu (#151), next to "Add attachments":

```json
"papers": {"url": "http://localhost:9200/mcp", "forwardIdentity": true, "storageAccess": true,
           "ui": {"label": "Search papers", "chip": "Papers", "icon": "book-open",
                  "mode": "auto", "tools": ["search_papers", "get_paper", "save_paper"]}}
```

Picking it puts a chip (`chip`, default `label`) above the message box. The chip stays on
for that chat (remembered in the browser) until the user removes it. While it is on, every
run carries it as `forwardedProps.knowledge_chatroom.tools`, and the agent adds a prompt
line telling Claude to answer with that server's tools. With `"mode": "auto"` (the default)
Claude has the tools in every run anyway. With `"manual"` they are left out of runs
without the chip. `icon` is a lucide name (`book-open`, `globe`, `search`,
`database`; otherwise a wrench). `tools` lists the tools the app itself may call for the
signed-in user, as the paper cards' Save button does:

| Route (agent server, `/api/tools` in the app) | Answer |
| --- | --- |
| `GET /tools` | `{tools: [{server, label, chip, description, icon, mode, callable}]}` |
| `POST /tools/<server>/<tool>` with `{arguments: {...}}` | `{result, text}`: the tool's structured content (or the JSON in its text). `422 {error}` is the tool's own error, `403` a tool not in `tools`, `502` a server that is down. |

The call reaches the server with the same `X-Knowledge-User` and `X-Knowledge-Storage`
headers a chat run sends, so the server sees the same person either way. A call that takes
longer than `TOOLS_CALL_TIMEOUT_MS` (default 120000) fails. `ui` needs an http or sse
server. [examples/papers-mcp](../examples/papers-mcp/README.md) is the paper search server
for it; `docker compose --profile papers` runs it next to the demo.

`memoryAccess` gives a server the user's memory in the chat that calls it (#93):
in runs where memory is on, each run also sends an `X-Knowledge-Memory` token
(aud `memory`, with the chat's `thread` and `node`; without login an unsigned
`local.` token). The server passes it to `GET /memory/agent` (the memory prompt
and the `memory_*` tools with JSON schemas) and `POST /memory/agent/tools/<tool>`.
It reads like Claude in that chat; every change waits in the user's Memory inbox
or goes to a shared note's editors, and shows under the reply while the run goes.
Incognito chats and memory turned off get no token, and each call checks again.

[examples/python-agent](../examples/python-agent/README.md) is a complete sample:
a Python agent's prompt moved into a skill and its tools into an MCP server, with
the forwarded user checked and tests. Start there when bringing a Python agent in.
[examples/papers-mcp](../examples/papers-mcp/README.md) is another one: paper
search, with workspace writes through `storageAccess`.

A minimal Python server (`pip install mcp`; with mcp 1.x import `FastMCP` from
`mcp.server.fastmcp` instead):

```python
from mcp.server.mcpserver import MCPServer, Context

mcp = MCPServer("lab")

@mcp.tool()
def whoami(ctx: Context) -> str:
    """Says which signed-in user called."""
    return (ctx.headers or {}).get("x-knowledge-user", "local")

mcp.run(transport="streamable-http", host="127.0.0.1", port=9100)
```

## Remote agent backend

The chat can use an agent from a separate backend instead of this repo's own:
set `AGENT_URL` to its base URL, and every chat run goes to
`${AGENT_URL}/agent/report`. This repo's agent server keeps serving storage and
skills at `LOCAL_AGENT_URL` (default `http://localhost:8000`, which `npm run dev`
starts), and turns its own chat off. Each run tells the backend who the user is and
where they are in `forwardedProps.knowledge_chatroom`. What the backend receives and
must do is in [Remote agent backend](remote-agent.md).

`AGENT_URL` used to be the address of this repo's agent server. If your `.env` still
has `AGENT_URL=http://localhost:8000`, remove it, or rename it to `LOCAL_AGENT_URL`.

## Optional login

Set `AUTH_MODE=oidc` and the same `AUTH_SECRET` (at least 32 characters) for Next.js and the agent.
Generate one with `openssl rand -hex 32`. Configure `OIDC_ISSUER`, `OIDC_CLIENT_ID`
and, for confidential clients, `OIDC_CLIENT_SECRET`. Register
`<APP_URL>/api/auth/callback` with the provider; set `APP_URL` to the external UI URL.
The issuer and `APP_URL` must use https unless they are on localhost; set
`AUTH_ALLOW_HTTP=true` to test with an http provider elsewhere. The first person to
sign in owns the workspace. Without login (`AUTH_MODE=local`, or no `AUTH_SECRET`
in development), one built-in user owns it. The [Deployment guide](deployment.md) covers the private agent boundary.

Chat history needs nothing extra: each user's chats are kept by the agent server, in
Postgres with `DATABASE_URL` and in memory without it ([Architecture](architecture.md#chat-history)).
`CPK_INTELLIGENCE_API_KEY` is optional and keeps threads in CopilotKit Intelligence
instead. Its browser gate is resolved at build time, so rebuild after changing it for a
production run.

## Dependency security

The root and agent lockfiles are audited separately (`npm audit` and
`npm --prefix agent audit`). Both use `overrides` to pin patched transitive versions:

| Lockfile | Overrides |
| --- | --- |
| Root (`package.json`) | `body-parser`, `follow-redirects`, `graphql-scalars`, `undici` and `katex`, plus `@ag-ui/core`, `encoder` and `proto` held on 1.0.2, the version of the UI's `@ag-ui/client` |
| Agent (`agent/package.json`) | `body-parser`, `sharp` and `adm-zip`; its own `@ag-ui/core` and `@ag-ui/encoder` dependencies are on 1.0.4, which use Zod 4 |

When updating these dependencies, recheck the overrides and run the build and tests
before removing any. The `undici` and `graphql-scalars` overrides cross an upstream
major-version range, so also test any enabled provider or integration that relies on them.

The UI still uses Zod 3, directly and through CopilotKit, which declares a Zod 3 range.
It is affected by [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5)
and has no compatible patched 3.x release. Monitor upstream for a compatible
upgrade; forcing Zod 4 across that dependency tree can break the app. On shared
deployments, configure request-size limits at the reverse proxy according to the
files and requests the deployment needs. This reduces exposure to oversized
inputs but is not a substitute for upgrading the affected dependency.

## Troubleshooting

- Agent connection errors: check port 8000, the health endpoint and the API key.
- Dependency errors: select Node 22, stop dev/test servers, then run `npm ci`.
- Test port in use: stop your existing server or override the E2E ports listed in
  [Testing](testing.md). The runner intentionally refuses to reuse an unknown server.
- S3 writes failing after multiple test buckets: SeaweedFS reserves volumes per
  bucket. Reuse the dedicated test bucket across test databases or configure more
  volume capacity; inspect the object-store logs for writable-volume errors.
