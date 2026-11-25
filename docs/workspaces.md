# Workspaces (design)

Status: creating, joining and switching workspaces is **done**
([#226](https://github.com/dnlintsm/knowledge-chatroom/issues/226), the milestone in
[#178](https://github.com/dnlintsm/knowledge-chatroom/issues/178#issuecomment-6817847479)).
Administration and handover is **done** too
([#255](https://github.com/dnlintsm/knowledge-chatroom/issues/255)): see
[Administration and handover](#administration-and-handover). Both shipped in 0.3.0.

This is the short spec and operation matrix that #178 asks for before implementation. It
covers creating, joining and switching workspaces, the isolation that has to be in place
first, and then removing members, changing roles, transferring ownership, archiving
workspaces and handing Experiments over. Restricted Knowledge nodes, Guest membership,
commenting and the Experiment/Run split come later.

## Terms

| Term | Meaning |
| --- | --- |
| Workspace | The boundary for collaboration and authorization. Every node, file, Experiment, chat, memory note, grant, group and audit entry belongs to exactly one. It has an immutable id (UUID) and a unique slug that can change. |
| Membership | Whether a user belongs to a workspace, and as what: **Owner**, **Admin** or **Member**. A non-member gets nothing in that workspace. |
| Content access | What a member can do with Knowledge, through the grants that exist today. The UI calls the three grant roles **Can view** (`viewer`), **Can edit** (`editor`) and **Full access** (`owner`). |
| Experiment visibility | A draft Experiment is visible only to its maintainer and collaborators. Shared and archived Experiments are visible to whoever can view their node. Until #255 the maintainer was always the author, the rule in `005_experiments.sql`. |
| Author, maintainer, collaborator | An Experiment's **author** is who created it, and never changes: it is provenance. Its **maintainer** is the one person responsible for it now, the author until they hand it over. **Collaborators** are people the maintainer adds to work on it with them (#255). |

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
   it (`WORKSPACE_CREATORS` on api-py: the emails or login subjects that may). The
   default is open. The creator becomes Owner with Full access on the root, in the
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
   fronts every storage route. The chat agent and its in-process tools take the workspace
   from the run and apply the same checks.
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

- Other users' draft Experiments. Drafts are visible only to their maintainer and
  collaborators, whatever the grants are. Owners and Admins can't hand a draft over
  either (see [Experiment handover](#experiment-handover)).
- Other users' chats and memory notes, which belong to the user and not to grants.
- Owner-only actions: making someone Owner, transferring ownership, archiving or deleting the
  workspace.

Delegation for starting grants: when adding a member, an Owner or Admin may set none, Can view
or Can edit on the root. Full access is given only through Share, by someone who has Full
access on that node. The membership and the starting grant are written in one transaction,
with one audit entry each.

Once restricted Knowledge nodes exist, this model has to be revisited, because group
administration would then cross a boundary that is meant to hold.
[Restricted Knowledge nodes](restricted-knowledge.md) (decisions 7 and 8) proposes how: group
changes that reach inside a restricted node need Full access there, and only an Owner can
take a restricted node over, loudly.

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
| Make someone Owner, transfer ownership | ✓ #255 | ✗ | ✗ | ✗ |
| Change a role | ✓ any member's, unless it demotes the last Owner, #255 | Make a Member Admin; step down to Member yourself, #255 | ✗ | ✗ |
| Remove a member | ✓ anyone but the last Owner, #255 | Members only, #255 | ✗ | ✗ |
| Leave the workspace | ✓ unless last Owner, #255 | ✓ #255 | ✓ #255 | n/a |
| Archive or restore the workspace (not the default one) | ✓ #255 | ✗ | ✗ | ✗ |
| Delete the workspace for good | ✗ later, with a retention policy | ✗ | ✗ | ✗ |
| See an archived workspace | ✓ to restore it, #255 | ✗ | ✗ | ✗ |
| Groups: create, rename, delete, set members | ✓ | ✓ | ✗ | ✗ |
| Read the audit log (redacted, below) | ✓ | ✓ | ✗ | ✗ |
| Create a new workspace | Any signed-in user, unless restricted (decision 4) | | | |
| List every workspace in the deployment; add an Owner to one | Deployment admins only (`PLATFORM_ADMINS`), never content, #255 | | | |

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
| Edit an Experiment's content and files, add run inputs, finish a run, propose its files to the node | Its maintainer or a collaborator, while it isn't archived | Its author (#255 adds collaborators) |
| Change an Experiment's visibility, archive, restore or delete it; add or remove collaborators | Its maintainer | Its author |
| Hand an Experiment over to another maintainer | Its maintainer; an Owner or Admin for a shared or archived one, never a draft | n/a (#255) |
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
  from the database, in api-py and in agent-py's tools. This is how content checks
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

What happens to running work when someone is removed, or a workspace is archived, is in
[Removing a member](#removing-a-member-or-leaving) (#255).

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
| Storage services | Built once around the `default` id (`services/api-py/api_py/storage.py`) | Take the workspace per request |
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
  reopen bootstrap. A workspace whose Owners can no longer sign in is recovered by a
  deployment admin adding an Owner (see [Workspace inventory](#workspace-inventory),
  #255), not by the next person to sign in.
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
Admins also see email, sign-up and last-active times. OIDC subjects aren't returned. The
sharing picker's list (`GET /access/users`) follows the same rule: names for a Member, emails
too for an Owner or Admin, and never subjects. A user gets their own subject from
`GET /access`, and Owners and Admins see members' subjects in `GET /access/people`.

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
- `workspaces.created_by`, `workspaces.auth_bootstrapped_at`, and a `status` column
  (`active` or `archived`), which #255 starts using.
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

## Rollout (#226)

1. This spec.
2. ~~Land #225, so api-py runs the migrations.~~ Done.
3. ~~The tests above in the conformance suite, expected to fail at first.~~ Done, and
   all of them pass since step 4b.
4. Backend: membership table and backfill, bootstrap change, per-request workspace and
   selectors, revalidation, events, search, member list and lookup, creator ownership,
   audit redaction. Done in api-py, and in the TypeScript agent (4b): runs keep their
   workspace, tokens are minted with `ws`, the in-process tools check membership on
   each call, the working copy is per user and workspace, and `/memory/agent` takes the
   workspace from the token. Without api-py, that server serves its storage and skills
   APIs for the default workspace only and refuses (400) the others.
5. Frontend: `/w/<slug>` URLs and redirects, the shared request helper, saved state per
   workspace, switching. Done: `apps/web/src/app/w/[slug]/page.tsx` resolves the slug among
   the user's workspaces once, on the server, and `/` redirects to `/w/default` with its
   query. `apps/web/src/lib/workspace-request.ts` is the one request helper (the header,
   `?workspace=` for EventSource and links, cancelling on a switch). `local-persistence.ts`
   keeps the workspace's keys per user and workspace id and moves the old ones into the
   default workspace once. The chat (CopilotKit and the history) mounts again per workspace,
   and the app's chat store and remote-backend tokens follow the run's workspace. Renaming
   a slug has no route yet, so there is no rename redirect; a page without api-py opens the
   default workspace with no selector.
6. Screens: switcher, create, no-workspace onboarding, add member, no-access page. Done:
   the switcher is the breadcrumb's root (`components/workspace/workspace-switcher.tsx`),
   with the save, discard or stay prompt, which saves through the save scheduler
   (`settleAll`, retrying failed saves in the current place) or drops what is still
   waiting (`discard`). Recent workspaces are kept per user in this browser
   (`lib/workspace-choice.ts`). Create (`create-workspace.tsx`) sends `POST /workspaces`
   with a `slug` when one is given, which api-py now takes (409 when taken). Add member is
   in the Admin panel (`add-member.tsx`), which is for the workspace's Owners and Admins.
   `app/w/[slug]/page.tsx` shows onboarding to a user with no workspace and the no-access
   page to one asking for a workspace that isn't theirs, and `/` opens the default
   workspace only for its members. A node or experiment link the user can't open still
   shows the workspace without it, not this page. Follow-ups that close the milestone:
   `WORKSPACE_CREATORS` (decision 4), with `canCreate` on `GET /workspaces` so the
   switcher and onboarding offer Create only to those who may; the UI names the `owner`
   grant Full access; and the login e2e shares an Experiment link in a second workspace
   with a colleague, before and after they are added.

Traceability follow-ups (input drift by `sha256`, reading past versions, Rules consumption)
stay separate and don't block this.

## Administration and handover

Tracked in [#255](https://github.com/dnlintsm/knowledge-chatroom/issues/255), section 4 of
the [#178 plan](https://github.com/dnlintsm/knowledge-chatroom/issues/178#issuecomment-6817847479).
The operation matrix above has its rows. This section says what each operation does.

### Changing a role

`PATCH /workspaces/{id}/members/{userId}` `{role}` answers the member with their new role.

| Who | May |
| --- | --- |
| Owner | Give any member any role: Member, Admin or Owner. |
| Admin | Make a Member an Admin (as they could add them as one), and step down to Member themselves. Nothing else: not another Admin, not an Owner. |
| Member | Nothing. |

- The last Owner can't be demoted (409, "A workspace needs at least one owner"). The
  built-in local user of a deployment that once ran without login doesn't count, since
  nobody signs in as it: the last signed-in Owner can't leave the workspace to it alone.
- **Ownership changes are serialized per workspace.** The existing trigger
  (`workspace_members_keep_owner`) looks for another Owner without a lock, so two Owners
  demoting or removing each other at once could each still see the other and both commit,
  leaving none. So:
  - every route that can take away an Owner (a role change, a removal, leaving) first
    locks the workspace's row (`SELECT … FOR UPDATE`) in its transaction, then counts the
    Owners and answers 409 when the change would leave none. Adding an Owner from the
    [workspace inventory](#workspace-inventory) takes the same lock;
  - the migration changes the trigger to take that lock too before it looks, so any other
    path that writes `workspace_members` (the TypeScript server, a script) is serialized
    the same way and rechecks after the other transaction commits.
- A role change never changes a grant. Workspace roles are administrative; content access
  stays with grants (decision 1).
- **Transferring ownership** is two role changes: make the other person Owner, then lower
  your own role. The screen does both, in that order, so there is always an Owner, and
  offers to give the new Owner Full access on the root through Share if they don't have it.
  Owners are peers: there can be several, and any of them can change another's role.
- Audited as `member.role`, with the old and new role.

### Removing a member, or leaving

`DELETE /workspaces/{id}/members/{userId}` removes someone. With your own id it is leaving.
An Owner removes anyone but the last Owner, an Admin removes Members only, and anyone may
leave unless they are the last Owner (409).

In one transaction, it:

1. deletes the membership;
2. deletes the person's **direct grants** in the workspace, their **memberships of its
   groups** and their **Experiment collaborator places** there, so being added again later
   starts from the starting grant, as for anyone new: nothing someone else gave them comes
   back on its own (grants and group memberships are already refused for non-members,
   and collaborators have to be members);
3. records a **departure**, so the default workspace doesn't add them back at their next
   sign-in during the compatibility period (decision 5), also when that sign-in happens
   while the removal is still committing. Adding them again clears it;
4. writes one audit entry, `member.remove` or `member.leave`, with how many grants and
   group memberships went.

`GET /workspaces/{id}/members/{userId}/removal` previews it for the confirmation: the
grants and groups that go, and the shared or archived Experiments they maintain that the
caller can see. It never counts drafts.

What stays, unchanged:

- Experiments they authored or maintain, files they wrote, and proposals they made. Their
  open proposals can still be accepted or rejected by editors on the node. A shared
  Experiment they maintain shows its maintainer as "no longer a member" and can be handed
  over (below).
- Their own drafts, chats, memory notes and settings in the workspace. Nobody else can see
  them, as before.

If they are added again, what was given to them stays gone (grants, groups, collaborator
places). What is **their own** comes back: their chats, memory and the Experiments they
still maintain, drafts included, as their chats do. Maintaining is responsibility for
their own work, not access someone granted, and it still needs Can view on the node,
which only a new grant gives them. An Experiment handed over while they were away stays
with its new maintainer.

What stops (see [Revalidation](#revalidation)):

- Every request, tool call and memory call in the workspace, including tokens already
  minted: 404, as for any non-member. Their open `?watch` streams close.
- **Their running chat runs in that workspace end at their next step**, in the
  chat agent. It checks membership (and that the workspace is active) again before every tool call and after every batch of tool calls,
  before the next model request. A tool call that was already accepted runs to its end,
  whether it succeeds or fails, and keeps its result and audit entry; then the run stops,
  so the model gets no turn after it. A tool call after the removal is refused, with the
  reason ("no longer a member of this workspace"), and the run stops there. An Experiment
  run left in the `running` state stays so; its maintainer, after a handover, can finish
  it as failed.
- A grant, group membership, collaborator place or handover that was being written for
  them as they were removed is taken away too. The write takes
  `lock_workspace_member()` first: the workspace's row `FOR KEY SHARE`, then their
  membership row `FOR SHARE`, the order the removal locks them in (`FOR UPDATE`). The
  removal waits for the write and then removes what it wrote, and a write that starts
  after the removal finds no member and is refused. Adding them back restores none of
  it.
- Signed download links expire as before (`DOWNLOAD_LINK_SECONDS`).

### Renaming and archiving a workspace

`PATCH /workspaces/{id}` `{name?, status?}`:

- `name`: Owners and Admins. The slug doesn't change, so links keep working. Changing the
  slug, with its redirect, stays out of this batch. Audited as `workspace.rename`.
- `status: "archived"`: Owners only. The **default workspace can't be archived** (400),
  since requests that name no workspace go there. Archiving hides the workspace from
  everyone: it leaves the switcher, every request and token in it gets 404, open streams
  close and running runs end at their next step, as for a removed member. Nothing is
  deleted. Audited as `workspace.archive`.
- `status: "active"`: Owners only, from the archived list. Audited as `workspace.restore`.

`GET /workspaces?archived=true` adds the archived workspaces the caller owns, each with
`status: "archived"`, so an Owner can find one to restore. Admins and Members of an archived
workspace don't see it. Every entry of `GET /workspaces` gains `status`.

Deleting a workspace for good waits for a retention policy (#178), and isn't in this batch.

### Experiment handover

An Experiment has an immutable **author** and a **maintainer** who is responsible for it
now. The migration sets every maintainer to the author, so nothing changes for existing
Experiments.

| Operation | Maintainer | Collaborator | Others who can see it | Owner or Admin who can see it |
| --- | --- | --- | --- | --- |
| See it while it's a draft | ✓ | ✓ | ✗ | ✗ |
| Edit its content and files, add run inputs, finish a run, propose its files to the node | ✓ unless archived | ✓ unless archived | ✗ | ✗ |
| Change its visibility (draft, shared), archive, restore, delete | ✓ | ✗ | ✗ | ✗ |
| Add or remove collaborators | ✓ | Remove themselves | ✗ | ✗ |
| Hand it over to a new maintainer | ✓ | ✗ | ✗ | Shared or archived only |
| Rerun it as their own | ✓ | ✓ | ✓ | ✓ |

Everyone in this table also needs workspace membership and Can view on the Experiment's node
(or the root, for one with no node), as today. So losing access to the node takes away a
maintainer's or collaborator's access to its Experiments too, and adding a collaborator
never gets around a node they can't read (#178).

- **Adding a collaborator** (`PUT /experiments/{id}/collaborators/{userId}`) needs a member
  who can view the node, or the answer is 400, "They can't view this experiment's node.
  Share it with them first." `DELETE` on the same path removes one. Audited as
  `experiment.collaborator.add` and `.remove`.
- **Handing over** (`PUT /experiments/{id}/maintainer` `{userId, keepAsCollaborator?}`)
  needs a new maintainer who is a member and can view the node, the same 400 otherwise.
  The previous maintainer stays on as a collaborator unless `keepAsCollaborator` is
  false, **and only while they are still a member**: handing over a departed maintainer's
  Experiment never makes them a collaborator, so no dormant place waits for them if they
  are added again. Audited as `experiment.maintainer`, with both people.
- **Owners and Admins** can hand over a shared or archived Experiment they can see, for
  example when its maintainer has left. They can't see drafts, so they can't hand one
  over: a departed member's drafts stay private, as their chats do (see the
  [Admin trust model](#admin-trust-model)). The UI offers this when the maintainer is no
  longer a member, and in a member's removal preview.
- **The answer** for an Experiment gains `maintainerId`, `maintainerName`,
  `collaborators: [{id, name}]`, and whether the maintainer is still a member.
  `authorId` and `authorName` stay as they are. `mine` now means "you maintain it",
  which is what it meant until now, since the author was the maintainer. `access` is
  `writer` for the maintainer and collaborators while it isn't archived.
- **Agent tokens** can do what their user can do as a maintainer or collaborator, except
  manage collaborators or hand over, as they can't manage grants today.
- Search, proposals, file access and audit redaction decide visibility through the SQL
  function `experiment_access`, and the RLS policies on `experiments` check the author too.
  Those, and the event filter (`hears_experiment` in api-py, `ExperimentService.hears` in
  the agent, which also check the author), move to "maintainer or collaborator" together,
  in one migration and in both servers.

### Workspace inventory

For whoever runs the deployment, who isn't necessarily a member of every workspace.
`PLATFORM_ADMINS` on api-py names them (emails or login subjects, as `WORKSPACE_CREATORS`
and `HUB_ADMINS` do). In local mode the local user is one. Nobody is one by default.

- `GET /platform/workspaces` lists every workspace, active and archived: name, slug,
  status, who created it and when, how many members, its Owners (names and emails), and
  when someone last used it. No content: no node names, files, Experiments, chats or
  member lists beyond the Owners.
- `GET /platform/users?email=` finds someone who has signed in with exactly that email
  (case ignored), so the screen can name who to add; 404 when nobody has.
- `POST /platform/workspaces/{id}/owners` `{userId, fullAccess?}` makes someone who has
  signed in an Owner of that workspace, adding them as a member if they aren't one. It is
  for a workspace whose Owners can no longer sign in, archived or not. It takes the
  workspace lock, as role changes do. A deployment admin can't name themselves (400): ask
  another admin, or add someone else. Adding someone who is already an Owner changes
  nothing and logs nothing.
- **Restoring content administration.** Being Owner alone isn't always enough to recover:
  Share needs Full access, and in a new workspace the creator's direct root Full access
  grant is often the only one. If that creator can no longer sign in, groups can't help
  either, since no group holds Full access to join. So `fullAccess: true` also gives the
  designated Owner, and only them, Full access on the workspace root, in the same
  transaction. It is a direct grant like any other, visible in Share and the Admin panel,
  never to the deployment admin, and never on a single node. The screen offers it, and
  preselects it when no member who has signed in within `RECOVERY_IDLE_DAYS` (90 by
  default) holds Full access on the root.
- Both are audited in that workspace's log, with the deployment admin as the actor:
  `platform.owner`, and `grant.set` with `recovery: true` for the grant. The workspace's
  Owners and Admins see both.
- Being a deployment admin gives nothing else: no membership, no content, no audit log.

### Audit

Every operation in this section writes one entry in the workspace's audit log, readable by
its Owners and Admins with the [redaction](#audit-log-visibility) that already applies: an
Experiment's title shows only to readers who can see that Experiment.

### Screens

| Screen | Notes |
| --- | --- |
| People (Admin panel) | Each member's role is a menu with only the roles the viewer may set. Remove opens a confirmation from the removal preview: the grants and groups that go, and the shared Experiments they maintain, with a link to hand them over. |
| Transfer ownership | On another member: "Make Owner", then asks whether to stay as Admin or Member, and whether to give them Full access on the root if they lack it. |
| Leave workspace | In the switcher's menu for the current workspace. Says what happens (your access goes; your drafts, chats and memory stay private and come back if you're added again). The last Owner is told to make someone else Owner first. |
| Workspace settings | Rename (Owners and Admins). Archive (Owners, not the default workspace), confirmed by typing the workspace's name. |
| Archived workspaces | A section of the switcher, for Owners, with Restore. |
| Experiment header | "Maintained by Alice · started by Bob" when they differ, and the collaborators. The maintainer adds and removes collaborators from the workspace's members (the server refuses one who can't view the node, and says so), and hands over. "No longer a member" by a departed maintainer, with Hand over for Owners and Admins. |
| Read-only reasons (`read-only.ts`) | "Only Alice and the collaborators can edit this experiment", and the archived reason names the maintainer. |
| Workspace inventory | A page for deployment admins only (`/platform`, linked from the switcher), with the list and "Add an Owner". |

### Tests this batch asks for

In the conformance suite, against the same backend as before:

- Role changes: every caller role against every target role, including Admins on Admins and
  Owners, self-demotion, and the last Owner (409).
- Removal and leaving: who may remove whom, the last Owner (409), grants and group
  memberships gone, the removed member's requests, tokens and streams refused or closed,
  their drafts still invisible to the Owner, and adding them again starts from the starting
  grant.
- Last Owner under concurrency: two Owners demoting each other, and two removing each
  other, at the same time. Exactly one change succeeds, the other gets 409, and the
  workspace keeps one Owner. Also with the routes bypassed (two transactions updating
  `workspace_members` directly), which the trigger's lock must catch.
- Archiving: Owners only, the default workspace refused, members get 404 and lose it from
  `GET /workspaces`, the Owner sees it with `?archived=true` and restores it.
- Experiments: a collaborator edits content and files but can't change the visibility,
  delete, or manage collaborators; a collaborator sees a draft; losing Can view on the node
  takes collaborator access away; handover by the maintainer; an Owner or Admin hands over
  a shared one but gets 404 for a draft; a collaborator on someone's draft who is removed
  and added again with Can view doesn't see or edit that draft; handing over a removed
  maintainer's Experiment with `keepAsCollaborator` doesn't make them a collaborator, also
  after they are added again; the new maintainer or collaborator must be able to
  view the node; agent tokens can't manage collaborators. These run in the default
  workspace.
- Workspace inventory: refused to anyone not in `PLATFORM_ADMINS`, no content in the
  answer, adding an Owner is audited in the workspace.
- Recovery where the unavailable creator held the only direct root Full access grant and
  no group holds Full access: an Owner added without `fullAccess` can't Share (403); one
  added with it can, the grant is theirs alone, and the deployment admin still gets 404
  in the workspace.

In `services/api-py/tests` (they need the database): the migration sets every maintainer to
the author and changes nobody's access to any Experiment, a member removed from the
default workspace isn't added back at sign-in, and a group membership or grant written
while its user is being removed, in either order, doesn't come back when they're added
again.

In `services/agent-py` (through the real Claude Code engine, with a
scripted Messages API that counts model turns): a run whose user is removed, or whose
workspace is archived, during an accepted tool call keeps that call's result, whether it
succeeded or failed, and ends without another model turn; a tool call after that is
refused and never runs. The in-process tools follow the maintainer and collaborator
rules.

### Rollout (#255)

1. This section.
2. Backend, people: role changes, removal and leaving, departures, rename, archive and
   restore, runs ending on removal. The routes go into `openapi/storage.yaml`. Done:
   `services/api-py/api_py/workspaces.py` serves them, `024_workspace_departures.sql`
   adds the departures, keeps `sign_in_memberships` from re-adding someone who left, and
   makes `workspace_members_keep_owner` lock the workspace's row before it looks. The
   routes take that lock first too, so two Owners demoting or removing each other at once
   leave one. In the chat agent, a hook checks membership before every tool call of a
   run and stops the run once it is gone (the TypeScript agent, since removed, did the
   same).
3. Backend, Experiments: the migration, maintainer and collaborators in api-py and in the
   TypeScript server's session and tools. Done: `025_experiment_maintainers.sql` adds
   `maintainer_id` (backfilled from the author) and `experiment_collaborators`, rewrites
   `experiment_access`, and adds a trigger that keeps the column rules (author fixed;
   status, deletion and handover for the maintainer, handover also for Owners and Admins
   on shared ones) for users' own queries under row-level security. Both servers serve
   the handover and collaborator routes, and removal deletes collaborator places.
4. Backend, workspace inventory and adding an Owner. Done: api-py serves `/platform`
   (`platform.py`), with `PLATFORM_ADMINS` and `RECOVERY_IDLE_DAYS`. Only api-py serves
   it, as it does `/workspaces`.
5. Screens: people, transfer, leave, settings, archived workspaces. Done: the Admin
   panel's People tab has each member's role (`members.tsx`) and Remove, with the
   preview; "Make Owner" asks whether you stay an Owner or become an Admin or a Member,
   and offers Full access on the root. The switcher has Workspace settings (rename;
   archive, typing the name), Leave workspace (with login) and Archived workspaces, with
   Restore (`workspace-settings.tsx`). The Activity tab lists membership and workspace
   changes too. `src/lib/workspace-admin.ts` says what each role may do, for the screens.
6. Screens: the Experiment header and the read-only reasons. Done: `experiment-people.tsx`
   shows the maintainer, who started it and the collaborators under the Experiment's
   title, with Add collaborator, Hand over and Stop collaborating where
   `experimentPeople` (`src/lib/workspace-admin.ts`) allows them. The pickers list the
   workspace's members; someone who can't view the node is refused with the server's
   reason. `read-only.ts` names the maintainer and the collaborators.
7. Screen: workspace inventory. Done: `/platform` (`inventory.tsx`) lists every
   workspace, with a filter, and "Add an Owner" finds them by email
   (`GET /platform/users`, added in this step) and offers Full access, preselected when
   nobody active holds it. The workspace switcher links to it for the deployment's
   admins. The app forwards `/api/platform` to the API server.

Each backend step brings its tests. The legacy fallback's cut-off release gets its own
issue.
