# Development

Use Node 22 from `.nvmrc`. Install both locked packages with `npm ci` at the root;
`npm run install:agent` repeats only the agent installation. Use `npm install`
only when intentionally changing dependencies, and include the relevant lockfile.

Copy `.env.example` to `.env`. For real chat set `ANTHROPIC_API_KEY`;
`CLAUDE_MODEL` defaults to `claude-sonnet-5`. `npm run dev` starts the UI on 3000
and the agent on 8000. `npm run dev:ui` and `npm run dev:agent` run them separately.
Check the agent with `curl http://localhost:8000/health`; storage can still be
migrating after this health endpoint answers.

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

`RUN_DIR_MARKERS` is a comma-separated list of marker folders (default
`xdoe-report`) used to discover runs. Choose a run in Traverse to enter Focus.
`RULES_API_URL` configures the server-side rules provider; when unset, the built-in
mock answers. Actions use the user's role where the run lives, and generated
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

The chips under the chat start from what is open (summarize the file, analyze the
run's report, search similar experiments with server storage). After each reply
the agent's `POST /suggest` makes one small-model call for follow-ups:
`SUGGESTIONS_MODEL` (default `claude-haiku-5-5`, or `CLAUDE_MODEL` when that is
not a Claude model). `CHAT_SUGGESTIONS=static` on the UI keeps the first-round chips
and makes no extra calls. See [Chat suggestions](architecture.md#chat-suggestions).

## Skills

Built-in skills live in `agent/skills/`; with server storage, the agent also loads
workspace skills from `skills/<name>/SKILL.md` and skills installed from the hub. Users choose Auto, Manual, or Off, for
themselves or one chat; editors of the workspace root set the default for everyone.
Slash commands run only enabled skills; the status bar shows enabled and used
skills. `SKILLS_RUN_DIR` sets the agent's temporary per-user working directory.
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
  "lab": {"url": "http://localhost:9100/mcp", "forwardIdentity": true,
          "headers": {"Authorization": "Bearer ${LAB_TOKEN}"}},
  "local": {"type": "stdio", "command": "python", "args": ["tools.py"]}
}}
```

`type` is `http` (the default), `sse` or `stdio` (give stdio servers absolute paths: runs with skills start in their own folder). `${VAR}` in `headers` and `env`
reads the agent's environment, so secrets stay out of the file. Every tool of a
configured server runs without asking, as `mcp__<name>__<tool>`; a server that is
down is left out and the chat carries on. With login on, `forwardIdentity` sends
the run's signed user as the `X-Knowledge-User` header (`v1.<payload>.<hmac>`,
valid for an hour; verify it with `AUTH_SECRET` as in
`agent/src/storage/identity.ts` and check its `aud` is `mcp:<name>`). The token is
signed for that server only, and the agent refuses it, so a server can't call the
agent's own APIs as the user. These tools act outside workspace storage and its
permissions: a server that needs workspace files should take them as arguments or
check the forwarded user itself.

[examples/python-agent](../examples/python-agent/README.md) is a complete sample:
a Python agent's prompt moved into a skill and its tools into an MCP server, with
the forwarded user checked and tests. Start there when bringing a Python agent in.

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

## Optional login

Set `AUTH_MODE=oidc` and the same `AUTH_SECRET` (at least 32 characters) for Next.js and the agent.
Generate one with `openssl rand -hex 32`. Configure `OIDC_ISSUER`, `OIDC_CLIENT_ID`
and, for confidential clients, `OIDC_CLIENT_SECRET`. Register
`<APP_URL>/api/auth/callback` with the provider; set `APP_URL` to the external UI URL.
The issuer and `APP_URL` must use https unless they are on localhost; set
`AUTH_ALLOW_HTTP=true` to test with an http provider elsewhere. The first person to
sign in owns the workspace. Without login (`AUTH_MODE=local`, or no `AUTH_SECRET`
in development), one built-in user owns it. The [Deployment guide](deployment.md) covers the private agent boundary.

`CPK_INTELLIGENCE_API_KEY` is optional for live thread history. Its browser gate
is resolved at build time, so rebuild after changing it for a production run.

## Troubleshooting

- Agent connection errors: check port 8000, the health endpoint and the API key.
- Dependency errors: select Node 22, stop dev/test servers, then run `npm ci`.
- Test port in use: stop your existing server or override the E2E ports listed in
  [Testing](testing.md). The runner intentionally refuses to reuse an unknown server.
- S3 writes failing after multiple test buckets: SeaweedFS reserves volumes per
  bucket. Reuse the dedicated test bucket across test databases or configure more
  volume capacity; inspect the object-store logs for writable-volume errors.
