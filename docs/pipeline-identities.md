# Pipeline identities (design)

Status: **proposed**, tracked in
[#267](https://github.com/dnlintsm/knowledge-chatroom/issues/267) (batch D), the open
"agent and pipeline credentials" criterion of
[#178](https://github.com/dnlintsm/knowledge-chatroom/issues/178).

Today everything that reaches the workspace comes from a person's login session:

- a signed-in browser;
- Claude in that person's chat, through a storage token the app mints for the run;
- an outside MCP server, through tokens traded from that run's.

A program that runs on its own, such as a nightly import from an instrument, a CI job that
uploads results, or a scheduled analysis, has no session to borrow. Today it has to borrow a
person's: copy a cookie or a token. It then breaks when that expires, can't be told apart
from the person in the record, and can't be revoked without signing the person out.

This batch adds **pipelines**: named, revocable identities for that work. It also records,
on every execution, who started it, what it ran as, and what authorized it.

## What exists today

| | Today | Gap |
| --- | --- | --- |
| Credentials | Identity tokens (5 min) and storage tokens (`STORAGE_TOKEN_SECONDS`, an hour), signed with a key derived from `AUTH_SECRET`, minted only for a signed-in request or a chat run. | Nothing a background program can hold, and no token is revoked before it expires (signed tokens are checked, not looked up). |
| Scope | A storage token is bound to its workspace (`ws`) and acts as Claude for its user: proposals in Knowledge, no deleting, sharing or managing access (`agent_refusal`). | No narrower scope: a token reaches everything its user can. |
| Revocation | Membership and grants are read again on every request and every tool call (docs/workspaces.md, Revalidation). agent-py stops a run at its next tool boundary once the user isn't a member (`agent_py/revocation.py`). | There is nothing to revoke but the person's access. |
| Record | A Run has `startedBy` (a person) and `provenance` (chat, model, skill, tools). The audit log has `actor_type` user or agent, `actor_id` and `via`. | A Run doesn't say what it ran as or what authorized it, and the audit log can't name a pipeline. |

## Decisions

1. **A pipeline acts for its owner, narrowed.** Every pipeline has an **owner**, a member of
   the workspace. A pipeline request is checked as its owner's, against the owner's current
   access, then narrowed by the pipeline's **places** and **operations**. A pipeline never
   reaches anything its owner can't, so the rule "automation never has more rights than a
   person" holds, and every existing access check (`Session.need`, row security,
   `effective_role`) applies unchanged. The other option, a pipeline with grants of its own,
   is listed under open points.
2. **It is its own identity in the record.** A pipeline request is not the owner's own:
   - Writes in a Knowledge node are proposals, as Claude's are, and the activity log and
     Runs credit them to the pipeline, for its owner.
   - The audit log gets `actor_type` `pipeline`, the owner as `actor_id`, and the pipeline's
     and key's ids in the target.
   - Like Claude, a pipeline can't manage access, accept or reject proposals, share, archive,
     hand over, delete or restore. It also can't reach chats, memory or skills.
3. **Places and operations are chosen when it is made.**
   - **Places**: the whole workspace, or a list of nodes and Experiments. A node includes its
     subtree; an Experiment includes its Runs. Anything outside them answers 404, as for a
     node you can't see. The workspace root is not among a list's places: its files answer
     403 ("This pipeline reaches only its places, not the workspace root").
   - **Operations**, each one ticked on its own:

     | Operation | Allows |
     | --- | --- |
     | `read` | Reading files, nodes, Experiments, Runs and search in its places |
     | `write` | Writing files in Experiments, and at the root for a whole-workspace pipeline; proposals in Knowledge nodes |
     | `runs` | Creating Experiments, and starting, finishing and labelling Runs |
     | `upload` | `POST /experiments/upload`, which may add nodes (it needs Can edit where they go, as for its owner) |

     A request for an operation the pipeline doesn't have answers 403 and names the missing
     operation ("This pipeline can't start runs: it doesn't have the runs operation").
   - **Every Run input is checked at its source.** Starting a Run (or adding inputs to one,
     or rerunning) can copy files from another node or Experiment into `inputs/`. That
     needs `runs` at the destination and, for each input, `read` and a source inside the
     pipeline's places, whatever its owner can read. A source outside its places answers
     404; a pipeline without `read` gets 403. Both are checked before the Run is created or
     any input is copied, so a refused request leaves nothing behind.
4. **Keys are secrets that are looked up, not signed tokens.** A pipeline holds one or more
   **keys**, `kcp_` followed by 32 random bytes in base64url. The server keeps only each
   key's SHA-256, a 4-character hint, who made it and when, when it expires, and when it was
   last used.
   - A key is shown once, when it is made.
   - Because every request looks its key up, revoking takes effect at the next request, with
     no expiry to wait out.
   - A key expires after 90 days by default, and after 365 days at the most
     (`PIPELINE_KEY_MAX_DAYS`). A pipeline can hold two keys at once, so one can be replaced
     before the old one is revoked.
5. **Keys go to the web app, like everything else.** The web app is still the only public
   process. A pipeline calls `/api/...` with `Authorization: Bearer kcp_...` and no session.
   The proxy (`apps/web/src/lib/agent-proxy.ts`) forwards the key to api-py as
   `X-Knowledge-Pipeline`, and api-py checks it. A request that carries both a key and a
   session is refused (400), so it is always clear who is acting.
   A browser never adds an `Authorization` header by itself, so a key can't be used through
   cross-site requests the way a cookie could.
   Only the storage routes take a key (`/files`, `/nodes`, `/experiments`, `/runs`,
   `/search`, `/proposals`). `/api/chat`, `/api/copilotkit`, `/api/memory`, `/api/skills`,
   `/api/access`, `/api/workspaces` and `/api/platform` refuse it.
   - **No watches.** A change stream (`GET /files?watch`) keeps delivering without another
     request, so a key revoked while it is open would keep reading. A pipeline's
     `?watch` answers 403 ("A pipeline can't watch for changes: list the files again
     instead"); it lists again when it needs to.
6. **Who makes and revokes them.**
   - Any Member can make a pipeline that they own, in a workspace they belong to.
   - The owner can change its name, places and operations, add and revoke keys, and revoke
     the pipeline.
   - Owners and Admins see every pipeline in the workspace: its name, owner, places,
     operations, keys and their hints, and when each was last used, never a key itself. They
     can revoke any pipeline or key, and hand a pipeline over to another member (audited as
     `pipeline.handover`, with how many keys it revoked). After a handover it acts for the
     new owner, with the new owner's access.
   - **A handover revokes every key the pipeline has**, in the same transaction as the
     ownership change. A key the former owner kept would otherwise act with the new owner's
     rights, their drafts included. After a handover each old key answers 401
     (`key-revoked`), and the new owner adds a key of their own.
   - Claude can't make, see or revoke pipelines: storage tokens are refused at `/pipelines`.
7. **A revoked pipeline is kept, not deleted.** Its record stays, so Runs and audit entries
   that name it still resolve to its name. Revoking it revokes all its keys. It can't be
   turned back on: make a new one.
8. **What stops a pipeline.** Any of these refuses its next request with 401, a message, and
   a `reason`:
   - the key is invalid (`invalid`), revoked (`key-revoked`) or expired (`key-expired`);
   - the pipeline is revoked (`pipeline-revoked`);
   - **its owner left or was removed** (`owner-left`). It is listed as **Suspended: its owner
     is no longer a member** until an Owner or Admin hands it over, which resumes it with the
     new owner's key;
   - **the workspace is archived** (`workspace-archived`). This blocks every owner at once,
     so a handover can't fix it: while the workspace is archived nothing resumes the
     pipeline (its routes answer 404, as the workspace's other routes do, and a handover
     that got through would answer 409). Restoring the workspace resumes it with the same
     keys, unless its owner has left too. Archival is checked first, so an archived
     workspace always reads as `workspace-archived`.

   Losing a grant is not a revocation. It narrows the pipeline as it narrows its owner, and
   requests there answer 404 or 403 as they would for the owner.
9. **Revoking stops new requests, not one already accepted.** A request is *accepted* once
   api-py has checked its key and access and started to act on it. Revoking while it runs
   doesn't stop it: it ends as it would have, and its result, its audit entry and any Run it
   wrote are kept, naming the key it ran with. The next request, including one the pipeline
   had queued behind it, gets 401. Cancelling a call can't undo what it already did, so the
   record keeps what happened rather than pretending it didn't. The same holds in chats: a
   tool call agent-py has dispatched runs to its end, and the next one is refused
   (`agent_py/revocation.py`, already built).
10. **A Run started by a pipeline that is then revoked** stays running. The revoked key can't
    finish it. Its owner, or the Experiment's maintainer, can finish it from the Run view,
    which says "Its pipeline was revoked while it ran". Its record keeps what the pipeline
    wrote up to then.
11. **Every execution records who, as what, and why.** A Run gets a server-written
    `execution` in its provenance, set when it starts and kept at finish:

    | Field | Browser | Claude in a chat | A pipeline |
    | --- | --- | --- | --- |
    | `initiatedBy` | The signed-in user | The user chatting | The pipeline's owner when the Run started |
    | `ranAs` | `{kind: "user"}` | `{kind: "agent", via}` (`remote`, or `mcp:<name>`) | `{kind: "pipeline", id, name, key}`, the key's id and hint |
    | `authorizedBy` | `{kind: "session"}` | `{kind: "storage-token", via}` | `{kind: "pipeline-key", key, places, operations}`, as they were at the start |

    `execution` is the server's, like `startedBy`, and a client's copy is dropped. A Run from
    before this batch has none, and the Run view says "Not recorded" rather than guessing.
    Finishing a Run records who finished it in `execution.finishedBy`, as
    `{user, ranAs, authorizedBy}` with `user` in `initiatedBy`'s shape, since another key or
    a person may finish it.

## Data changes

- `pipelines`: `id`, `workspace_id`, `name`, `owner_id`, `created_by`, `places` (jsonb: null
  for the whole workspace, or `[{node}|{experiment}]`), `operations` (text[]), `created_at`,
  `revoked_at` and `revoked_by`.
- `pipeline_keys`: `id`, `pipeline_id`, `workspace_id`, `sha256` (unique), `hint`,
  `created_by`, `created_at`, `expires_at`, `last_used_at`, `revoked_at` and `revoked_by`.
  `last_used_at` is written at most once a minute per key, so reads don't each become a
  write.
- No row security on either table: like workspace membership they are administration, not
  content. The routes read and write them with the app's own connection and check who may
  (a pipeline and its keys are visible to its owner and to the workspace's Owners and
  Admins).
- `audit_log.actor_type` allows `pipeline`.
- Run provenance gains the server's `execution` key (decision 11). No column changes for
  Runs.
- Audit actions: `pipeline.create`, `pipeline.update`, `pipeline.handover`,
  `pipeline.revoke`, `pipeline.key.create` and `pipeline.key.revoke`.

## API

| Route | Who | Does |
| --- | --- | --- |
| `GET /pipelines` | Members (their own); Owners and Admins (all, with `?all`) | Pipelines with places, operations, status and keys (hint, created, expires, last used) |
| `POST /pipelines` `{name, places, operations, expiresInDays?}` | Members | Makes one, with its first key. The answer is the only time the key is shown |
| `PATCH /pipelines/{id}` `{name?, places?, operations?}` | Its owner | Changes it; takes effect at its next request |
| `POST /pipelines/{id}/owner` `{userId}` | Owners and Admins | Hands it over to a member and revokes all its keys, in one transaction (409 while the workspace is archived) |
| `POST /pipelines/{id}/keys` `{expiresInDays?}` | Its owner | Adds a key, at most two live at once (409 for a third) |
| `DELETE /pipelines/{id}/keys/{keyId}` | Its owner, Owners and Admins | Revokes a key |
| `DELETE /pipelines/{id}` | Its owner, Owners and Admins | Revokes the pipeline and all its keys |

Pipeline requests to the storage routes carry `X-Knowledge-Pipeline` from the web app.
`Principal` gains `actor` `pipeline`, the pipeline's id and key id, and its places and
operations. `agent_refusal` applies to them, together with a per-operation check. The
contract adds the routes, `Pipeline`, `PipelineKey`, `RunExecution` and the 401 reasons, in
`storage.yaml`, the conformance suite and both generated models.

## Screens

- **Pipelines**, in the workspace menu beside Workspace settings (every Member makes
  pipelines, and Workspace settings is for Owners and Admins):
  - A list with name, owner, places, operations, its keys' hints and when each was last
    used, and its status (Active, Suspended or Revoked).
  - **New pipeline**: name, places (the whole workspace, or nodes and Experiments from a
    picker), the operations as checkboxes with one line each on what they allow, and the
    key's lifetime. Then the key, once, with Copy and "You won't see this key again".
  - **Revoke** asks first and says what happens: "Requests with this key stop at once. A
    request already running ends as it would have, and its result is kept."
  - Owners and Admins see every pipeline, with **Hand over** on each one. Its dialog says
    "Its keys stop working now. The new owner adds a key for the pipeline to use."
- **Run view, Provenance**: a "Ran as" row ("Pipeline *Nightly etch import*, key …a1b2,
  for Alice", "Claude, in Alice's chat", or "Alice") and an "Authorized by" row ("Alice's
  access, narrowed to Etch: read, runs"). Runs from before this batch show "Not recorded".
- **Activity and audit log**: a pipeline's entries show its name and its owner.
- Claude's wording: `list_experiments` gives each experiment's `ranAs` (what its latest
  Run ran as, from `execution`), and Claude says what it ran as and claims no more.

## Settings

| Setting | Default | Does |
| --- | --- | --- |
| `PIPELINES` | `off` | `on` lets Members make pipelines and lets keys reach the storage routes. Off, `/pipelines` answers 404 and keys are refused. |
| `PIPELINE_KEY_MAX_DAYS` | `365` | The longest a key may last. |

Both get rows in `docs/settings.md` and entries in `.env.example`.

## Tests this batch asks for

- A pipeline reads and writes only in its places, and only its operations. Anything else
  answers 404 (outside its places) or 403 (naming the operation). Its writes in a Knowledge
  node need `?propose`, as Claude's do.
- It never reaches past its owner: lowering the owner's grant narrows the pipeline at its
  next request.
- A revoked key, a revoked pipeline, an expired key, an owner who left, and an archived
  workspace each answer 401 with their `reason`.
- **A handover revokes every key.** A pipeline with two live keys is handed over: both
  answer 401 (`key-revoked`) at once, the former owner can't add a key, and the new owner's
  new key works, with the new owner's access.
- **An archived workspace.** A pipeline's key answers 401 (`workspace-archived`) while its
  workspace is archived, and the pipeline can't be handed over meanwhile. Restoring the
  workspace resumes it with the same key, with no handover. Tested apart from the owner
  who left, which a handover resumes.
- **No watches.** A pipeline's `GET /files?watch` answers 403, with or without a node.
- **Run inputs at their source.** An owner who reads a node outside the pipeline's places:
  a Run with an input from there (a node or an Experiment) answers 404, and so does
  creating an Experiment with a first Run and that input; no Experiment, Run or input is
  made. A pipeline without `read` gets 403 for an input even inside its places, and nothing
  is made. An input inside its places, with `read`, is copied.
- **One accepted call and one queued call.** A pipeline starts an upload that is held
  inside the object-store write, and has a second request ready behind it. The key is
  revoked. The upload ends with 201, and its Experiment, Run and audit entry name the key.
  The queued request gets 401, and nothing of it is written.
- The same in agent-py: two tool calls in one model turn, with the user removed after the
  first is dispatched. The first's result stays in the transcript, the second is refused,
  and no further model turn starts.
- `execution` on Runs started by a browser, by Claude and by a pipeline. A client's
  `execution` is dropped. A Run from before the migration shows none.
- A pipeline Run left running after revocation is finished by its owner from the API, and
  `finishedBy` names them.
- Keys: only the SHA-256 is stored; a key is shown once; at most two live keys; a request
  with both a key and a session gets 400; chat, memory, skills and access routes refuse
  keys.
- Who sees what: a Member sees only their own pipelines, Owners and Admins see all of them
  and never a key, and Claude's storage token gets 403 at `/pipelines`.
- E2E: make a pipeline, use its key from a script to start and finish a Run, see "Ran as" in
  the Run view, revoke it, and see the next call refused.

## Rollout (#267, batch D)

1. This spec (docs only).
2. Backend: the tables, `/pipelines`, key checks in api-py and the web proxy, per-operation
   checks, `execution` on Runs, the audit actor, the contract, the accepted and queued test,
   and the agent-py test.
3. Screens: Pipelines in workspace settings, "Ran as" in the Run view, and pipelines in the
   audit log.

`SECURITY.md` gains a line for pipelines under "Claude and outside tools" in step 2, and
`docs/workspaces.md`'s operation matrix gains the pipeline rows.

## Open points for review

- **Whose rights a pipeline has.** This spec says its owner's, narrowed. The other option is a
  pipeline with grants of its own, given like a person's. It would keep working when its
  creator leaves, but every access check, row security and Who has access would learn a new
  kind of principal, and automation could reach what no person in the workspace can.
- **Who may make one.** This spec says any Member, for themselves. It could be Owners and
  Admins only.
- **`upload` as an operation.** It adds nodes, which storage tokens may not do today. It is
  opt-in here. It could be left out of this batch.
- **`PIPELINES` off by default.** This spec keeps it off until the screens ship, since it
  opens a new way in, then turns it on in the release after.
- **Key lifetime.** 90 days by default, at most 365.
