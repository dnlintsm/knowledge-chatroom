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

## Optional login

Set the same `AUTH_SECRET` (at least 32 characters) for Next.js and the agent.
Generate one with `openssl rand -hex 32`. Configure `OIDC_ISSUER`, `OIDC_CLIENT_ID`
and, for confidential clients, `OIDC_CLIENT_SECRET`. Register
`<APP_URL>/api/auth/callback` with the provider; set `APP_URL` to the external UI URL.
The first person to sign in owns the workspace. Without login, one built-in user
owns it. The [Deployment guide](deployment.md) covers the private agent boundary.

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
