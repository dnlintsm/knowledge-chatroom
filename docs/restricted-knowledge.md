# Restricted Knowledge nodes (design)

Status: **proposed**, tracked in
[#267](https://github.com/dnlintsm/knowledge-chatroom/issues/267) (batch B), the open
"restricted access" criterion of
[#178](https://github.com/dnlintsm/knowledge-chatroom/issues/178).

Today every grant reaches down the whole tree: Can view on a top-level node, or on the
workspace root, opens everything below it. That is right for most Knowledge, but not for a
customer's data, an unannounced product or a personnel matter that a few people should see.
This batch lets a node stop inheritance, so that only people given access there (or below)
can open it, and makes the boundary hold for Owners and Admins too.

## What exists today

| | Today | Gap |
| --- | --- | --- |
| Inheritance | Roles are additive with no deny rules, and inherit down the tree and down the group tree (`003_access.sql`). One SQL function decides content access, `effective_role(ws, user, node)`, with `path_role` and `sees_path` for row security (`004_row_security.sql`). Experiments (`experiment_access`), search, proposals, shared memory (`place_rank`), events and Claude's tools all go through them. | No way to stop a grant higher up from reaching a node. |
| Visibility | A node shows in the tree if you have a role on it, or on something below it (its ancestors are drawn as the path there). | Nothing to hide a node from people who could open it through the root. |
| Explaining access | Sharing lists the grants made on the current place. The admin panel shows a member's root grant and "through a group". | Nobody can see, for one node, everyone who can open it and why (direct, group, ancestor). |
| Admins | High trust: an Admin manages groups, so they can reach any shared content by joining a powerful group. The [Admin trust model](workspaces.md#admin-trust-model) says this has to be revisited once restricted nodes exist. | |

## Decisions

1. **A restricted node stops inheritance from above.** Grants on its ancestors and on the
   workspace root no longer reach it or anything below it. Grants on the node itself and on
   nodes below it work as usual, including through groups.
2. **The nearest restricted node wins.** A restricted node inside another one stops the outer
   one's grants too. There is no "un-restrict below".
3. **The root can't be restricted.** Root grants are the workspace's baseline.
4. **One place changes.** `effective_role`, `path_role` and `sees_path` learn the boundary.
   Everything that already goes through them (files, versions, Experiments and their runs,
   search, proposals, shared memory, events, Claude's tools and row security) follows without
   its own check. A test asserts each of them.
5. **Turning it on never locks out the person doing it.** It needs Full access on the node.
   The same transaction gives them an explicit Full access grant on it, and keeps anyone else
   they pick from the preview at their current role.
   - **Nobody is kept unless picked.** Each "Keep access" box in the preview starts
     unchecked. Ticking one creates an explicit grant on the node at that person's current
     role, so it is a deliberate choice each time.
   - With no box ticked, access from above stops at the node. Grants on the node or below it
     still apply, and the person turning it on keeps Full access.
6. **A restricted node always has someone with Full access.** Removing the last direct Full
   access grant on a restricted node is refused. If that person leaves the workspace, an Owner
   can take it over (decision 8).
7. **Owners and Admins manage around it, not into it** (the Admin trust model, revisited):
   - They see that it exists, its name, and who can open it, so they can run the workspace.
     They can't open it, its files, its Experiments or its search results without a grant
     there.
   - Adding someone to a group, or to a group below it, that has a grant on or inside a
     restricted node needs Full access on that restricted node, like sharing it directly.
     Without it the change is refused, and the message says which restricted node needs
     it.
   - Removing people from groups, deleting groups and revoking grants stay open to them: they
     only take access away.
   - Root grants and starting grants for new members stop at the boundary, so they can't
     cross it.
8. **Owner takeover.** An Owner (not an Admin) can give themselves Full access on a restricted
   node. It is meant for a node whose people have left, and it is loud: audited as
   `node.takeover`, shown to everyone who can open the node as "<name> took over on
   <date>", and listed in the node's "Who has access" with that source.
9. **Claude stays inside the user's rights.** An agent token acts with the user's current
   access, so it can't see a restricted node its user can't open. Turning restriction on or
   off and taking over are people's actions, refused to agent tokens, as managing access is.
10. **Deleting a node can't reach past a restriction.** Deleting a node deletes everything
    below it, so it needs Full access on the node *and* on every restricted node below it.
    If the caller lacks Full access on any of them, the whole delete is refused (403, "Part
    of this node is restricted, and deleting it needs Full access there too") and nothing
    changes: not the node, not its restricted descendants, not any of their files. The check
    runs with the database owner's rights before anything is deleted, so it holds the same
    with row security on or off. It names no restricted node the caller can't see.
    - **A delete and a concurrent restriction change are ordered by row locks.** The delete
      locks every live node in the subtree (`FOR UPDATE`) before it checks. Turning
      restriction on or off locks the node it changes. Whichever commits first decides.
    - If the restriction commits first, the delete waits for that lock, then checks again
      with the restriction in place. Without Full access there, it is refused and the whole
      subtree stays intact.
    - If the delete commits first, the restriction change finds the node gone (404).
11. **Proposals follow current access, for their author too.** Today its author always sees
    their own proposal, wherever it is. That exception goes, in the app's query and in row
    security alike. Three permissions, each on the proposal's node now:

    | To | Needs | Row security |
    | --- | --- | --- |
    | Read it, list it, read its content, hear its events | Can view | `proposals_read` |
    | Withdraw it (open only) | Its author, with Can view | `proposals_change`, author branch |
    | Accept or reject it | Can edit or Full access | `proposals_change`, decider branch |

    `proposals_change` keeps its author branch, with Can view added to it, so a viewer can
    still withdraw their own open proposal with row security on. An author who loses their
    last grant on the node (because it was restricted, or a grant was revoked):
    - no longer finds it in proposal listings;
    - gets 404 for reading it, or its content, and for withdrawing it;
    - stops receiving proposal events about it.

    Someone who can view the node still sees it, and someone with Can edit decides it, as
    before.

## Who sees what

| | Can open it (a role there) | A grant only below it | Owner or Admin without a role | Other members |
| --- | --- | --- | --- | --- |
| The node in the tree | ✓ with a lock mark | Its name, as the path to what they can open | Its name and the path to it, with a lock and no file count | ✗ hidden |
| Its files, Experiments, search hits, proposals | ✓ | Only below, where their grant is | ✗ | ✗ |
| Who has access (names, roles, sources) | With Full access there | ✗ | ✓ names and roles only | ✗ |
| Nodes below it | As their roles allow | The path to their grant | ✗ | ✗ |

A hidden node leaves no trace for other members: no placeholder, no count, and a link to it
answers "not found", as for any node you can't see. File counts and child counts are only
shown where you can open the node.

## Turning it on and off

- `GET /nodes/{id}/restriction` answers the node's state and a **preview**: who would lose
  access if it were restricted now (each person, their current role, and the grant it comes
  through: an ancestor's or the root's, directly or through a group), and how many of their
  Experiments there would close to them. For a restricted node it previews the reverse: who
  would gain access if it were lifted.
- `PUT /nodes/{id}/restriction` with `{"restricted": true, "keep": [{"principalType",
  "principalId"}]}` turns it on. Each kept user or group gets an explicit grant at the role
  they had, and the caller gets Full access. `{"restricted": false}` lifts it. Both need Full
  access on the node, are audited as `node.restrict` and `node.unrestrict` with who kept or
  gained access, and send a `node` event so open trees refresh.
- The preview is advisory. The `PUT` recomputes who loses access inside its transaction.

Experiments keep their visibility rules. A draft whose maintainer loses access stays theirs,
but they can't open it until someone gives them access again. The preview counts these so
the person restricting the node sees it first.

## Why access is effective

`GET /nodes/{id}/access` lists everyone who can open the node, with their role and every
source that gives it: a grant **here**, a grant on an **ancestor** (named) or the **root**,
each either **direct** or **through a group** (named). The strongest source decides the role,
and the rest are listed under it. For a restricted node, sources above it are left out, and
the answer says where inheritance stops.

It needs Full access on the node, or Owner or Admin membership (names and roles only, as in
the table above). The Sharing panel shows it under the grants made here, as "Who has access".

## Data changes

- `nodes.restricted boolean NOT NULL DEFAULT false`, with `restricted_at` and `restricted_by`.
- `effective_role`, `path_role` and `sees_path` only count grants on nodes at or below the
  nearest restricted node on the target's path, and root grants only when there is none.
  `sees_path` also returns true for an Owner or Admin on a restricted node and the path to it
  (the names only: file and Experiment policies use `effective_role`, which doesn't change
  for them).
- A check on adding group members (`AccessService.set_member`) for decision 7.
- Revoking or lowering grants (`AccessService.revoke`, `set_grant`) refuses taking away the
  last Full access grant on a restricted node (decision 6). A departing member's grants still
  go with them.
- A trigger refuses changing `restricted` for anyone without Full access on the node, as a
  safety net under the routes' own check.
- `grants.takeover` marks a grant an Owner gave themselves by taking over (decision 8).
- `delete_blocked(ws, user, path)`, a security-definer function that says whether a
  restricted node below `path` lacks the user's Full access; `nodes.remove` asks it first,
  under the node's row lock (decision 10).
- The proposal query, `proposals_read` and the proposal event filter drop the author
  exception. `proposals_change` keeps its author branch for withdrawing, with Can view
  added to it (decision 11).

## Contract changes

- `VisibleNode` gains `restricted` (boolean) and, for Owners and Admins who can't open it,
  `role: null` with `restricted: true`.
- `GET /nodes/{id}/restriction`, `PUT /nodes/{id}/restriction`.
- `POST /nodes/{id}/takeover` (Owners only).
- `GET /nodes/{id}/access`.
- `NodeEvent.change` gains `restrict`.
- New refusals: 409 for the last Full access grant on a restricted node, 403 for a group
  change that would cross a boundary, 403 for agent tokens on the new routes.

## Screens

- **Restrict** in a node's Sharing panel, for people with Full access. It opens the preview:
  "These people will lose access", each with a checkbox to keep them (unchecked by default),
  and how many of their Experiments close. Lifting it previews who gains access.
- A **lock** mark on restricted nodes in the tree and the breadcrumb, with "Restricted: only
  the people listed in Sharing can open this" as its title.
- **Who has access** in Sharing: each person with their role and sources ("Can edit, through
  Etch team on Process"), and "Inheritance stops here" on a restricted node.
- For Owners and Admins without a role: the node shows with a lock and no files. Opening it
  says "Restricted. You can see who has access but not its content." Owners also get **Take
  over**, with a confirmation that says it will be shown to everyone with access.
- Group membership changes that are refused say which restricted node needs Full access.

## Tests this batch asks for

- Inheritance: a root viewer and an ancestor editor lose access when a node is restricted; a
  grant on the node, or below it, still works, directly and through a group; a nested
  restricted node stops the outer one's grants; lifting it brings inherited access back.
- Everything follows: files and past versions, Experiments (a shared one on the node, and a
  draft whose maintainer lost access), search hits, proposals, shared memory on the node,
  events, Claude's `read_file` and `search`, and row security with the app's check skipped.
- Visibility: other members don't see the node or a link to it (404); someone with a grant
  below sees only the path; an Admin sees its name, lock and who has access, but no files.
- Turning it on: the preview lists who loses access and through what; with no one kept,
  inherited access stops, grants on the node or below still work, and the caller keeps Full
  access; keeping someone gives them their role there; refusing it without Full access; agent
  tokens get 403. The Sharing E2E restricts with every box left unchecked.
- Admins: adding someone to a group with a grant inside a restricted node is refused without
  Full access there, and allowed with it; a sub-group counts; removing members still works;
  an Admin can't take over, an Owner can, and it is audited and shown.
- The last Full access grant on a restricted node can't be revoked.
- `GET /nodes/{id}/access` names each source, and stops at a restricted node.
- Deleting across a boundary (decision 10), with row security on and with it off: the
  caller has Full access on a parent only, and a child below it is restricted without them.
  Deleting the parent answers 403, and the parent, the restricted child and the files in
  both are all still there, for the caller and for the child's own people. With Full access
  on the child too, the same delete goes through. A race: the child is restricted in a
  transaction still open when the delete starts; the delete waits, then answers 403 with
  the subtree intact.
- A former proposal author (decision 11), with row security on and with it off: Bob
  proposes a change in a node, then the node is restricted without him. The proposal is
  gone from his `GET /proposals`, `GET /proposals/{id}` and its content answer 404, and a
  later event about it (a decision) doesn't reach him. Someone with access there still sees
  it and decides it. Withdrawing: before losing access, Bob, a viewer, withdraws one of his
  open proposals; after, withdrawing another answers 404 and it stays open.
- E2E: restrict a node from Sharing with the preview, see the lock, and see another member
  lose it from their tree.

## Rollout (#267, batch B)

1. This spec (docs only), and the Admin trust model in `workspaces.md` and `SECURITY.md`
   pointing to it.
2. Backend: the migration, the boundary in the three functions, restriction and preview
   routes, the group check, the last-owner check, takeover, `GET /nodes/{id}/access`, contract.
3. Screens: Restrict with its preview, lock marks, Who has access, the Owner and Admin view.

## Open points for review

- **Owners and Admins seeing the name.** This spec shows them the name and who has access,
  so they can manage the workspace and find a node to take over. The stricter option hides
  restricted nodes from them too, and lists only "N restricted nodes" for takeover.
