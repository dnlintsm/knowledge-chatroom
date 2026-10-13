# Deployment

## Demo stack

`docker compose --profile demo up --build` builds the UI and agent images from the
root `Dockerfile` (targets `app` and `agent`) and starts them with PostgreSQL and
SeaweedFS. Only the UI (3000) and the object store (8333, for signed binary
downloads) are published; the agent stays on the compose network. It runs without
login, with the local storage credentials from `deploy/seaweedfs/s3.json`, and reads
`ANTHROPIC_API_KEY` (and optionally `CLAUDE_MODEL`) from `.env`. The search model
downloads into the `models` volume on first start. Treat it as a single-user demo:
for anything shared, change the storage credentials and configure login as below.

## Production

Use Node 22 for build and runtime. Install with `npm ci`, run `npm run check`,
then `npm run build`. The build includes TypeScript checks. `npm start` serves the
production build; the configured standalone output can also be packaged by a
deployment host with its `.next/static` assets. Deploy the agent separately with
its dependencies and the sibling `shared/` directory and run `npm --prefix agent start`.

Configure `AGENT_URL` on Next.js to reach the agent over a private network. Expose
the Next.js UI through HTTPS. Keep the agent HTTP port private: Next.js signs
forwarded identities, and users should not call the agent directly. Login is
optional, but a shared workspace should configure the OIDC values and shared
`AUTH_SECRET` described in [Development](development.md).

Persist PostgreSQL and the S3 bucket together; files and their versions reference
content hashes in the bucket. Set database/object-store credentials for the agent.
Replace compose's local credentials before using shared infrastructure. Set
`S3_PUBLIC_URL` to the address reachable by browsers when using signed binary
downloads; signed links expire after five minutes. Text is served through the app.

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

Skill scripts are off unless the agent has `SKILL_SCRIPTS=on`. Turning them on needs
bubblewrap on the agent host (and, in a container, permission to create user
namespaces) plus whatever interpreters the skills use; a run with scripts fails
when the sandbox can't start. Scripts can read the rest of the host's filesystem,
so list any credential files outside the usual secret mounts in
`SKILL_SCRIPTS_DENY_READ`. See [Skill scripts](architecture.md#skill-scripts).
