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

## Who sees what

| | Can open it (a role there) | A grant only below it | Owner or Admin without a role | Other members |
| --- | --- | --- | --- | --- |
| The node in the tree | ✓ with a lock mark | Its name, as the path to what they can open | Its name, with a lock and no file count | ✗ hidden |
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
  `sees_path` also returns true for an Owner or Admin on a restricted node itself (the name
  only: file and Experiment policies use `effective_role`, which doesn't change for them).
- A check on adding group members (in `AccessService.set_member`, and a trigger as the safety
  net) for decision 7.
- A trigger refuses removing the last direct Full access grant on a restricted node
  (decision 6), except when the grant goes with a departing member's other grants.

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
- Turning it on: the preview lists who loses access and through what; keeping someone gives
  them their role there; the caller keeps Full access; refusing it without Full access; agent
  tokens get 403.
- Admins: adding someone to a group with a grant inside a restricted node is refused without
  Full access there, and allowed with it; a sub-group counts; removing members still works;
  an Admin can't take over, an Owner can, and it is audited and shown.
- The last Full access grant on a restricted node can't be revoked.
- `GET /nodes/{id}/access` names each source, and stops at a restricted node.
- E2E: restrict a node from Sharing with the preview, see the lock, and see another member
  lose it from their tree.

## Rollout (#267, batch B)

1. This spec (docs only), and the Admin trust model in `workspaces.md` and `SECURITY.md`
   pointing to it.
2. Backend: the migration, the boundary in the three functions, restriction and preview
   routes, the group check, the last-owner check, takeover, `GET /nodes/{id}/access`, contract.
3. Screens: Restrict with its preview, lock marks, Who has access, the Owner and Admin view.

## Open points for review

- **Keep checkboxes default.** This spec leaves everyone unchecked, so restricting means
  restricting. The other option is everyone checked, which makes the switch safe but easy to
  turn on without changing who can open it.
- **Owners and Admins seeing the name.** This spec shows them the name and who has access,
  so they can manage the workspace and find a node to take over. The stricter option hides
  restricted nodes from them too, and lists only "N restricted nodes" for takeover.
