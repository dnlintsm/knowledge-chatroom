# Deployment

## Demo stack

`docker compose --profile demo up --build` builds the Node 26 UI from the root
`Dockerfile` (target `app`), the Python API from `services/api-py/Dockerfile`, and
the Python chat agent from `services/agent-py/Dockerfile`. PostgreSQL and SeaweedFS
provide storage. `app` sends chat runs to `agent-py:9300` and everything else to `api`.

The UI (3000), object store (8333, for signed binary downloads), and PostgreSQL
(5432, for local development) are published on the host. Python services stay on the
compose network. The demo runs without login and reads model, memory, embeddings
and `MCP_SERVERS` settings from `.env`. Search models are cached in `api-models`.
For a shared deployment, change the storage credentials, stop publishing 5432,
and configure login as below.

Optional profiles start sample MCP servers next to the demo: `papers`
(`services/papers-mcp`, paper search) and `python-sample` (`services/lab-tools`, from `examples/python-agent`). Add
the profile and the matching `MCP_SERVERS` line from `docker-compose.yml` to `.env`, using
service names such as `http://papers:9200/mcp` rather than localhost.

The `python-agent` profile remains an alias for selecting the Python chat service.

## Production

Use Node 26 LTS for frontend build and runtime. Install pnpm 12.18.0 explicitly
(`npm install --global pnpm@12.18.0`), then run:

```bash
pnpm install --frozen-lockfile --filter @knowledge-chatroom/web... --filter @knowledge-chatroom/contracts
pnpm check:web
pnpm build
```

The standalone output (`apps/web/.next/standalone`, with `apps/web/server.js`
inside it) runs with `node apps/web/server.js`; include `.next/static` and `public`
as the Dockerfile does.

Deploy `api-py` and `agent-py` separately with the locked Python dependencies.
Point the UI's `LOCAL_AGENT_URL` at api-py and `AGENT_URL` at agent-py. Point
agent-py's `LOCAL_AGENT_URL` and MCP servers' `KNOWLEDGE_STORAGE_URL` at api-py.
Leave `TS_AGENT_URL` unset: it only forwards to an older release's TypeScript server. api-py applies
migrations, serves the API directly, and checks its own storage readiness.
PostgreSQL and S3 are required for skills, shared storage and persistent chat history.
`AGENT_URL` unset means agent-py at `http://127.0.0.1:9300`. (`AGENT_URL=local` posts the
chat to `LOCAL_AGENT_URL`, which only the e2e mock agent serves.)

Give api-py the settings for everything it serves (its
[README](../services/api-py/README.md) lists each one): `DATABASE_URL`, the `S3_*`
settings and `MAX_UPLOAD_BYTES` for storage; `EMBEDDING_*`, `SEARCH_MIN_SIMILARITY` and a
writable `EMBEDDING_CACHE_DIR` for search; `HUB_ADMINS` and `SKILL_SCRIPTS` for skills;
`MEMORY`, `MEMORY_LEARN` and `MEMORY_IDLE_MINUTES` for memory; and `ANTHROPIC_API_KEY` (or
`ANTHROPIC_AUTH_TOKEN`), `ANTHROPIC_BASE_URL`, `MEMORY_MODEL`, `SUGGESTIONS_MODEL` and
`CLAUDE_MODEL` for the follow-up chips and memory's small model. Give api-py and agent-py
the same `MCP_SERVERS`: api-py serves the chat's "+" menu from it, agent-py connects to
the servers. The menu's servers must be reachable from both. agent-py also needs the chat
model's settings (`ANTHROPIC_*`, `CLAUDE_MODEL`); see its
[README](../services/agent-py/README.md).

Set `WORKSPACE_CREATORS` on api-py to limit who may create workspaces.
Name people in these lists by login subject (`<issuer>|<subject>`) where you can. An
email matches only when the login provider marked it verified; a provider that verifies
emails but sends no `email_verified` claim needs `OIDC_ASSUME_EMAIL_VERIFIED=true` on the
UI, or its users have no email here at all (the UI logs a line at each such sign-in).
`PLATFORM_ADMINS` names the deployment admins who can inspect the
[workspace inventory](workspaces.md#workspace-inventory) at `/platform` (also from the
workspace switcher) and recover an Owner
when a workspace's Owners can no longer sign in; nobody is one by default.

Expose the UI through HTTPS and keep both Python service ports private. For login,
set `AUTH_MODE=oidc`, OIDC settings, `APP_URL`, and the same `AUTH_SECRET` on the UI
and api-py. Give agent-py and outside MCP servers only api-py's public key from
`GET /identity/public-key` as `KNOWLEDGE_PUBLIC_KEY`, never the signing secret.
For a single-user deployment set `AUTH_MODE=local` on every service.

No service guesses the mode from a missing setting. The UI's production build and api-py
refuse to start with neither `AUTH_MODE` nor `AUTH_SECRET`. agent-py and the MCP servers
refuse to start with neither `AUTH_MODE` nor `KNOWLEDGE_PUBLIC_KEY`; with `AUTH_MODE=oidc`
and no key they start and refuse every call until the key is set. A mismatch is refused
too: api-py without login answers 401 to a request the UI signed for a user, instead of
treating it as the built-in owner, and so do agent-py and the MCP servers. After deploying
with login, check that api-py answers a request without an identity with 401.

The first person to sign in owns the default workspace. Owners see an **Admin** button next
to Share: people who have signed in and when they were last active, workspace roles,
groups and their members, and recent access changes. A removed role applies on the
user's next request; their login session stays valid until it expires.

## HTTPS

The app has no built-in TLS: the UI (3000) and the object store (8333) speak plain
HTTP. Put a reverse proxy such as Caddy or nginx in front with your certificate:

```
knowledge.example.com:443 {
	tls /certs/fullchain.pem /certs/privkey.pem
	reverse_proxy app:3000
}

# Signed downloads: its own port, not a path, because the link signs host and path.
knowledge.example.com:8443 {
	tls /certs/fullchain.pem /certs/privkey.pem
	reverse_proxy s3:8333
}
```

Then set `APP_URL=https://knowledge.example.com` on the UI (session cookies become
Secure, and the OIDC redirect URI is `$APP_URL/api/auth/callback`). For binary files,
pick one:

- **Keep the store private (simpler)**: leave `S3_PUBLIC_URL` unset on api-py and drop
  the second block. Images, PDFs and other binary files then stream through the app after
  the same access check. Each file passes through api-py in one piece (uploads are
  capped by `MAX_UPLOAD_BYTES`, 50 MB by default) and there are no range requests, so
  long videos can't seek.
- **Signed links to the store**: keep the second block and set
  `S3_PUBLIC_URL=https://knowledge.example.com:8443` on api-py. Left at
  `http://localhost:8333`, previews break on an https page as mixed content.
  The store's origin has none of the sandboxing the app puts on files it serves, so api-py
  signs a link to open in place only for pictures (not SVG), PDF, audio and video; any other
  binary file is a download, and text, HTML and SVG are served by the app. A store on its
  own site (another registrable domain) is safer still than another port of the app's host:
  a page there can't send the app's cookies.

`LOCAL_AGENT_URL` (and `AGENT_URL`, if set) stay on the private network and
`AUTH_ALLOW_HTTP` stays unset. Stop publishing 3000 and 8333 directly. With nginx,
add `proxy_buffering off;` for the UI so the `/api/files?watch` event stream isn't
held back; Caddy streams it as is. Set a request-size limit at the proxy that fits
your largest upload (`client_max_body_size` in nginx, `request_body { max_size }` in
Caddy); see [Dependency security](development.md#dependency-security) for why.

## Storage and upgrades

Persist PostgreSQL and the S3 bucket together; files and their versions reference
content hashes in the bucket. Set database/object-store credentials for api-py.
Replace compose's local credentials before using shared infrastructure. Set
`S3_PUBLIC_URL` to the address reachable by browsers when using signed binary
downloads; signed links expire after five minutes. Without it, binary files are served
through the app like text (see [HTTPS](#https)). `MAX_UPLOAD_BYTES` (default 52428800,
50 MB) caps one file. An experiment upload (`POST /experiments/upload`) is held in memory
until it is written, so its files together may be at most four times that, and 2,000 in
number. Other request bodies have fixed limits: 64 KiB for JSON, 32 MiB for a chat run.

Migrations (`services/api-py/migrations`) apply when the Python API server starts
(`MIGRATIONS=off` makes it wait for another process to apply them). Back up database metadata and blob contents
before a migration or service upgrade. The database account needs migration
privileges. `004_row_security.sql` establishes the restricted `knowledge_user`
role when permitted; `005_experiments.sql` extends those policies to experiments.
If startup reports RLS is off, an administrator must create/grant that role as
documented in [Architecture](architecture.md) and restart. Verify its enabled state
for deployments that depend on database-enforced access.

Image digests in compose and CI are intentionally pinned. Update a tag and its
verified multi-platform digest together, rerun the storage tests and storage/
login E2E, and review the migration/runtime impact in a separate PR.

`/health` confirms the HTTP server is alive; it does not prove storage migrations
or bucket access have finished. Verify authenticated storage operations after
startup. CI's live provider smoke test is opt-in; required mock tests establish
application behavior without promising provider availability.

The chat agent keeps a copy of each user's readable files in their run folder
(agent-py's `AGENT_PY_WORKDIR`; default a temp folder) for Claude's Read/Glob/Grep: give that folder disk for up to `AGENT_WORKDIR_MAX_MB`
(default 500) per active user and workspace, or set `AGENT_WORKDIR=off` on it. agent-py fetches
the copy through api-py; binary files api-py serves as store links (`S3_PUBLIC_URL`) come from
that link, so make it reachable from agent-py too, or they are left out. See
[Working folder](architecture.md#working-folder).

Skill scripts are off unless the chat agent has `SKILL_SCRIPTS=on`: agent-py runs them
(`agent_py/scripts.py`), and api-py needs the same setting so the skill pages say they
run. Turning them on needs bubblewrap and socat on agent-py's host (and, in a container,
permission to create user namespaces; the agent-py image and the compose demo have
neither) plus whatever interpreters the skills use, such as Node.js for the built-in
`analysis` skill; a run with scripts fails when the sandbox can't start. Scripts can read the rest of the host's filesystem,
so list any credential files outside the usual secret mounts in
`SKILL_SCRIPTS_DENY_READ`. See [Skill scripts](architecture.md#skill-scripts).
