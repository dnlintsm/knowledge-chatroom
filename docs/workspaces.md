# Workspaces (design)

Status: **being built**, tracked in [#226](https://github.com/dnlintsm/knowledge-chatroom/issues/226), for the milestone in
[#178](https://github.com/dnlintsm/knowledge-chatroom/issues/178#issuecomment-6817847479).
The backend in api-py is in (rollout step 4, below): memberships, the backfill and
bootstrap, workspace creation, adding members, and the per-request workspace. The chat run
on the TypeScript server still uses the default workspace (step 4b), and the app has no
workspace screens yet (steps 5 and 6).

This is the short spec and operation matrix that the milestone asks for before
implementation. It covers creating, joining and switching workspaces, and the isolation that
has to be in place first. Removing members, changing roles, Experiment handover, restricted
Knowledge nodes, Guest membership and the Experiment/Run split come later.

## Terms

| Term | Meaning |
| --- | --- |
| Workspace | The boundary for collaboration and authorization. Every node, file, Experiment, chat, memory note, grant, group and audit entry belongs to exactly one. It has an immutable id (UUID) and a unique slug that can change. |
| Membership | Whether a user belongs to a workspace, and as what: **Owner**, **Admin** or **Member**. A non-member gets nothing in that workspace. |
| Content access | What a member can do with Knowledge, through the grants that exist today. The UI calls the three grant roles **Can view** (`viewer`), **Can edit** (`editor`) and **Full access** (`owner`). |
| Experiment visibility | A draft Experiment is visible only to its author. Shared and archived Experiments are visible to whoever can view their node. This rule exists today (`005_experiments.sql`) and doesn't change. |

Every protected operation needs current membership, and then the content access or
Experiment visibility it needs. A Member with no grants can open the workspace and use their
own chats and memory, but sees no shared content.

Membership and content access are **not** independent. Owners and Admins manage groups and
starting grants, which are the inputs to content access (see [Admin trust model](#admin-trust-model)).

## Decisions

Confirmed on 2026-11-13, refined after the review on #227.

1. **Being a Member gives no content access by itself.** Adding someone can also set a
   starting grant on the root (none, Can view or Can edit; Can view is preselected). Every
   access a person has is a grant that can be seen.
2. **Migration preserves effective access**, content and administrative, as listed under
   [Backfill](#backfill).
3. **Local mode (no login):** the local user can create more workspaces and owns all of
   them, as it owns the default workspace today.
4. **Creating a workspace:** any signed-in user can, unless a deployment setting restricts
   it. The default is open. The creator becomes Owner with Full access on the root, in the
   same transaction that creates the workspace.
5. **Old links, tokens and saved state keep working** while no workspace is named:
   - URLs without a workspace redirect to the default workspace.
   - Requests that name no workspace count as the default workspace until a release named
     in the CHANGELOG, and are refused after that.
   - A token without a `ws` claim is **bound to the default workspace** for that period. A
     header or query parameter can't point it anywhere else (see
     [Legacy tokens](#legacy-tokens)). After the cut-off, such tokens are refused.
   - Saved browser state moves into the default workspace once.
   - Every signed-in user is a Member of the default workspace (which gives no content
     access), as everyone could open it before memberships existed, so the app keeps
     working until people can be added from the UI. New workspaces never work this way.

   A workspace that is named but unknown, invalid or not yours is refused. It never falls
   back to the default workspace.
6. **The skill hub and memory-pack hub stay global.** Installs and settings are already per
   workspace.
7. **This doesn't wait for phase 4 of #169.** Workspace resolution goes into api-py, which
   fronts every storage route. The TypeScript chat path and its in-process tools take the
   workspace from the run and apply the same checks.
8. **Admin is a high-trust role** (below).
9. **Home** is the current workspace's home. The switcher, with every workspace and
   Create, is always on screen at the breadcrumb root, including for users with one
   workspace.

## Admin trust model

Admin is a **high-trust administrative role, not a privacy boundary**. An Admin can manage
groups and their members, so an Admin can reach any shared content indirectly, for example by
joining a group that has Full access on the root. The spec doesn't try to prevent that. It
makes it visible instead:

- Every change to groups, group members, grants and memberships is in the audit log, with
  who made it.
- The admin panel shows each grant's source (direct, a group, or an ancestor), so an Admin
  joining a powerful group shows up where people look.

What an Admin still **cannot** reach through administration:

- Other users' draft Experiments. Drafts are visible only to their author, whatever the
  grants are.
- Other users' chats and memory notes, which belong to the user and not to grants.
- Owner-only actions: making someone Owner, transferring ownership, archiving or deleting the
  workspace.

Delegation for starting grants: when adding a member, an Owner or Admin may set none, Can view
or Can edit on the root. Full access is given only through Share, by someone who has Full
access on that node. The membership and the starting grant are written in one transaction,
with one audit entry each.

Once restricted Knowledge nodes exist (later), this model has to be revisited, because group
administration would then cross a boundary that is meant to hold.

## Operation matrix

✓ allowed · ✗ not allowed · *next* means it ships in the next batch, not this milestone.

### Workspace and people

| Operation | Owner | Admin | Member | Non-member |
| --- | --- | --- | --- | --- |
| See the workspace in the switcher and open it | ✓ | ✓ | ✓ | ✗ |
| See the workspace's member list (names) | ✓ | ✓ | ✓ | ✗ |
| See members' emails, sign-up and last-active times | ✓ | ✓ | ✗ | ✗ |
| Rename it, change settings | ✓ | ✓ | ✗ | ✗ |
| Add an existing user as Member or Admin, with a starting grant | ✓ | ✓ | ✗ | ✗ |
| Make someone Owner, transfer ownership | ✓ *next* | ✗ | ✗ | ✗ |
| Remove a member, change a role | ✓ *next* | Members only, *next* | ✗ | ✗ |
| Leave the workspace | ✓ unless last Owner, *next* | ✓ *next* | ✓ *next* | n/a |
| Archive or delete the workspace | ✓ *next* | ✗ | ✗ | ✗ |
| Groups: create, rename, delete, set members | ✓ | ✓ | ✗ | ✗ |
| Read the audit log (redacted, below) | ✓ | ✓ | ✗ | ✗ |
| Create a new workspace | Any signed-in user, unless restricted (decision 4) | | | |

Today the people, group and audit operations need a root `owner` grant
(`services/api-py/api_py/session.py`, the `need(None, "owner")` calls). They move to Owner or
Admin membership. Everyone who passes today's check keeps passing (see Backfill).

### Content (needs membership too)

| Operation | Needs | Today |
| --- | --- | --- |
| Read Knowledge, files, search results | Can view on the node | Same |
| Read an Experiment and its files | Can view on its node, and the Experiment visible to you (a draft only to its author) | Same |
| Create or rename a node; write, rename or delete a shared file | Can edit on the node (the parent, for a new node) | Same |
| Create your own Experiment; start a run | Can view on the node | Same (`create_experiment`, `start_run` need viewer) |
| Propose a change to a file | Can view on the node | Same (`propose` needs viewer) |
| Accept or reject a proposal | Can edit on the node | Same (`canDecide`) |
| Delete a node | Full access on the node | Same |
| Share: add, change or remove grants on a node | Full access on the node (the root, for workspace-wide grants) | Same |
| Edit an Experiment's content, change its visibility, archive or restore it | Its author | Same; a transferable maintainer comes *next* |
| Rerun an Experiment as your own | The source Experiment visible to you, and Can view on the node where the new run goes | Same (since #188) |
| Your own chats and memory | Membership only | Same, minus the membership check |

The membership layer adds a check in front of these. It must not remove any of today's
Viewer workflows (own Experiments, runs, proposals), and it must not make anyone's draft
visible to others.

### Agents and tokens

The agent's effective access is the user's current access in the run's workspace, narrowed
by the token. Agent tokens can't manage members, as they can't manage grants today.

## Revalidation

A token says **who** is acting and **in which workspace**. It is not a snapshot of their
grants.

- **Each request and each tool dispatch** checks current membership, then content access,
  from the database, on both api-py and the TypeScript paths. This is how content checks
  already work (`Session.need` reads `effective_role` on every call), and membership joins it.
  So removing a grant or a group member takes effect on the next request or tool call.
- **An agent run** keeps working only through new checks. Once the user loses access, no new
  protected tool call is authorized, even with an unexpired token.
- **A call already accepted** runs to its end. Its result and its audit entry are kept as
  evidence. Cancelling a run can't undo what an outside service has already done.
- **Open change streams** (`?watch`) check each event against the user's access at the
  moment it is sent:
  - Membership first. When it's gone, the stream closes.
  - Then the content and Experiment-visibility check that already runs per event today
    (`Session.can_see` in api-py: node visibility, Experiment visibility, proposal access,
    and the role on the event's node). It stays, scoped to the stream's workspace.
  - So a Member who loses a grant or a group keeps the stream, but stops getting that
    subtree's events, paths and Experiment details, while events they can still see keep
    coming. A draft's events still go only to its author.
- **Signed download links** stay valid until they expire (`DOWNLOAD_LINK_SECONDS`, 300 s
  today). Revoking access doesn't recall a link already handed out.

Cancelling running work on revocation, and the UI for it, come with the next batch.

## Audit log visibility

Audit targets carry content metadata today: file paths, node names and Experiment titles.
Owners and Admins read the log, so it follows the reader's access:

- Each entry shows who did what, and when.
- A target's name, path or title shows only if the reader can see that target now. Otherwise
  the entry shows its id and "(no access)". This hides private draft titles and anything the
  reader isn't granted.
- There is no exceptional access or takeover in this milestone. Seeing redacted names needs a
  grant, and the grant is audited.

## How a request finds its workspace

Page URLs carry the slug. API requests and tokens carry the immutable workspace **id**.

| Where | Carries | How |
| --- | --- | --- |
| Page URL | Slug | `/w/<slug>/…`. On load, the app resolves the slug to an id once, and redirects if the slug was renamed. |
| Browser `fetch` to `/api/…` | Id | An `X-Knowledge-Workspace: <id>` header, added by one shared request helper from the id the page resolved. The proxy forwards it unchanged. |
| `EventSource` and plain links (downloads, images) | Id | A `?workspace=<id>` query parameter, since these can't set headers. |
| Storage and memory tokens | Id | A `ws` claim, set when the token is minted, from the request or run that minted it. |

Rules on the server:

1. Every selector present (header, query parameter, `ws` claim) must name the **same** id.
   If they differ, the request is refused with 400.
2. An id that doesn't exist, isn't a UUID, or names a workspace the user isn't a member of
   gets 404, the same answer for all three, so it doesn't reveal which workspaces exist.
3. Only when **no** selector is present does the legacy default apply (decision 5). A token
   without a `ws` claim counts as a selector for the default workspace (next section).
4. Every node, Experiment, file, grant, group, proposal and chat id in the request must
   belong to that workspace, or the answer is 404.
5. A header or parameter is never proof of access. Membership is checked every time.

### Legacy tokens

A storage or memory token minted before this change has no `ws` claim. During the
compatibility period its workspace **is** the default workspace, as if it carried
`ws: <default id>`, and the normal rules apply to it:

| Legacy token with | Result |
| --- | --- |
| No header or query parameter | Default workspace, with current membership and access checked |
| A selector naming the default workspace | Default workspace, the same |
| A selector naming any other workspace | Refused (400), even if the user belongs to both workspaces |
| Anything, after the cut-off release | Refused (401) |

A header or query parameter only chooses the workspace for a request that has no
workspace-bound token, such as a signed-in browser request, and then membership in the chosen
workspace is checked. It never gives an existing token a new scope.

### Runs

**Runs capture their workspace when they start.** A chat run takes the workspace id from the
request that starts it, and every token minted for that run (including renewals) carries
that id. Tool calls use the run's workspace, never whichever workspace a tab happens to have
selected now. So two tabs on two workspaces, or a switch while a run is going, can't move
work between workspaces.

### Contract changes

The endpoint paths stay as they are. The OpenAPI contract
(`packages/contracts/openapi/storage.yaml`) gains the header, the query parameter, the 400 and
404 answers, the `ws` claim and the new workspace operations (create, list, read, add member,
look up a user). The proxy, the conformance suite and the tests change with it.

The workspace routes, in the spec and served by api-py (`services/api-py/api_py/workspaces.py`):

| Route | Answer |
| --- | --- |
| `GET /workspaces` | `{workspaces: [{id, slug, name, role}]}`, only the caller's |
| `POST /workspaces` `{name, levels?}` | 201, the new workspace with `role: "owner"`; levels default to tech, module, loop, process |
| `GET /workspaces/{id}` | One of yours, with your role |
| `GET /workspaces/{id}/members` | `{members: [{id, name, role, email?}]}`, email for Owners and Admins only |
| `GET /workspaces/{id}/lookup?email=` | `{user: {id, name}}`, or 404; Owners and Admins only |
| `POST /workspaces/{id}/members` `{userId, role, access?}` | 201, or 409 with the current `role` when already a member; `access` defaults to viewer |

Grants to a user and group memberships are refused (400) for someone who isn't a member of
the workspace: add them first.

## What has to be isolated

| Surface | Today | Change |
| --- | --- | --- |
| Storage services | Built once around the `default` id (`apps/agent/src/storage/index.ts`, `services/api-py/api_py/storage.py`) | Take the workspace per request |
| Events (`?watch`) | One hub filtered to one workspace | Filter each subscription by its workspace, and recheck membership per event |
| Search, downloads, chats, memory, shared memory | Queries carry the single workspace id | Use the request's workspace |
| Agent working copy | `<cwd>/workspace/` per run | Per workspace and run |
| Tokens | No workspace claim | `ws` claim |
| Browser saved state | Global keys (`local-persistence.ts`) | Keys per user and workspace id |
| Pending requests on switch | n/a | Cancelled; late answers from the old workspace are dropped |
| User directory | `GET /access/users` lists every signed-in user to any signed-in user; `/access/people` lists them all to root owners | Member list of the current workspace only (below) |

## Backfill

The migration creates `workspace_members` for the default workspace from **effective**
access, not just from grant rows. No grant changes.

| Who | Becomes |
| --- | --- |
| Direct root `owner` grant | Owner |
| Root `owner` through a group, directly or through nested groups | Owner, so they keep people, group and audit administration |
| Any other root grant, direct or through a group | Member |
| Node grants only, direct or through a group | Member |
| The built-in `local` user | Owner of every existing workspace, as today |
| No grant, but chats, memory notes, memory settings, skill settings or incognito chats in the workspace | Member, so their own data stays reachable |
| Signed-in users with nothing in the workspace | Not a member (but see decision 5: until the cut-off, signing in makes them a Member of the default workspace) |

### Authenticated bootstrap

Signing in registers or updates the user and grants nothing. The **one exception** is the
one-time bootstrap of the default workspace's first signed-in Owner, defined here.

Today `user_for_subject` makes a newly seen user Owner of the default workspace whenever no
Owner other than `local` exists. That keeps a fresh deployment usable when login is turned
on, but it can run again later, for example if every non-local Owner is removed. It changes
to:

- The default workspace has an `auth_bootstrapped_at` timestamp. It records that a real
  (non-`local`) user has become Owner. The `local` user's ownership never sets it, because
  it is local-mode ownership and nobody can sign in as `local`.
- **Backfill** sets it only if the workspace already has a non-`local` Owner, directly or
  through a nested group (the table above). A database with only the `local` Owner stays
  open for bootstrap. Running the migration again changes nothing.
- **While it is unset,** the first sign-in takes an advisory lock, checks the timestamp
  again, then adds that user as Owner, adds their root Full access grant and sets the
  timestamp, all in one transaction. Concurrent first sign-ins produce exactly one Owner.
- **Once it is set,** it is never cleared. Later sign-ins, and later ownership changes, don't
  reopen bootstrap. A workspace that loses all its signed-in Owners is recovered by the
  ownership tools in the next batch, not by the next person to sign in.
- **Local mode** is unaffected. The `local` user owns the default workspace and every
  workspace it creates.
- New workspaces never use bootstrap. Their creator becomes Owner when they are created
  (decision 4).

**Test:** before and after the migration, compute every user's effective content role on
every node and their administrative rights (people, groups, audit, sharing). They must
match, for direct and nested-group owners, node-only grantees, the local user, and a
signed-in user with only chats.

## Adding a member

**The member list** is the current workspace's members only. Members see names. Owners and
Admins also see email, sign-up and last-active times. OIDC subjects aren't returned.

**Looking someone up to add them** is separate from the member list:

- It takes one exact email address (case ignored) and returns the user's id and name, or
  "No one with that email has signed in yet. They need to sign in once first."
- It never lists or searches users, and never returns subjects.
- Only Owners and Admins can call it. It does tell them whether an email has signed in to the
  deployment. That is accepted for this milestone. An organization directory can replace it
  later.

**Adding** writes the membership and the starting grant in one transaction:

- If the user is already a member, nothing changes. The answer is 409 with their current
  role. Adding is never a way to change a role or a grant.
- The starting grant is written only when the membership is new, and never overwrites an
  existing grant. So a retry after a later Share change can't undo it.
- Both writes are audited.

## Data changes

- `workspace_members (workspace_id, user_id, role, created_at, created_by)`, with `role` in
  `owner`, `admin`, `member`, and at least one `owner` per workspace.
- `workspaces.created_by`, `workspaces.auth_bootstrapped_at`, and a status column for
  archiving later.
- The backfill above, idempotent, changing no grant.
- Creating a workspace inserts the workspace, the creator's Owner membership and their root
  Full access grant in one transaction.

## Screens

| Screen | Notes |
| --- | --- |
| Switcher at the breadcrumb root | Shows the workspace name instead of the fixed word "Workspace". Lists recent and all workspaces, with Create. Always present, also with one workspace. |
| Home | The app-name link opens the current workspace's home, with all its Experiments. |
| No workspace yet | A new user who belongs to no workspace sees Create a workspace, and a line explaining that to join one, an Owner or Admin adds them. |
| Create workspace | Name (slug made from it, editable), and a starting hierarchy (tech, module, loop, process, or empty). Lands in the new workspace. |
| Add member | Exact email lookup, role (Member or Admin), starting access (none, Can view, Can edit). |
| No access | One page for "doesn't exist" and "you aren't a member", which never shows the workspace's or node's name. |
| Switching with unsaved edits | Asks to save, discard or stay. |

## Tests this spec asks for

- Backfill: effective access before and after, as above.
- Bootstrap:
  - A fresh database with only the `local` Owner switches to login, and the first real user
    gets Owner membership and root Full access.
  - Concurrent first sign-ins produce exactly one bootstrap Owner.
  - Later sign-ins get no ownership.
  - Existing non-local Owners, including nested-group Owners from backfill, keep their
    rights, and bootstrap doesn't reopen.
  - In local mode, creating and using several workspaces still works.
- Legacy tokens: storage and memory tokens without `ws`, each with no selector, a selector
  for the default workspace, and a selector for another workspace. The last is refused even
  when the user belongs to both. After the cut-off, all are refused.
- Two workspaces and two users across UI, API and agent: every surface in the isolation table.
- Selectors: two tabs on two workspaces at once, a header that disagrees with the token,
  unknown and malformed ids, a non-member's id, no selector (legacy default), and a switch
  while requests and an agent run are pending.
- Viewer workflows: a Viewer can still create an Experiment, start a run and propose, and
  can't see someone else's draft.
- Revalidation: one tool call accepted and one queued, then the grant or group membership
  that allowed them is removed. The queued call and any new one are refused, and the accepted
  call's result and audit entry are kept.
- Adding a member: repeat adds, adding an existing Owner, and a retry after a Share change.
- Audit redaction: an Admin without access sees ids, not names.
- Open streams:
  1. Open `?watch` while the user can view a node.
  2. Remove the grant or group that allowed it, keeping workspace membership.
  3. That node's and subtree's events stop arriving, and events for content the user can
     still see keep arriving.
  4. Events for someone else's draft Experiment never arrive.
  5. Removing workspace membership closes the stream.

## Rollout

1. This spec.
2. ~~Land #225, so api-py runs the migrations.~~ Done.
3. ~~The tests above in the conformance suite, expected to fail at first.~~ Done: the
   multi-workspace ones are marked `todo` until they pass.
4. Backend: membership table and backfill, bootstrap change, per-request workspace and
   selectors, revalidation, events, search, member list and lookup, creator ownership,
   audit redaction. Done in api-py. Still to do:
   - 4b, the TypeScript agent: runs capture their workspace, tokens minted with `ws`, the
     in-process tools and the working copy per workspace, and `/memory/agent` for outside
     MCP servers. Until then api-py refuses (400) requests for other workspaces that it
     would pass to that server, rather than let it serve them in the default workspace.
5. Frontend: `/w/<slug>` URLs and redirects, the shared request helper, saved state per
   workspace, switching.
6. Screens: switcher, create, no-workspace onboarding, add member, no-access page.

Traceability follow-ups (input drift by `sha256`, reading past versions, Rules consumption)
stay separate and don't block this.
