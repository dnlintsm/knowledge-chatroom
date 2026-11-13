# Workspaces (design)

Status: **proposed**, tracked in [#226](https://github.com/dnlintsm/knowledge-chatroom/issues/226), for the milestone in
[#178](https://github.com/dnlintsm/knowledge-chatroom/issues/178#issuecomment-6817847479).
Nothing here is implemented yet. Today the app runs in one workspace (slug `default`), which
both servers pick when they start.

This is the short spec and operation matrix that the milestone asks for before
implementation. It covers creating, joining and switching workspaces, and the isolation that
has to be in place first. Administration beyond adding members, Experiment handover,
restricted Knowledge nodes, Guest membership and the Experiment/Run split come later.

## Terms

| Term | Meaning |
| --- | --- |
| Workspace | The boundary for collaboration and authorization. Every node, file, Experiment, chat, memory note, grant and group belongs to exactly one. |
| Membership | Whether a user belongs to a workspace, and as what: **Owner**, **Admin** or **Member**. A non-member gets nothing in that workspace. |
| Content access | What a member can do with Knowledge, through the grants that exist today. The UI calls the three grant roles **Can view** (`viewer`), **Can edit** (`editor`) and **Full access** (`owner`). |

Both layers have to allow an operation. Membership answers "may you be in this workspace at
all, and may you manage its people?". Content access answers "what may you do with this
part of the Knowledge tree?". A member with no grants can open the workspace but sees no
content.

## Decisions

Confirmed on 2026-11-13.

1. **Being a Member gives no content access by itself.** Adding someone also sets an
   explicit starting grant, which defaults to Can view on the workspace root. The person
   adding them can change it in the same step. So there is one access model, and every
   access a person has can be seen as a grant.
2. **Existing grants map without changing anyone's access.** A root `owner` grant becomes
   workspace **Owner**. Anyone with any other grant, directly or through a group, becomes a
   **Member** and keeps exactly the grants they have now.
3. **Local mode (no login):** the local user can create more workspaces and owns all of
   them, as it owns the default workspace today.
4. **Creating a workspace:** any signed-in user can, unless a deployment setting restricts
   it. The default is open. The creator becomes Owner, and gets Full access on the root.
5. **Old links, tokens and saved state keep working.**
   - URLs without a workspace redirect to the default workspace.
   - Tokens without a workspace claim count as the default workspace until a release named
     in the CHANGELOG, and are refused after that.
   - Saved browser state moves into the default workspace once.
6. **The skill hub and memory-pack hub stay global.** Installs and settings are already per
   workspace.
7. **This doesn't wait for phase 4 of #169.** Workspace resolution goes into api-py, which
   already fronts every storage route. The TypeScript chat path and its in-process tools take
   the workspace from the run's token and apply the same checks.

## Operation matrix

✓ allowed · ✗ not allowed · *next* means it ships in the next batch, not this milestone.

### Workspace and people

| Operation | Owner | Admin | Member | Non-member |
| --- | --- | --- | --- | --- |
| See the workspace in the list and open it | ✓ | ✓ | ✓ | ✗ |
| Rename it, change settings | ✓ | ✓ | ✗ | ✗ |
| Add an existing user as Member or Admin | ✓ | ✓ | ✗ | ✗ |
| Make someone Owner, transfer ownership | ✓ *next* | ✗ | ✗ | ✗ |
| Remove a member, change a role | ✓ *next* | Members only, *next* | ✗ | ✗ |
| Leave the workspace | ✓ unless last Owner, *next* | ✓ *next* | ✓ *next* | n/a |
| Archive or delete the workspace | ✓ *next* | ✗ | ✗ | ✗ |
| Groups: create, rename, delete, set members | ✓ | ✓ | ✗ | ✗ |
| Read the audit log | ✓ | ✓ | ✗ | ✗ |
| Create a new workspace | Any signed-in user, unless restricted (decision 4) | | | |

Today the people and audit operations need a root `owner` grant
(`services/api-py/api_py/session.py`, the `need(None, "owner")` calls). They move to Owner
or Admin membership.

### Content (needs membership too)

| Operation | Needs | Today |
| --- | --- | --- |
| Read Knowledge, files, Experiments, search results | Can view on the node | Same |
| Create or rename a node, write or delete a file, create an Experiment, propose a change | Can edit on the node (the parent, for a new node) | Same |
| Accept or reject a proposal | Can edit on the node | Same (`canDecide`) |
| Delete a node | Full access on the node | Same |
| Share: add, change or remove grants on a node | Full access on the node (the root, for workspace-wide grants) | Same |
| Edit an Experiment's content, change its visibility, archive or restore it | Its author | Same; a transferable maintainer comes *next* |
| Rerun an Experiment as your own | Can view on its node | Same (since #188) |

An Admin who isn't an Owner has no content access from that role. An Admin with Full access
on the root, or an Owner, can give themselves any grant. Those grants are audited, and
restricted nodes (later) will need a rule for this.

### Agents and tokens

The agent's effective access is the user's access in that workspace, narrowed by the token.
Storage and memory tokens gain a workspace claim (`ws`). A request whose token names a
different workspace than the one asked for is refused. Agent tokens can't manage members,
just as they can't manage grants today.

Revocation semantics (no new tool dispatch after access is lost, and keeping the evidence of
calls already accepted) are defined with the next batch.

## How a request finds its workspace

- **Web URLs:** `/w/<slug>/…`. The slug is unique. The current single page moves under that
  prefix, and `?experiment=<id>` links keep working inside it.
- **API:** each storage request names its workspace in an `X-Knowledge-Workspace` header,
  which the Next.js proxy sets from the URL. A token's `ws` claim is used when present. The
  server checks membership before anything else, and never treats the header as proof of
  access.
- **Resource ids:** every node, Experiment, file, grant, group, proposal and chat id in a
  request must belong to that workspace. If not, the answer is 404, the same as for an id
  that doesn't exist.
- **No workspace given:** the default workspace, until the cut-off in decision 5.

A path prefix on the API (`/workspaces/<id>/files`) was considered. A header keeps the
OpenAPI contract, the proxy and the conformance suite unchanged, and the server never
trusts it either way.

## What has to be isolated

Every one of these is checked by the two-workspace, two-user tests before the switcher ships.

| Surface | Today | Change |
| --- | --- | --- |
| Storage services | Built once around the `default` id (`apps/agent/src/storage/index.ts`, `services/api-py/api_py/storage.py`) | Take the workspace per request |
| Events (`?watch`) | One hub filtered to one workspace | Filter each subscription by its workspace |
| Search, downloads, chats, memory, shared memory | Queries carry the single workspace id | Use the request's workspace |
| Agent working copy | `<cwd>/workspace/` per run | Per workspace and run |
| Tokens | No workspace claim | `ws` claim |
| Browser saved state | Global keys (`local-persistence.ts`) | Keys per user and workspace |
| Pending requests on switch | n/a | Cancelled; late answers from the old workspace are dropped |

## Data changes

- A `workspace_members (workspace_id, user_id, role, created_at, created_by)` table, with
  `role` in `owner`, `admin`, `member`, and at least one `owner` per workspace.
- `workspaces.created_by`, and a status column for archiving later.
- A migration that fills `workspace_members` from existing grants as in decision 2, and
  changes no grant.
- First sign-in still makes the first user Owner of the `default` workspace, so a new
  deployment can be set up. New workspaces use creator ownership instead.

## Screens

| Screen | Notes |
| --- | --- |
| Switcher at the breadcrumb root | Shows the workspace name instead of the fixed word "Workspace". Lists recent and all workspaces, with Create. With one workspace it stays compact, but Create is still there. |
| Home | The app-name link opens the current workspace's home, with all its Experiments. The list of workspaces is in the switcher. |
| No workspace yet | A new user who belongs to no workspace sees Create a workspace, and a line explaining that to join one, an Owner or Admin adds them. |
| Create workspace | Name (slug made from it, editable), and a starting hierarchy (tech, module, loop, process, or empty). Lands in the new workspace. |
| Add member | Pick an existing user, a role (Member or Admin), and the starting access (decision 1). |
| No access | One page for "doesn't exist" and "you aren't a member", which never shows the workspace's or node's name. |
| Switching with unsaved edits | Asks to save, discard or stay. |

## Rollout

1. This spec.
2. Land #225, so api-py runs the migrations.
3. Two-workspace, two-user isolation tests in the conformance suite, expected to fail.
4. Backend: membership table and migration, per-request workspace, events, search, working
   copy, tokens, creator ownership.
5. Frontend: `/w/<slug>` URLs and redirects, saved state per workspace, switching.
6. Screens: switcher, create, no-workspace onboarding, add member, no-access page.

Traceability follow-ups (input drift by `sha256`, reading past versions, Rules consumption)
stay separate and don't block this.
