# Notes for coding agents

Read this before changing code here. [CONTRIBUTING.md](CONTRIBUTING.md) has the commands
and the project map; [Architecture](docs/architecture.md) explains how the parts work.

## What this is

A multi-tenant workspace where people and Claude work on files together.

- `apps/web`: the Next.js UI. It is the only public process. It checks the login session
  and forwards to the Python services, signing who each request is for.
- `services/api-py`: storage, access, skills, memory, search. Private port.
- `services/agent-py`: the chat agent (Claude Agent SDK over AG-UI). Private port.
- `packages/contracts`: the API's OpenAPI spec, generated types, and the conformance suite.
- `packages/knowledge-py`: clients the Python services share.

## Rules that must keep holding

**Access**

- Files, nodes, experiments, proposals and search go through `Session`
  (`api_py/session.py`): access is checked and audited there. Do not query them around it.
  Every other route first finds who is asking (`identify`) and which workspace they are in
  (`workspaces.resolve`), and runs its queries as that user (`session.scoped`).
- A node someone cannot see is reported as not found, never as forbidden.
- No service infers "no login" from a missing setting. Login state comes from `AUTH_MODE`,
  and a missing secret or key refuses requests.
- Claude acts with the rights of the person chatting. In a knowledge node its writes are
  proposals. It never accepts proposals, manages access, or deletes files. New tools keep
  to this (`api_py/storage_routes.py`, the storage-token rules).
- Chats and personal memory belong to one user. Workspace Owners do not read them.
- Text Claude reads (files, search results, tool output) is untrusted. Once a chat has read
  outside content, memory changes go to the inbox (`api_py/chats.py`,
  `read_outside_content`). A new tool that brings content in must count as outside content.

**Storage**

- A write names what it replaces. Editor saves send `If-Match`; a proposal accept sends what
  its reviewer saw. Do not add a write path that overwrites blindly.
- Bytes go to the object store before the database row, and outside the transaction. Do not
  hold a database connection across an object-store or model call: the pool has ten.
- Files served from storage are untrusted content. Keep the sandbox headers, and do not
  serve a new type inline without checking `api_py/paths.py` (`shown_inline`).

**Web app**

- Keep `useWorkspace()` and `useWorkbench()` stable for their consumers.
- A place is the root, a node, or an experiment (`x:<id>`). Never key a pending save by
  file path alone. Leaving a place flushes its saves, and a late response must not
  overwrite another place's files.
- Unsaved edits and saves in flight win over incoming change events.
- Use `apiFetch` for API calls from the workspace, so an expired session goes to sign in.

**Contract**

- `packages/contracts/openapi/storage.yaml` is the source of truth. A route, status code or
  field that changes is changed there, in the conformance suite, and in both generated
  models, in the same pull request.
- The web app's types for API answers (`server-files.ts` and the panels) are the generated
  ones (`components["schemas"][...]`). Use the generated type for a new answer instead of
  writing an interface beside it, and pick it by the route that sends it, not by its name:
  `/access/users` answers `UserSummary`, not `Person`.

## Before you say a change is done

Run what covers it, and report what you ran and what you did not.

```bash
pnpm check:web
```

```bash
uv run --locked --no-sync ruff check packages/knowledge-py services examples/python-agent
```

```bash
uv run --locked --no-sync pyrefly check --error-stale-baseline
```

```bash
uv run pytest -q
```

api-py's storage tests skip without `TEST_DATABASE_URL` and `S3_ENDPOINT`. A change to
storage, access, memory or skills is not checked until they have run with both set, along
with `pnpm test:conformance` ([Testing](docs/testing.md)).

## Conventions

- Comments say what the code does and why, not how it got here. No issue numbers or "step
  N of the port" as the explanation.
- A bug fix comes with the test that failed before it.
- A new setting gets a row in `docs/settings.md` (a check compares that page with the
  code), and an entry in `.env.example` when people are meant to set it. A removed or
  renamed one gets a row in `scripts/env-upgrade-plan.mjs`.
- Never skip, disable or loosen a test to get a green run. If a test is wrong, say why and
  fix the test.
- Do not put secrets, real names or email addresses in code, tests, fixtures or commits.
  Tests use `alice@example.com` and `bob@example.com`.
- [SECURITY.md](SECURITY.md) says what each role and process is trusted with. A change
  that moves one of those lines updates that file.
