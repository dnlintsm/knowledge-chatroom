# Deployment

## Demo stack

`docker compose --profile demo up --build` builds the UI and agent images from the
root `Dockerfile` (targets `app` and `agent`), and the Python API server from
`services/api-py/Dockerfile` (the `api` service). It starts them with PostgreSQL and
SeaweedFS. The app and the Python services reach the agent's routes through `api`, which
serves the ones moved to Python so far and passes the rest to `agent` (issue #190). The UI (3000), the object store (8333, for signed binary downloads) and
PostgreSQL (5432, for local development) are published on the host. The agent and the API
server stay on the compose network. It runs without login, with the local storage credentials from
`infra/seaweedfs/s3.json`, and reads `ANTHROPIC_API_KEY` and the optional model, memory,
embedding and `MCP_SERVERS` settings from `.env` (the `agent` and `app` services in
`docker-compose.yml` list them). The search model downloads into the `models` volume on
first start. Treat it as a single-user demo: for anything shared, change the storage
credentials, stop publishing 5432 and configure login as below.

Optional profiles start sample MCP servers next to the demo: `papers`
(`services/papers-mcp`, paper search) and `python-sample` (`services/lab-tools`, from `examples/python-agent`). Add
the profile and the matching `MCP_SERVERS` line from `docker-compose.yml` to `.env`, using
service names such as `http://papers:9200/mcp` rather than localhost.

The `python-agent` profile serves the chat from the Python agent (`services/agent-py`)
instead of the agent server's own: add it with `AGENT_URL=http://agent-py:9300`, as in
`AGENT_URL=http://agent-py:9300 docker compose --profile demo --profile python-agent up --build`.
It gets the same model settings and `MCP_SERVERS`, and reaches storage, skills and memory
through the API server.

## Production

Use Node 22 for build and runtime. Install with `pnpm install --frozen-lockfile`, run `pnpm check`,
then `pnpm build`. The build includes TypeScript checks. `pnpm start` serves the
production build of `apps/web`; its standalone output (`apps/web/.next/standalone`, server
`apps/web/server.js` inside it) can also be packaged by a deployment host with
`apps/web/.next/static` and `apps/web/public`, as the Dockerfile does. Deploy the agent
separately with its dependencies and `packages/contracts`
(`pnpm --filter ./apps/agent deploy <dir>`, or `pnpm install --filter "./apps/agent..."`)
and run `pnpm -C apps/agent start`. Both read `.env` from the repository root.

Run the Python API server (`services/api-py`, [README](../services/api-py/README.md)) in
front of the agent, with `TS_AGENT_URL` pointing at the agent and the same `DATABASE_URL`,
`AUTH_MODE` and `AUTH_SECRET`. Point `LOCAL_AGENT_URL` and the MCP servers'
`KNOWLEDGE_STORAGE_URL` at the API server. The agent's routes are moving to it one group
at a time (issue #190). It serves `/access`, `/nodes`, `/files`, `/experiments`, `/proposals`, `/search`, `/chats`, `/skills` and `/hub` itself and passes the rest
through. The agent keeps serving every route too until phase 4, so an install without
the API server keeps working, but new work lands in Python. It serves `/files` too, so
give it the same `S3_*` settings (including `S3_PUBLIC_URL`) and `MAX_UPLOAD_BYTES` as
the agent; it reads and writes the same bucket. It also runs the search indexer, so start
the agent with `SEARCH_INDEXER=off` and give the API server the same `EMBEDDING_*` and
`SEARCH_MIN_SIMILARITY` settings as the agent, and a writable `EMBEDDING_CACHE_DIR` for
the local model. Without `SEARCH_INDEXER=off` both index, which is harmless but wasteful.
It serves the skills API and the skill hub too, so give it the same `HUB_ADMINS` and
`SKILL_SCRIPTS` as the agent.

Configure `LOCAL_AGENT_URL` on Next.js to reach the agent (through the API server) over a private network,
and `AGENT_URL` only when the chat uses a remote backend
([Remote agent backend](remote-agent.md)); the agent then still serves storage and
skills. Expose
the Next.js UI through HTTPS. Keep the agent HTTP port private: Next.js signs
forwarded identities, and users should not call the agent directly. Set `AUTH_MODE`
on both: `oidc` with the OIDC values, `APP_URL` and shared `AUTH_SECRET` described in
[Development](development.md) for a shared workspace, or `local` for a single-user
setup without login. Production builds refuse to start when it is unset and no
`AUTH_SECRET` is given, so a missing secret can't silently turn login off.

The first person to sign in owns the workspace. Owners see an **Admin** button next
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

- **Keep the store private (simpler)**: leave `S3_PUBLIC_URL` unset on the agent and drop
  the second block. Images, PDFs and other binary files then stream through the app after
  the same access check. Each file passes through the agent in one piece (uploads are
  capped by `MAX_UPLOAD_BYTES`, 50 MB by default) and there are no range requests, so
  long videos can't seek.
- **Signed links to the store**: keep the second block and set
  `S3_PUBLIC_URL=https://knowledge.example.com:8443` on the agent. Left at
  `http://localhost:8333`, previews break on an https page as mixed content.

`LOCAL_AGENT_URL` (and `AGENT_URL`, if set) stay on the private network and
`AUTH_ALLOW_HTTP` stays unset. Stop publishing 3000 and 8333 directly. With nginx,
add `proxy_buffering off;` for the UI so the `/api/files?watch` event stream isn't
held back; Caddy streams it as is. Set a request-size limit at the proxy that fits
your largest upload (`client_max_body_size` in nginx, `request_body { max_size }` in
Caddy); see [Dependency security](development.md#dependency-security) for why.

## Storage and upgrades

Persist PostgreSQL and the S3 bucket together; files and their versions reference
content hashes in the bucket. Set database/object-store credentials for the agent.
Replace compose's local credentials before using shared infrastructure. Set
`S3_PUBLIC_URL` to the address reachable by browsers when using signed binary
downloads; signed links expire after five minutes. Without it, binary files are served
through the app like text (see [HTTPS](#https)). `MAX_UPLOAD_BYTES` (default 52428800,
50 MB) caps one upload.

Migrations apply at agent startup. Back up database metadata and blob contents
before a migration or service upgrade. The database account needs migration
privileges. `004_row_security.sql` establishes the restricted `knowledge_user`
role when permitted; `005_experiments.sql` extends those policies to experiments.
If startup reports RLS is off, an administrator must create/grant that role as
documented in [Architecture](architecture.md) and restart. Verify its enabled state
for deployments that depend on database-enforced access.

Image digests in compose and CI are intentionally pinned. Update a tag and its
verified multi-platform digest together, rerun storage integration and storage/
login E2E, and review the migration/runtime impact in a separate PR.

`/health` confirms the HTTP server is alive; it does not prove storage migrations
or bucket access have finished. Verify authenticated storage operations after
startup. CI's live provider smoke test is opt-in; required mock tests establish
application behavior without promising provider availability.

With storage, the agent keeps a copy of each user's readable files in their run folder
(`SKILLS_RUN_DIR`, default a temp folder) for Claude's Read/Glob/Grep: give that folder disk
for up to `AGENT_WORKDIR_MAX_MB` (default 500) per active user, or set `AGENT_WORKDIR=off`. See
[Working folder](architecture.md#working-folder).

Skill scripts are off unless the agent has `SKILL_SCRIPTS=on`. Turning them on needs
bubblewrap on the agent host (and, in a container, permission to create user
namespaces) plus whatever interpreters the skills use; a run with scripts fails
when the sandbox can't start. Scripts can read the rest of the host's filesystem,
so list any credential files outside the usual secret mounts in
`SKILL_SCRIPTS_DENY_READ`. See [Skill scripts](architecture.md#skill-scripts).
