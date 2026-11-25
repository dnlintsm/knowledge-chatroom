"""What one principal may do with the knowledge tree and access.

Every route goes through here, so access is checked and audited in one place.
A node the principal can't see at all is reported as not found, so its
existence doesn't leak. With row-level security, node queries also run as
the restricted database role for this principal (db.as_user), so Postgres
enforces the same rules if a check here is ever missed.
"""

from __future__ import annotations

import builtins
import re
from collections.abc import AsyncIterator, Collection
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from typing import Any

from psycopg import AsyncConnection

from . import chats, experiments, nodes, proposals, restriction, runs
from .access import (
    AccessError,
    AccessService,
    ForbiddenError,
    Principal,
    Role,
    at_least,
    is_uuid,
    iso,
)
from .db import as_user
from .experiments import ANYWHERE, ExperimentError, ExperimentExistsError, clean_input, same_json
from .files import FileChangedError, FileExistsError_, FileService
from .nodes import NodeError, NodeNotFoundError
from .paths import js_trim, normalize_path
from .proposals import EVERYWHERE, ProposalChangedError, ProposalError
from .run_report import REPORT_PATH, new_report, report_front_matter, with_front_matter
from .storage import Storage

# What a role lets you do, for refusals: "You can only view here; ...".
ROLE_VERB: dict[str, str] = {"viewer": "view", "editor": "edit", "owner": "manage"}
ARCHIVED = "This experiment is archived; restore it to change it"
NOT_WORKER = "Only the experiment's maintainer and collaborators can change it"
ONLY_MAINTAINER = "Only the experiment's maintainer can do this"
CANT_WORK = "They can't view this experiment's node. Share it with them first."
NOT_A_MEMBER = "They aren't a member of this workspace; add them to it first"
# The node name an upload uses for a level its path leaves empty ("Etch/Module 3//").
EMPTY_LEVEL_NAME = "None"
# What an audit target says about content, hidden from a reader who can't see it.
_AUDIT_CONTENT = frozenset({"name", "path", "to", "title", "files", "paths", "inputs", "note"})
# The fields that name the node itself (create, rename), not something in it.
_AUDIT_NODE_NAMES = frozenset({"name", "to"})
# For rerun: no node given, so the earlier run's.
_SAME_PLACE = object()
# For decide: the reviewer didn't say which version of the file they compared with.
NOT_SEEN = object()


def _now() -> str:
    return iso(datetime.now(UTC))  # pyrefly: ignore[bad-return]


class Session:
    def __init__(
        self,
        storage: Storage,
        access: AccessService,
        principal: Principal,
        membership: str | None = None,
    ) -> None:
        self.storage = storage
        self.access = access
        self.principal = principal
        # The principal's role in the workspace (owner, admin, member), checked
        # for this request by workspaces.resolve().
        self.membership = membership

    @property
    def ws(self) -> str:
        return self.storage.workspace_id

    async def role(self, node_id: str | None) -> Role | None:
        return await self.access.role(self.principal.user_id, node_id)

    async def still_member(self) -> bool:
        """
        Whether the principal is still a member of the workspace, and it is
        still active (an open stream rechecks it).
        """
        async with self.storage.pool.connection() as conn:
            cur = await conn.execute(
                """
                SELECT 1 FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id
                WHERE m.workspace_id = %s AND m.user_id = %s AND w.status = 'active'""",
                (self.ws, self.principal.user_id),
            )
            return await cur.fetchone() is not None

    def need_admin(self) -> None:
        """People, groups and the audit log are for the workspace's Owners and Admins."""
        if self.membership not in ("owner", "admin"):
            raise ForbiddenError("Only the workspace's Owners and Admins can do this")

    async def need(self, node_id: str | None, minimum: Role) -> Role:
        role = await self.role(node_id)
        if role is None:
            if node_id is not None:
                raise NodeNotFoundError("Node not found")
            raise ForbiddenError("You have no access to this workspace")
        if not at_least(role, minimum):
            raise ForbiddenError(
                f"You can only {ROLE_VERB[role]} here; this needs {minimum} access"
            )
        return role

    @asynccontextmanager
    async def scoped(self) -> AsyncIterator[AsyncConnection]:
        """One transaction for this principal: as the restricted role when row security is on."""
        if self.storage.row_security:
            async with as_user(self.storage.pool, self.principal.user_id) as conn:
                yield conn
        else:
            async with self.storage.pool.connection() as conn, conn.transaction():
                yield conn

    def _audit(self, action: str, target: dict[str, Any]):
        async def record(conn: AsyncConnection) -> None:
            await self.access.audit(conn, self.principal, action, target)

        return record

    # The knowledge tree

    async def tree(self) -> dict[str, Any]:
        async with self.storage.pool.connection() as conn:
            levels = await nodes.types(conn, self.ws)
        async with self.scoped() as conn:
            every = await nodes.list_nodes(conn, self.ws)
        roles = await self.access.node_roles(self.principal.user_id)
        root_role = await self.role(None)
        by_id = {n["id"]: n for n in every}
        # Visible nodes, plus their ancestors so the path to them can be drawn.
        shown: set[str] = set()
        for node in every:
            # Owners and Admins see restricted nodes they can't open, by name only.
            if not roles.get(node["id"]) and not (self.manages and node["restricted"]):
                continue
            current: dict[str, Any] | None = node
            while current and current["id"] not in shown:
                shown.add(current["id"])
                current = by_id.get(current["parentId"] or "")
        taken = await self._takeovers() if any(n["restricted"] for n in every) else {}
        visible = []
        for node in every:
            if node["id"] not in shown:
                continue
            role = roles.get(node["id"])
            visible.append(
                {
                    **node,
                    "role": role,
                    "fileCount": node["fileCount"] if role else 0,
                    # Shown to everyone who can open it (docs/restricted-knowledge.md, decision 8).
                    "takenOver": taken.get(node["id"]) if role else None,
                }
            )
        return {"types": levels, "rootRole": root_role, "nodes": visible}

    async def _takeovers(self) -> dict[str, dict[str, Any]]:
        """The latest takeover on each restricted node: who, and when."""
        async with self.storage.pool.connection() as conn:
            cur = await conn.execute(
                """
                SELECT DISTINCT ON (g.node_id) g.node_id, u.id, u.name, g.created_at
                FROM grants g
                JOIN nodes n ON n.id = g.node_id AND n.restricted
                JOIN users u ON u.id = g.principal_id
                WHERE g.workspace_id = %s AND g.takeover AND g.principal_type = 'user'
                ORDER BY g.node_id, g.created_at DESC""",
                (self.ws,),
            )
            rows = await cur.fetchall()
        return {
            str(node): {"user": {"id": str(uid), "name": name}, "at": iso(at)}
            for node, uid, name, at in rows
        }

    async def lineage(self, node_id: str) -> list[dict[str, Any]]:
        await self.need(node_id, "viewer")
        async with self.scoped() as conn:
            found = await nodes.lineage(conn, self.ws, node_id)
        if not found:
            raise NodeNotFoundError("Node not found")
        return found

    async def create_node(self, parent_id: str | None, name: str) -> dict[str, Any]:
        await self.need(parent_id, "editor")

        async def in_tx(conn: AsyncConnection, node_id: str) -> None:
            # Whoever adds a node owns it; with row security a trigger does this.
            if not self.storage.row_security:
                await self.access.own_new_node(conn, self.principal.user_id, node_id)
            await self._audit("node.create", {"node": node_id, "parent": parent_id, "name": name})(
                conn
            )

        async with self.scoped() as conn:
            return await nodes.create(conn, self.storage, parent_id, name, in_tx)

    async def rename_node(self, node_id: str, name: str) -> dict[str, Any] | None:
        await self.need(node_id, "editor")
        async with self.scoped() as conn:
            return await nodes.rename(
                conn,
                self.storage,
                node_id,
                name,
                self._audit("node.rename", {"node": node_id, "name": name}),
            )

    async def delete_node(self, node_id: str) -> bool:
        await self.need(node_id, "owner")
        async with self.scoped() as conn:
            return await nodes.remove(
                conn,
                self.storage,
                node_id,
                self._audit("node.delete", {"node": node_id}),
                self.principal.user_id,
            )

    # Restricted nodes (docs/restricted-knowledge.md): turning restriction on or
    # off needs Full access on the node; Owners and Admins also see who can open
    # one, and an Owner can take one over.

    @property
    def manages(self) -> bool:
        return self.membership in ("owner", "admin")

    async def _restricted_or_owned(self, node_id: str) -> None:
        """Full access on the node, or an Owner or Admin who sees it in the tree; else refused as need() does."""
        if (
            self.manages
            and is_uuid(node_id)
            and await self.access.sees_node(self.principal.user_id, node_id)
        ):
            return
        await self.need(node_id, "owner")

    async def node_access(self, node_id: str) -> dict[str, Any]:
        """
        Who can open the node, with their role and every source of it. An Owner
        or Admin without Full access there gets names and roles only.
        """
        await self._restricted_or_owned(node_id)
        full = await self.role(node_id) == "owner"
        async with self.storage.pool.connection() as conn:
            node = await restriction.node_row(conn, self.ws, node_id)
            if node is None:
                raise NodeNotFoundError("Node not found")
            answer = await restriction.explain(conn, self.ws, node, self.principal.user_id)
        if not full:
            answer["people"] = [{**p, "sources": []} for p in answer["people"]]
        return answer

    async def _restriction_answer(
        self, conn: AsyncConnection, node: dict[str, Any]
    ) -> dict[str, Any]:
        """The node's restriction, and what switching it would change."""
        me = self.principal.user_id
        return {
            "nodeId": node["id"],
            "restricted": node["restricted"],
            "restrictedAt": node["restrictedAt"],
            "restrictedBy": node["restrictedBy"],
            "changes": await restriction.changes(conn, self.ws, node, me),
            "groups": await restriction.groups_cut(conn, self.ws, node, me),
        }

    async def restriction(self, node_id: str) -> dict[str, Any]:
        """Whether the node is restricted, and what switching it would change."""
        await self.need(node_id, "owner")
        async with self.storage.pool.connection() as conn:
            node = await restriction.node_row(conn, self.ws, node_id)
            if node is None:
                raise NodeNotFoundError("Node not found")
            return await self._restriction_answer(conn, node)

    async def set_restricted(
        self, node_id: str, restricted: bool, keep: list[tuple[str, str]]
    ) -> dict[str, Any]:
        """
        Restricts the node, keeping the users and groups in `keep` (each at the
        role they had) and the caller (Full access), or lifts it. Audited and
        announced.
        """
        await self.need(node_id, "owner")
        user_id = self.principal.user_id
        async with self.storage.pool.connection() as conn, conn.transaction():
            node = await restriction.node_row(conn, self.ws, node_id, lock=True)
            if node is None:
                raise NodeNotFoundError("Node not found")
            cur = await conn.execute(
                "SELECT path_role(%s, %s, %s::ltree)", (self.ws, user_id, node["path"])
            )
            (role,) = await cur.fetchone()  # pyrefly: ignore[not-iterable]
            if role != "owner":
                raise ForbiddenError("Only someone with Full access can restrict this node")
            if node["restricted"] == restricted:
                return await self._restriction_answer(conn, node)
            changed = await restriction.changes(conn, self.ws, node, user_id)
            if restricted:
                # Who and which groups would lose access: only those can be kept.
                losing = {("user", c["user"]["id"]): c["role"] for c in changed if c["role"]}
                losing |= {
                    ("group", g["group"]["id"]): g["role"]
                    for g in await restriction.groups_cut(conn, self.ws, node, user_id)
                }
                kept = list(dict.fromkeys(k for k in keep if k != ("user", user_id)))
                if any(k not in losing for k in kept):
                    raise AccessError("Only people and groups who would lose access can be kept")
                for (ptype, pid), role in [(k, losing[k]) for k in kept] + [
                    (("user", user_id), "owner")
                ]:
                    await conn.execute(
                        """
                        INSERT INTO grants (workspace_id, node_id, principal_type, principal_id, role, created_by)
                        VALUES (%(ws)s, %(node)s, %(ptype)s, %(pid)s, %(role)s, %(by)s)
                        ON CONFLICT (workspace_id, node_id, principal_type, principal_id)
                        DO UPDATE SET role = CASE WHEN role_rank(EXCLUDED.role) > role_rank(grants.role)
                                                  THEN EXCLUDED.role ELSE grants.role END""",
                        {
                            "ws": self.ws,
                            "node": node_id,
                            "ptype": ptype,
                            "pid": pid,
                            "role": role,
                            "by": user_id,
                        },
                    )
                await conn.execute(
                    "UPDATE nodes SET restricted = true, restricted_at = now(), restricted_by = %s WHERE id = %s",
                    (user_id, node_id),
                )
                # Who can't open it now, once the kept grants are in.
                cur = await conn.execute(
                    "SELECT u FROM unnest(%s::uuid[]) u WHERE path_role(%s, u, %s::ltree) IS NULL",
                    ([c["user"]["id"] for c in changed], self.ws, node["path"]),
                )
                lost = [str(u) for (u,) in await cur.fetchall()]
                await self._audit(
                    "node.restrict",
                    {
                        "node": node_id,
                        "kept": [{"principalType": t, "principalId": i} for t, i in kept],
                        "lost": lost,
                    },
                )(conn)
                await self.storage.notify(
                    conn, {"op": "node", "change": "restrict", "id": node_id, "left": lost}
                )
            else:
                gained = [
                    c["user"]["id"]
                    for c in changed
                    if restriction.rank(c["becomes"]) > restriction.rank(c["role"])
                ]
                await conn.execute(
                    "UPDATE nodes SET restricted = false, restricted_at = NULL, restricted_by = NULL WHERE id = %s",
                    (node_id,),
                )
                await self._audit("node.unrestrict", {"node": node_id, "gained": gained})(conn)
                await self.storage.notify(
                    conn, {"op": "node", "change": "unrestrict", "id": node_id}
                )
            node = await restriction.node_row(conn, self.ws, node_id)
            assert node is not None
            return await self._restriction_answer(conn, node)

    async def take_over(self, node_id: str) -> dict[str, Any]:
        """An Owner gives themselves Full access on a restricted node, audited and shown on it."""
        if self.membership != "owner":
            if self.manages:
                raise ForbiddenError("Only the workspace's Owners can take over a restricted node")
            await self.need(node_id, "owner")
            raise ForbiddenError("Only the workspace's Owners can take over a restricted node")
        if not is_uuid(node_id) or not await self.access.sees_node(self.principal.user_id, node_id):
            raise NodeNotFoundError("Node not found")
        user_id = self.principal.user_id
        async with self.storage.pool.connection() as conn, conn.transaction():
            node = await restriction.node_row(conn, self.ws, node_id, lock=True)
            if node is None:
                raise NodeNotFoundError("Node not found")
            if not node["restricted"]:
                raise AccessError("Only a restricted node can be taken over")
            await conn.execute(
                """
                INSERT INTO grants (workspace_id, node_id, principal_type, principal_id, role, created_by, takeover)
                VALUES (%(ws)s, %(node)s, 'user', %(user)s, 'owner', %(user)s, true)
                ON CONFLICT (workspace_id, node_id, principal_type, principal_id)
                DO UPDATE SET role = 'owner', takeover = true, created_at = now()""",
                {"ws": self.ws, "node": node_id, "user": user_id},
            )
            await self._audit("node.takeover", {"node": node_id})(conn)
            await self.storage.notify(conn, {"op": "node", "change": "takeover", "id": node_id})
            return await restriction.explain(conn, self.ws, node, self.principal.user_id)

    # Experiments: anyone who can view a node (or the workspace root) may start
    # their own experiment there; its maintainer and collaborators change it (see
    # 005_experiments.sql). An experiment with a report.md is a run.

    async def experiments(self, node_id: str | None | object = ANYWHERE) -> list[dict[str, Any]]:
        """Experiments you can see, on one node (None: at the root) or anywhere."""
        if node_id is not ANYWHERE:
            await self.need(node_id, "viewer")  # pyrefly: ignore[bad-argument-type]
        async with self.scoped() as conn:
            return await experiments.list_experiments(
                conn, self.ws, self.principal.user_id, node_id
            )

    async def experiment(self, experiment_id: str) -> dict[str, Any]:
        async with self.scoped() as conn:
            found = await experiments.get(conn, self.ws, self.principal.user_id, experiment_id)
        if not found:
            raise NodeNotFoundError("Experiment not found")
        return found

    async def create_experiment(self, node_id: str | None, given: dict[str, Any]) -> dict[str, Any]:
        await self.need(node_id, "viewer")
        title = {"title": given["title"]} if "title" in given else {}

        async def in_tx(conn: AsyncConnection, new_id: str) -> None:
            await self._audit(
                "experiment.create", {"experiment": new_id, "node": node_id, **title}
            )(conn)

        async with self.scoped() as conn:
            return await experiments.create(
                conn, self.storage, self.principal.user_id, node_id, given, in_tx
            )

    async def upload_experiment(
        self, raw_id: str, path: list[str], given: dict[str, Any], files: list[dict[str, Any]]
    ) -> dict[str, Any]:
        """
        Uploads an experiment made elsewhere (POST /experiments/upload): its id
        (chosen by the caller, so a retry can't make a second copy), the names
        of its place in the tree, one per level, its fields and its files
        ({path, bytes, mime?}). Nodes of the path that don't exist yet are
        added, which needs editor access where the first one goes; an existing
        path needs viewer access, as for create_experiment.

        The experiment starts with only the uploaded files, not a copy of the
        node's. The new nodes, the experiment and its files are written in one
        transaction, so a failure part way leaves nothing behind.
        """
        if not is_uuid(raw_id):
            raise ExperimentError(
                "An experiment id must be a UUID, e.g. 0b8f6c2e-3d1a-4f5b-9c7e-2a4d6e8f0a1b"
            )
        experiment_id = raw_id.lower()
        fields = clean_input(given)
        if not fields.get("title"):
            raise ExperimentError("An experiment needs a title")
        async with self.storage.pool.connection() as conn:
            levels = await nodes.types(conn, self.ws)
        if not levels:
            raise NodeError("No knowledge levels are set up")
        if len(path) != len(levels):
            raise ExperimentError(
                f"The path needs a name for each of the {len(levels)} levels "
                f"({'/'.join(level['name'] for level in levels)}), got {len(path)}; "
                f'leave a name empty for "{EMPTY_LEVEL_NAME}"'
            )
        names = [EMPTY_LEVEL_NAME if js_trim(name) == "" else name for name in path]
        uploads = [{**f, "path": normalize_path(f["path"])} for f in files]
        seen: set[str] = set()
        for f in uploads:
            if f["path"] in seen:
                raise ExperimentError(f"Two files would both be {f['path']}")
            seen.add(f["path"])

        # The part of the path that exists already. Looked up as the server, so
        # a node you can't see is found rather than added twice; need() below
        # then answers "not found" for it, as everywhere else.
        existing: list[dict[str, Any]] = []
        async with self.storage.pool.connection() as conn:
            if await experiments.id_taken(conn, experiment_id):
                raise ExperimentExistsError(experiment_id)
            for name in names:
                node = await nodes.find_child(
                    conn, self.ws, existing[-1]["id"] if existing else None, name
                )
                if not node:
                    break
                existing.append(node)
        missing = names[len(existing) :]
        # Nodes added below one you edit are yours too, so one check covers them all.
        await self.need(existing[-1]["id"] if existing else None, "editor" if missing else "viewer")

        principal = self.principal
        created: list[dict[str, Any]] = []
        written: list[dict[str, Any]] = []
        async with self.scoped() as conn:
            node_id = existing[-1]["id"] if existing else None
            for name in missing:
                node, added = await self._find_or_add_node(conn, node_id, name)
                if added:
                    created.append(node)
                node_id = node["id"]
            target = {
                "experiment": experiment_id,
                "node": node_id,
                "title": fields["title"],
                "files": [f["path"] for f in uploads],
                "upload": True,
            }

            async def in_tx(tx: AsyncConnection, _new_id: str) -> None:
                await self._audit("experiment.create", target)(tx)

            await experiments.create(
                conn,
                self.storage,
                principal.user_id,
                node_id,
                fields,
                in_tx,
                chosen_id=experiment_id,
                fork=False,
                record_run=False,
            )
            service = await FileService(self.storage).in_experiment(conn, experiment_id)
            assert service is not None
            for f in uploads:
                audit = self._audit(
                    "file.write",
                    {"experiment": experiment_id, "path": f["path"], "size": len(f["bytes"])},
                )
                info = await service.write(
                    conn,
                    f["path"],
                    f["bytes"],
                    mime=f.get("mime"),
                    create_only=True,
                    author=principal.actor,
                    author_id=principal.user_id,
                    in_tx=audit,
                )
                written.append(info)
            # One uploaded as finished is Run 1, recorded with the files it came with.
            if fields.get("state") in runs.FINISHED:
                await runs.add_finished(
                    conn,
                    self.ws,
                    experiment_id,
                    principal.user_id,
                    fields.get("params", {}),
                    fields.get("results", {}),
                    fields["state"],
                    {},
                )

        experiment = await self.experiment(experiment_id)
        lineage = await self.lineage(experiment["nodeId"]) if experiment["nodeId"] else []
        return {"experiment": experiment, "lineage": lineage, "created": created, "files": written}

    async def _find_or_add_node(
        self, conn: AsyncConnection, parent_id: str | None, name: str
    ) -> tuple[dict[str, Any], bool]:
        """
        The node `name` below `parent_id`, added when missing. Someone adding the
        same node at the same moment makes the insert fail on the unique name;
        theirs is then used.
        """
        found = await nodes.find_child(conn, self.ws, parent_id, name)
        if found:
            return found, False

        async def in_tx(tx: AsyncConnection, node_id: str) -> None:
            # With row security a trigger makes you its owner (013_node_creator_owns.sql).
            if not self.storage.row_security:
                await self.access.own_new_node(tx, self.principal.user_id, node_id)
            await self._audit("node.create", {"node": node_id, "parent": parent_id, "name": name})(
                tx
            )

        try:
            return await nodes.create(conn, self.storage, parent_id, name, in_tx), True
        except NodeError:
            raced = await nodes.find_child(conn, self.ws, parent_id, name)
            if raced:
                return raced, False
            raise

    async def start_run(
        self,
        node_id: str | None,
        given: dict[str, Any],
        inputs: list[dict[str, Any]] | None = None,
        provenance: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """
        Starts a run for you: a new draft experiment like
        create_experiment's, in state running unless `given` says otherwise,
        with each input file linked in read only under inputs/, and a report.md
        whose front matter holds the run's record. You need to be able to read
        every input. `provenance` is what the caller knows (chat, model, skill,
        tools); who started it, when, and the exact input versions are added here.
        """
        await self.need(node_id, "viewer")
        user_id = self.principal.user_id
        links, recorded = await self._resolve_inputs(inputs or [])
        who = await self.access.user(user_id)
        name = None if who is None else who["name"] if who["name"] is not None else who["email"]
        record = {**(provenance or {}), "startedBy": {"id": user_id, "name": name}, "startedAt": _now(),
                  "inputs": recorded}  # fmt: skip
        fields = {**given, "state": given["state"] if given.get("state") is not None else "running"}
        title = {"title": given["title"]} if "title" in given else {}

        async def in_tx(conn: AsyncConnection, new_id: str) -> None:
            target = {
                "experiment": new_id,
                "node": node_id,
                **title,
                "inputs": [link["path"] for link in links],
            }
            await self._audit("experiment.create", target)(conn)

        async with self.scoped() as conn:
            run = await experiments.create(
                conn, self.storage, user_id, node_id, fields, in_tx, inputs=links, provenance=record
            )
        files = await self.experiment_files(run["id"])
        if not await files.stat(REPORT_PATH):
            await files.write(REPORT_PATH, new_report(run).encode())
        return await self.experiment(run["id"])

    async def _inputs_still_there(self, experiment_id: str, before: Any) -> list[dict[str, Any]]:
        """
        The inputs an earlier Run linked under inputs/ that are still there,
        recorded at their versions now: a new Run reads them as they are.
        """
        if not isinstance(before, list) or not before:
            return []
        files = await self.experiment_files(experiment_id)
        kept: list[dict[str, Any]] = []
        for entry in before:
            if not isinstance(entry, dict) or not isinstance(entry.get("path"), str):
                continue
            versions = await files.history(entry["path"]) or []
            if versions:
                now = versions[0]
                kept.append(
                    {**entry, "version": now["id"], "sha256": now["sha256"], "size": now["size"]}
                )
        return kept

    async def _resolve_inputs(
        self, inputs: list[dict[str, Any]], taken: list[Any] | None = None
    ) -> tuple[list[dict[str, str]], list[dict[str, Any]]]:
        """
        Each input's version to copy under inputs/, and what the run's provenance
        records about it: its current version, or for a pinned input (a rerun's,
        with "sha256") the version of it with the recorded content. `taken` are
        inputs/ paths the run already has.
        """
        links: list[dict[str, str]] = []
        recorded: list[dict[str, Any]] = []
        for source in inputs:
            origin = normalize_path(source["path"])
            place = (
                await self.experiment_files(source["experiment"])
                if source.get("experiment")
                else await self.files(source.get("node"))
            )
            versions = await place.history(origin) or []
            pinned = source.get("sha256")
            if pinned:
                current = next((v for v in versions if v["sha256"] == pinned), None)
            else:
                current = versions[0] if versions else None
            if not current and pinned and versions:
                raise ExperimentError(
                    f"{origin} in the earlier experiment no longer has the content it ran with; "
                    "pass inputs to rerun with other files or their current versions"
                )
            if not current:
                raise ExperimentError(
                    f"{origin} of the earlier experiment is gone; pass inputs to rerun with other files"
                    if pinned
                    else f"No file at {origin} to use as an input"
                )
            name = source["as"] if source.get("as") is not None else origin.split("/")[-1]
            path = normalize_path(f"inputs/{name}")
            if path in (taken or []):
                raise ExperimentError(
                    f"The run already has an input at {path}; give this one another name"
                )
            if any(link["path"] == path for link in links):
                raise ExperimentError(
                    f"Two inputs would both be {path}; give one of them another name"
                )
            links.append({"path": path, "versionId": current["id"]})
            recorded.append(
                {
                    "path": path,
                    "from": {
                        "node": place.node_id,
                        "experiment": place.experiment_id,
                        "path": origin,
                    },
                    "version": current["id"],
                    "sha256": current["sha256"],
                    "size": current["size"],
                }
            )
        return links, recorded

    async def add_run_inputs(
        self, experiment_id: str, inputs: list[dict[str, Any]]
    ) -> dict[str, Any]:
        """
        Adds input files to an existing run or experiment: each is
        linked in read only under inputs/ at its current version and appended to
        the inputs its provenance records, so a rerun reads them too. Only its
        maintainer and collaborators can, while it isn't archived; a finished
        run stays as it ended.
        """
        current = await self.experiment(experiment_id)
        self._need_worker(current)
        if current["status"] == "archived":
            raise ForbiddenError(ARCHIVED)
        if current["state"] in ("done", "failed"):
            raise ExperimentError(
                f"This run already finished ({current['state']}); start a new run to add inputs"
            )
        if not inputs:
            raise ExperimentError("Name at least one file to add as an input")
        before = current["provenance"].get("inputs")
        taken = [
            i.get("path") if isinstance(i, dict) else None
            for i in (before if before is not None else [])
        ]
        links, recorded = await self._resolve_inputs(inputs, taken)
        audit = self._audit(
            "experiment.inputs", {"experiment": experiment_id, "inputs": [x["path"] for x in links]}
        )
        async with self.scoped() as conn:
            await experiments.add_inputs(conn, self.storage, experiment_id, links, recorded, audit)
        run = await self.experiment(experiment_id)
        await self._refresh_report(run)
        return run

    async def rerun(
        self,
        experiment_id: str,
        given: dict[str, Any],
        inputs: list[dict[str, Any]] | None = None,
        node_id: str | None | object = _SAME_PLACE,
        provenance: dict[str, Any] | None = None,
        run: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """
        Runs an experiment again as a new experiment of yours: same place,
        parameters, hypothesis and inputs unless told otherwise. The inputs
        are read from the old run's inputs/ at the content its record names,
        even if someone edited them since; `inputs` instead reads those files
        at their current versions. `run` is the Run to rerun, else the
        experiment's latest. The old run stays as it is; the new one's
        provenance names it. You need to be able to see the old run.
        """
        old = await self.experiment(experiment_id)
        if run is None:
            async with self.scoped() as conn:
                run = await runs.latest(conn, self.ws, experiment_id)
        ran = run["provenance"] if run is not None else old["provenance"]
        pinned: list[dict[str, Any]] = []
        if inputs is None:
            found = ran.get("inputs")
            for item in found if found is not None else []:
                sha256 = item.get("sha256")
                if not isinstance(sha256, str) or not sha256:
                    raise ExperimentError(
                        f"The earlier experiment's record doesn't say what {item['path']} held; "
                        "pass inputs to rerun with chosen files"
                    )
                path = item["path"]
                pinned.append(
                    {
                        "path": path,
                        "experiment": old["id"],
                        "as": re.sub(r"^inputs/", "", path),
                        "sha256": sha256,
                    }
                )

        def given_or(key: str, fallback: Any) -> Any:
            return given[key] if given.get(key) is not None else fallback

        return await self.start_run(
            old["nodeId"] if node_id is _SAME_PLACE else node_id,  # pyrefly: ignore[bad-argument-type]
            {
                "title": given_or("title", f"{old['title']} (rerun)"),
                "hypothesis": given_or("hypothesis", old["hypothesis"]),
                "params": given_or("params", run["params"] if run is not None else old["params"]),
            },
            inputs if inputs is not None else pinned,
            # Only ids: the old run may be a draft that viewers of this one can't see.
            {
                **(provenance or {}),
                "rerunOf": {"id": old["id"], **({"run": run["id"]} if run is not None else {})},
            },
        )

    async def finish_run(
        self, experiment_id: str, results: dict[str, Any], state: str
    ) -> dict[str, Any]:
        """
        Records a run's results and how it ended (done or failed), and refreshes
        the record in its report.md (creating the report if it has none). A
        finished run stays as it ended: the same call again changes nothing,
        and a different one is refused. Its maintainer and collaborators can.
        """
        current = await self.experiment(experiment_id)
        self._need_worker(current)
        if current["status"] == "archived":
            raise ForbiddenError(ARCHIVED)
        if current["state"] in ("done", "failed"):
            if current["state"] == state and same_json(current["results"], results):
                return current
            raise ExperimentError(
                f"This run already finished ({current['state']}); start a new run to try again"
            )
        audit = self._audit(
            "experiment.update", {"experiment": experiment_id, "fields": ["results", "state"]}
        )
        # Ending it records finishedAt and the evidence (experiments.update).
        async with self.scoped() as conn:
            await experiments.update(
                conn, self.storage, experiment_id, {"results": results, "state": state}, audit
            )
        run = await self.experiment(experiment_id)
        await self._refresh_report(run, create=True)
        return run

    async def run_reads(self, experiment_id: str) -> list[dict[str, Any]]:
        """What agents read of the run's recorded files while it ran; for whoever can see it."""
        await self.experiment(experiment_id)
        async with self.scoped() as conn:
            return await experiments.reads(conn, self.ws, experiment_id)

    # Runs (docs/experiment-runs.md): whoever sees an Experiment sees its Runs;
    # its maintainer and collaborators start, finish, archive, delete and
    # restore them while it isn't archived. Claude starts and finishes Runs but
    # doesn't archive, delete or restore them.

    async def runs(
        self, experiment_id: str, *, archived: bool = False, deleted: bool = False
    ) -> list[dict[str, Any]]:
        """An Experiment's Runs, newest first; its deleted ones for whoever works on it."""
        experiment = await self.experiment(experiment_id)
        if deleted:
            self._need_person_runs("list")
            self._need_worker(experiment)
        async with self.scoped() as conn:
            return await runs.list_runs(
                conn, self.ws, experiment_id, archived=archived, deleted=deleted
            )

    async def run(self, run_id: str, *, deleted: bool = False) -> dict[str, Any]:
        """One Run with its file record, for whoever can see its Experiment."""
        async with self.scoped() as conn:
            found = await runs.get(conn, self.ws, run_id, deleted=deleted)
        if found is None:
            raise NodeNotFoundError("Run not found")
        try:
            await self.experiment(found["experimentId"])
        except NodeNotFoundError:
            raise NodeNotFoundError("Run not found") from None
        return found

    async def _run_and_experiment(
        self, run_id: str, *, deleted: bool = False
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        """A Run you can change, and its Experiment: you work on it, and it isn't archived."""
        found = await self.run(run_id, deleted=deleted)
        experiment = await self.experiment(found["experimentId"])
        self._need_worker(experiment)
        if experiment["status"] == "archived":
            raise ForbiddenError(ARCHIVED)
        return found, experiment

    async def start_run_in(
        self,
        experiment_id: str,
        *,
        params: dict[str, Any] | None = None,
        label: str = "",
        inputs: list[dict[str, Any]] | None = None,
        provenance: dict[str, Any] | None = None,
        rerun_of: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """
        Starts another Run of an Experiment you work on, with its planned
        parameters unless `params` says otherwise. `inputs` are linked into its
        files under inputs/ as for a new run. 409 while one is running.
        """
        experiment = await self.experiment(experiment_id)
        self._need_worker(experiment)
        if experiment["status"] == "archived":
            raise ForbiddenError(ARCHIVED)
        before = experiment["provenance"].get("inputs")
        taken = [i.get("path") if isinstance(i, dict) else None for i in before or []]
        links, recorded = await self._resolve_inputs(inputs or [], taken)
        recorded = await self._inputs_still_there(experiment_id, before) + recorded
        user_id = self.principal.user_id
        who = await self.access.user(user_id)
        name = None if who is None else who["name"] if who["name"] is not None else who["email"]
        record = {**(provenance or {}), "startedBy": {"id": user_id, "name": name},
                  "startedAt": _now(), "inputs": recorded}  # fmt: skip
        if rerun_of is not None:
            record["rerunOf"] = rerun_of
        async with self.scoped() as conn, conn.transaction():
            await experiments.lock_live_experiment(conn, self.ws, experiment_id, update=True)
            # Results typed in before anything ran are kept as Run 1, not
            # replaced by the new Run's.
            if experiment["results"] and not await runs.ever_ran(conn, experiment_id):
                await runs.add_finished(
                    conn,
                    self.ws,
                    experiment_id,
                    experiment["maintainerId"],
                    experiment["params"],
                    experiment["results"],
                    "done",
                    experiment["provenance"],
                    label=runs.BY_HAND,
                )
            if links:
                await experiments.link_inputs(conn, self.ws, experiment_id, links)
            run_id = await runs.start(
                conn,
                self.ws,
                experiment_id,
                user_id,
                params=experiment["params"] if params is None else params,
                provenance=record,
                label=label,
            )
            await self._audit(
                "run.start",
                {"experiment": experiment_id, "run": run_id, "inputs": [x["path"] for x in links]},
            )(conn)
            await runs.notify(conn, self.storage, "create", run_id, experiment_id)
        await self._refresh_report(await self.experiment(experiment_id))
        return await self.run(run_id)

    async def finish_run_by_id(
        self, run_id: str, results: dict[str, Any], state: str
    ) -> dict[str, Any]:
        """Ends a running Run (finish_run). The same finish again changes nothing; another is refused."""
        found = await self.run(run_id)
        if found["state"] in runs.FINISHED:
            experiment = await self.experiment(found["experimentId"])
            self._need_worker(experiment)
            if found["state"] == state and same_json(found["results"], results):
                return found
            raise ExperimentError(
                f"This run already finished ({found['state']}); start a new run to try again"
            )
        await self.finish_run(found["experimentId"], results, state)
        return await self.run(run_id)

    async def rerun_run(self, run_id: str, into_same: bool) -> dict[str, Any]:
        """
        Reruns a Run: as another Run of the same Experiment (you work on it),
        or as Run 1 of a new Experiment of yours. The new Run's provenance names
        the one it reran. Answers the new Run.
        """
        found = await self.run(run_id)
        rerun_of = {"id": found["experimentId"], "run": found["id"]}
        if into_same:
            return await self.start_run_in(
                found["experimentId"],
                params=found["params"],
                label=found["label"],
                rerun_of=rerun_of,
            )
        made = await self.rerun(found["experimentId"], {}, run=found)
        async with self.scoped() as conn:
            newest = await runs.latest(conn, self.ws, made["id"])
        assert newest is not None
        return newest

    async def update_run(self, run_id: str, fields: dict[str, Any]) -> dict[str, Any]:
        """Its label, or archiving it; archiving is the user's call, not Claude's."""
        if "archived" in fields and self.principal.actor == "agent":
            raise ForbiddenError("Claude doesn't archive runs")
        found, experiment = await self._run_and_experiment(run_id)
        action = "run.archive" if fields.get("archived") else "run.update"
        async with self.scoped() as conn, conn.transaction():
            await runs.set_fields(conn, self.ws, run_id, fields)
            await self._audit(
                action, {"experiment": experiment["id"], "run": run_id, "fields": list(fields)}
            )(conn)
            change = "archive" if "archived" in fields else "update"
            await runs.notify(conn, self.storage, change, run_id, experiment["id"])
        return await self.run(run_id)

    def _need_person_runs(self, what: str) -> None:
        if self.principal.actor == "agent":
            raise ForbiddenError(f"Claude doesn't {what} runs")

    async def delete_run(self, run_id: str) -> bool:
        """Soft-deletes a finished Run; Undo or Recently deleted brings it back."""
        self._need_person_runs("delete")
        _found, experiment = await self._run_and_experiment(run_id)
        async with self.scoped() as conn, conn.transaction():
            gone = await runs.remove(conn, self.ws, run_id, self.principal.user_id)
            if gone is None:
                return False
            await self._audit("run.delete", {"experiment": experiment["id"], "run": run_id})(conn)
            await runs.notify(conn, self.storage, "delete", run_id, experiment["id"])
        await self._refresh_report(await self.experiment(experiment["id"]))
        return True

    async def restore_run(self, run_id: str) -> dict[str, Any]:
        """Undoes a Run's delete."""
        self._need_person_runs("restore")
        _found, experiment = await self._run_and_experiment(run_id, deleted=True)
        async with self.scoped() as conn, conn.transaction():
            back = await runs.restore(conn, self.ws, run_id)
            if back is None:
                raise NodeNotFoundError("Run not found")
            await self._audit("run.restore", {"experiment": experiment["id"], "run": run_id})(conn)
            await runs.notify(conn, self.storage, "restore", run_id, experiment["id"])
        await self._refresh_report(await self.experiment(experiment["id"]))
        return await self.run(run_id)

    async def reads_of_run(self, run_id: str) -> list[dict[str, Any]]:
        """What agents read of the Run's recorded files while it ran."""
        await self.run(run_id)
        async with self.scoped() as conn:
            return await runs.reads(conn, self.ws, run_id)

    async def run_file(self, run_id: str, path: str) -> tuple[dict[str, Any], bytes]:
        """A file as the Run recorded it, with the checks of reading its Experiment's files."""
        found = await self.run(run_id)
        wanted = normalize_path(path)
        entry = next((f for f in found.get("record") or [] if f["path"] == wanted), None)
        if entry is None:
            raise NodeNotFoundError(f"The run's record has no {wanted}")
        files = await self.experiment_files(found["experimentId"])
        read = await files.read(wanted, entry["version"])
        if read is None:
            raise NodeNotFoundError(f"{wanted} as the run recorded it can't be read any more")
        return read

    async def compare_runs(
        self,
        node_id: str | None | object = ANYWHERE,
        *,
        descendants: bool = False,
        experiment_id: str | None = None,
        archived: bool = False,
    ) -> list[dict[str, Any]]:
        """Runs to compare: of one Experiment, on a node (and below, with `descendants`), or anywhere you can see."""
        node_ids: list[str | None] | None = None
        if node_id is not ANYWHERE:
            await self.need(node_id, "viewer")  # pyrefly: ignore[bad-argument-type]
            here: list[str | None] = [node_id]  # pyrefly: ignore[bad-assignment]
            node_ids = here
            if descendants:
                async with self.scoped() as conn:
                    cur = await conn.execute(
                        """
                        SELECT d.id FROM nodes d
                        WHERE d.workspace_id = %(ws)s AND d.deleted_at IS NULL
                          AND (%(node)s::uuid IS NULL OR (d.id <> %(node)s::uuid AND d.path <@ (
                                SELECT path FROM nodes WHERE id = %(node)s::uuid AND workspace_id = %(ws)s)))""",
                        {"ws": self.ws, "node": node_id},
                    )
                    here += [str(row[0]) for row in await cur.fetchall()]
        async with self.scoped() as conn:
            return await runs.compare(
                conn,
                self.ws,
                self.principal.user_id,
                node_ids=node_ids,
                experiment_id=experiment_id,
                archived=archived,
            )

    async def _refresh_report(self, run: dict[str, Any], create: bool = False) -> None:
        """
        Brings the record in a run's report.md front matter up to date, for runs
        Claude started (they have provenance). Makes the report when `create`
        is set and there is none. Archived runs are read only.
        """
        if not run["provenance"].get("startedAt") or run["status"] == "archived":
            return
        files = await self.experiment_files(run["id"])
        report = await files.read(REPORT_PATH)
        if not report and not create:
            return
        # As TextDecoder reads it: a leading byte order mark dropped, bad bytes replaced.
        before = (
            report[1].decode("utf-8-sig", errors="replace") if report else f"# {run['title']}\n"
        )
        after = with_front_matter(before, report_front_matter(run))
        if after != before:
            await files.write(REPORT_PATH, after.encode())

    async def update_experiment(self, experiment_id: str, given: dict[str, Any]) -> dict[str, Any]:
        """
        Its maintainer and collaborators edit it; only the maintainer changes its
        status (shares, archives or restores it). Archived experiments are read
        only, apart from changing the status back.
        """
        current = await self.experiment(experiment_id)
        self._need_worker(current)
        if "status" in given and given["status"] != current["status"]:
            self._need_maintainer(current)
        archived = current["status"] == "archived" and given.get("status", "archived") == "archived"
        if archived and any(key != "status" for key in given):
            raise ForbiddenError(ARCHIVED)
        audit = self._audit(
            "experiment.update", {"experiment": experiment_id, "fields": list(given)}
        )
        async with self.scoped() as conn:
            await experiments.update(conn, self.storage, experiment_id, given, audit)
        # The report's record follows edits made after the run started.
        updated = await self.experiment(experiment_id)
        await self._refresh_report(updated)
        return updated

    async def delete_experiment(self, experiment_id: str) -> bool:
        self._need_maintainer(await self.experiment(experiment_id))
        async with self.scoped() as conn:
            return await experiments.remove(
                conn,
                self.storage,
                experiment_id,
                self._audit("experiment.delete", {"experiment": experiment_id}),
                self.principal.user_id,
            )

    def _need_person(self, what: str) -> None:
        """Claude never deletes experiments, so it doesn't list or restore deleted ones either."""
        if self.principal.actor == "agent":
            raise ForbiddenError(f"Claude doesn't {what} deleted experiments")

    async def deleted_experiments(self) -> list[dict[str, Any]]:
        """
        The deleted experiments you may restore (docs/run-evidence.md): your own,
        and as an Owner or Admin the shared and archived ones too.
        """
        self._need_person("list")
        async with self.scoped() as conn:
            return await experiments.list_deleted(conn, self.ws, self.principal.user_id)

    async def restore_experiment(self, experiment_id: str) -> dict[str, Any]:
        """
        Undoes a delete, with the files deleted with it, keeping its status and
        state. One you may not restore is reported as not found; one whose node
        was deleted can't be restored (409). A departed maintainer's goes to the
        Owner or Admin restoring it, and the audit names both.
        """
        self._need_person("restore")

        async def audit(conn: AsyncConnection, handed_from: str | None) -> None:
            target = {"experiment": experiment_id}
            if handed_from:
                target |= {"from": handed_from, "user": self.principal.user_id}
            await self._audit("experiment.restore", target)(conn)

        async with self.scoped() as conn:
            restored = await experiments.restore(
                conn, self.storage, self.principal.user_id, experiment_id, audit
            )
        if not restored:
            raise NodeNotFoundError("Experiment not found")
        return await self.experiment(experiment_id)

    def _works_on(self, experiment: dict[str, Any]) -> bool:
        """Whether the principal is its maintainer or a collaborator."""
        user = self.principal.user_id
        return experiment["mine"] or any(c["id"] == user for c in experiment["collaborators"])

    def _need_worker(self, experiment: dict[str, Any]) -> None:
        if not self._works_on(experiment):
            raise ForbiddenError(NOT_WORKER)

    @staticmethod
    def _need_maintainer(experiment: dict[str, Any]) -> None:
        if not experiment["mine"]:
            raise ForbiddenError(ONLY_MAINTAINER)

    async def _need_can_work(self, experiment: dict[str, Any], user_id: str) -> None:
        """A collaborator or new maintainer: a member who can view the experiment's node."""
        ok = False
        if is_uuid(user_id):
            async with self.storage.pool.connection() as conn:
                cur = await conn.execute(
                    "SELECT workspace_member(%(ws)s, %(user)s) AND effective_role(%(ws)s, %(user)s, %(node)s) IS NOT NULL",
                    {"ws": self.ws, "user": user_id, "node": experiment["nodeId"]},
                )
                row = await cur.fetchone()
                ok = bool(row and row[0])
        if not ok:
            raise ExperimentError(CANT_WORK)

    async def set_collaborator(self, experiment_id: str, user_id: str, add: bool) -> bool:
        """
        Adds or removes a collaborator (docs/workspaces.md, "Experiment handover"):
        the maintainer adds members who can view the node and removes anyone; a
        collaborator removes themselves. Whether anything changed.
        """
        current = await self.experiment(experiment_id)
        user_id = user_id.lower()
        if add:
            self._need_maintainer(current)
            if user_id == current["maintainerId"]:
                raise ExperimentError("They maintain this experiment already")
            await self._need_can_work(current, user_id)
        else:
            if user_id != self.principal.user_id:
                self._need_maintainer(current)
            if not is_uuid(user_id):
                return False
        action = "experiment.collaborator.add" if add else "experiment.collaborator.remove"
        async with self.scoped() as conn:
            if add:
                if not await _lock_member(conn, self.ws, user_id):
                    raise ExperimentError(NOT_A_MEMBER)
                cur = await conn.execute(
                    """
                    INSERT INTO experiment_collaborators (experiment_id, user_id, added_by)
                    VALUES (%s, %s, %s) ON CONFLICT DO NOTHING""",
                    (experiment_id, user_id, self.principal.user_id),
                )
            else:
                cur = await conn.execute(
                    "DELETE FROM experiment_collaborators WHERE experiment_id = %s AND user_id = %s",
                    (experiment_id, user_id),
                )
            changed = cur.rowcount > 0
            if changed:
                await self._audit(action, {"experiment": experiment_id, "user": user_id})(conn)
                await self.storage.notify(
                    conn,
                    {
                        "op": "experiment",
                        "change": "update",
                        "id": experiment_id,
                        "node": current["nodeId"],
                        **({} if add else {"left": [user_id]}),
                    },
                )
        return changed

    async def hand_over(
        self, experiment_id: str, user_id: str, keep: bool = True
    ) -> dict[str, Any] | None:
        """
        Makes someone else its maintainer: the maintainer can, and an Owner or
        Admin for one that isn't a draft. The new maintainer must be a member
        who can view the node. The previous one stays on as a collaborator when
        `keep`, but only while they are still a member.
        """
        current = await self.experiment(experiment_id)
        manages = self.membership in ("owner", "admin") and current["status"] != "draft"
        if not current["mine"] and not manages:
            raise ForbiddenError(
                "Only the experiment's maintainer can hand it over (an Owner or Admin can, once it is shared)"
            )
        user_id = user_id.lower()
        previous = current["maintainerId"]
        if user_id == previous:
            return current
        await self._need_can_work(current, user_id)
        async with self.scoped() as conn:
            if not await _lock_member(conn, self.ws, user_id):
                raise ExperimentError(NOT_A_MEMBER)
            # The previous maintainer stays on only while still a member.
            kept = keep and await _lock_member(conn, self.ws, previous)
            if kept:
                await conn.execute(
                    """
                    INSERT INTO experiment_collaborators (experiment_id, user_id, added_by)
                    VALUES (%s, %s, %s) ON CONFLICT DO NOTHING""",
                    (experiment_id, previous, self.principal.user_id),
                )
            await conn.execute(
                "DELETE FROM experiment_collaborators WHERE experiment_id = %s AND user_id = %s",
                (experiment_id, user_id),
            )
            await conn.execute(
                "UPDATE experiments SET maintainer_id = %s, updated_at = now() WHERE id = %s",
                (user_id, experiment_id),
            )
            await self._audit(
                "experiment.maintainer",
                {"experiment": experiment_id, "from": previous, "user": user_id},
            )(conn)
            await self.storage.notify(
                conn,
                {
                    "op": "experiment",
                    "change": "update",
                    "id": experiment_id,
                    "node": current["nodeId"],
                    **({} if kept else {"left": [previous]}),
                },
            )
        return await self.experiment_if_visible(experiment_id)

    async def experiment_if_visible(self, experiment_id: str) -> dict[str, Any] | None:
        """The experiment, or None once the caller can't see it (say, a draft they handed over)."""
        async with self.scoped() as conn:
            return await experiments.get(conn, self.ws, self.principal.user_id, experiment_id)

    # Files

    async def files(self, node_id: str | None) -> FilesSession:
        """Files at the workspace root (None) or in a node."""
        role = await self.need(node_id, "viewer")
        async with self.storage.pool.connection() as conn:
            service = await FileService(self.storage).in_node(conn, node_id)
        if not service:
            raise NodeNotFoundError("Node not found")
        return FilesSession(self, service, role)

    async def experiment_files(self, experiment_id: str) -> FilesSession:
        """An experiment's files: its maintainer and collaborators edit them, others who may see it read them."""
        access = await self.access.experiment_access(self.principal.user_id, experiment_id)
        service = None
        if access:
            async with self.storage.pool.connection() as conn:
                service = await FileService(self.storage).in_experiment(conn, experiment_id)
        if not service:
            raise NodeNotFoundError("Experiment not found")
        return FilesSession(self, service, "editor" if access == "writer" else "viewer")

    # Proposed versions (see proposals.py): anyone who can read a place may
    # propose a change to its files, and editors there accept or reject it.

    async def proposals(
        self,
        *,
        node: str | None | object = EVERYWHERE,
        experiment: str | None = None,
        status: str = "open",
        limit: int = 200,
    ) -> list[dict[str, Any]]:
        """Proposals you can see: on places you can read, and your own."""
        async with self.scoped() as conn:
            return await proposals.list_proposals(
                conn,
                self.ws,
                self.principal.user_id,
                node=node,
                experiment=experiment,
                status=status,
                limit=limit,
            )

    async def proposal(self, proposal_id: str) -> dict[str, Any]:
        async with self.scoped() as conn:
            found = await proposals.get(conn, self.ws, self.principal.user_id, proposal_id)
        if not found:
            raise NodeNotFoundError("Proposal not found")
        return found

    async def proposal_content(self, proposal_id: str) -> tuple[dict[str, Any], bytes]:
        """A proposal and its proposed bytes."""
        proposal = await self.proposal(proposal_id)
        return proposal, await self.storage.blobs.get(proposal["sha256"])

    async def propose(
        self,
        node_id: str | None,
        path: str,
        data: bytes,
        *,
        mime: str | None = None,
        note: str | None = None,
    ) -> dict[str, Any]:
        """Proposes new content for a file at the root (None) or in a node; returns the proposal."""
        await self.need(node_id, "viewer")
        principal = self.principal

        async def in_tx(conn: AsyncConnection, proposal_id: str) -> None:
            await self._audit(
                "proposal.create", {"proposal": proposal_id, "node": node_id, "path": path}
            )(conn)

        # The upload first, while no connection is held for it.
        await proposals.store(self.storage, path, data, mime)
        async with self.scoped() as conn:
            proposal_id = await proposals.propose(
                conn,
                self.storage,
                node=node_id,
                path=path,
                content=data,
                mime=mime,
                author=principal.actor,
                author_id=principal.user_id,
                note=note,
                in_tx=in_tx,
                stored=True,
            )
        return await self.proposal(proposal_id)

    async def promotable(self, experiment_id: str) -> list[dict[str, Any]]:
        """What promoting an experiment would propose to its node."""
        await self.experiment(experiment_id)
        async with self.scoped() as conn:
            return await proposals.promotable(conn, self.ws, experiment_id)

    async def promote(
        self, experiment_id: str, paths: list[str] | None = None, note: str | None = None
    ) -> list[dict[str, Any]]:
        """
        Proposes an experiment's changed files (all of them, or those in `paths`)
        to its node, for someone who can edit there to accept. Its maintainer
        and collaborators promote it, and not once it is archived.
        """
        experiment = await self.experiment(experiment_id)
        self._need_worker(experiment)
        if experiment["access"] != "writer":
            raise ForbiddenError("This experiment is archived; restore it to propose its files")
        candidates = await self.promotable(experiment_id)
        chosen = [c for c in candidates if c["path"] in paths] if paths is not None else candidates
        missing = [p for p in paths or [] if not any(c["path"] == p for c in candidates)]
        if missing:
            raise ProposalError(
                f"Nothing to propose for {', '.join(missing)}: "
                "the experiment didn't change it, or its node already has it"
            )
        if not chosen:
            raise ProposalError("This experiment has no changes its node doesn't have")
        principal = self.principal
        node_id = experiment["nodeId"]
        ids: list[str] = []
        for candidate in chosen:
            path = candidate["path"]

            async def in_tx(conn: AsyncConnection, proposal_id: str, path: str = path) -> None:
                target = {
                    "proposal": proposal_id,
                    "node": node_id,
                    "path": path,
                    "experiment": experiment_id,
                }
                await self._audit("proposal.create", target)(conn)

            async with self.scoped() as conn:
                file = await proposals.experiment_file(conn, self.ws, experiment_id, path)
                if not file:
                    raise ProposalError(f"{path} is no longer in this experiment")
                proposal_id = await proposals.propose(
                    conn,
                    self.storage,
                    node=node_id,
                    path=path,
                    content=file,
                    mime=file["mime"],
                    author=principal.actor,
                    author_id=principal.user_id,
                    experiment_id=experiment_id,
                    note=note,
                    in_tx=in_tx,
                )
            ids.append(proposal_id)
        return [await self.proposal(proposal_id) for proposal_id in ids]

    async def decide(
        self,
        proposal_id: str,
        decision: str,
        *,
        seen: str | None = None,
        base: str | None | object = NOT_SEEN,
    ) -> dict[str, Any]:
        """
        Accepts (writes it as the file's next version, credited to its proposer),
        rejects, or withdraws a proposal. Accepting and rejecting need editor on
        its place; withdrawing is for its proposer.

        An accept can say what its reviewer looked at: `seen`, the proposed
        content's sha256, and `base`, the sha256 of the file it was compared with
        (None: there was no file). ProposalChangedError when either is another
        one by now, so nobody accepts content, or replaces a file, they haven't seen.
        """
        proposal = await self.proposal(proposal_id)
        if proposal["status"] != "open":
            raise ProposalError(f"This proposal was already {proposal['status']}")
        if decision == "accept" and seen is not None and seen != proposal["sha256"]:
            raise ProposalChangedError(proposals.REVISED)
        if decision == "withdraw":
            if not proposal["mine"]:
                raise ForbiddenError("Only its proposer can withdraw a proposal")
        else:
            await self.need(proposal["node"], "editor")
        user_id = self.principal.user_id
        target = {"proposal": proposal_id, "node": proposal["node"], "path": proposal["path"]}
        audit = self._audit(f"proposal.{decision}", target)
        if decision != "accept":
            async with self.scoped() as conn:
                await proposals.decide(conn, self.storage, proposal_id, decision, user_id, audit)
            return await self.proposal(proposal_id)
        async with self.storage.pool.connection() as conn:
            files = await FileService(self.storage).in_node(conn, proposal["node"])
        if not files:
            raise NodeNotFoundError("Node not found")
        data = await self.storage.blobs.get(proposal["sha256"])
        decided = False

        # The bytes written are the ones read above: a revision since then is refused.
        written = proposal["sha256"]

        async def in_tx(tx: AsyncConnection) -> None:
            nonlocal decided
            await proposals.decide_in(
                tx, self.storage, proposal_id, "accept", user_id, sha256=written
            )
            await audit(tx)
            decided = True

        path = proposal["path"]
        try:
            async with self.scoped() as conn:
                await files.write(
                    conn,
                    path,
                    data,
                    mime=proposal["mime"],
                    author=proposal["author"],
                    author_id=proposal["authorId"],
                    in_tx=in_tx,
                    create_only=base is None,
                    if_match=[base] if isinstance(base, str) else None,
                    # The proposal's blob: read from the store just above.
                    stored=True,
                )
                # The file already had these bytes, so no version was added.
                if not decided:
                    await proposals.decide(
                        conn, self.storage, proposal_id, "accept", user_id, audit, sha256=written
                    )
        except (FileChangedError, FileExistsError_) as err:
            raise ProposalChangedError(
                f"{path} changed after you opened this proposal; look at it again before accepting"
            ) from err
        return await self.proposal(proposal_id)

    # Chat history: the principal's own, whatever their role (chats.py)

    async def chats(self, **options: Any) -> dict[str, Any]:
        async with self.scoped() as conn:
            return await chats.list_chats(conn, self.ws, self.principal.user_id, **options)

    async def chat(self, chat_id: str) -> dict[str, Any] | None:
        async with self.scoped() as conn:
            return await chats.get_chat(conn, self.ws, self.principal.user_id, chat_id)

    async def chat_runs(self, chat_id: str) -> list[dict[str, Any]] | None:
        async with self.scoped() as conn:
            return await chats.chat_runs(conn, self.ws, self.principal.user_id, chat_id)

    async def append_chat_run(self, chat_id: str, run: dict[str, Any]) -> dict[str, Any]:
        if not chats.valid_chat_id(chat_id):
            raise chats.ChatError("Invalid chat id")
        if not run["agentId"] or not run["runId"]:
            raise chats.ChatError("A run needs agentId and runId")
        async with self.scoped() as conn:
            return await chats.append_run(conn, self.ws, self.principal.user_id, chat_id, run)

    async def update_chat(self, chat_id: str, **changes: Any) -> dict[str, Any] | None:
        async with self.scoped() as conn:
            return await chats.update_chat(
                conn, self.ws, self.principal.user_id, chat_id, **changes
            )

    async def remove_chat(self, chat_id: str) -> bool:
        async with self.scoped() as conn:
            return await chats.remove_chat(conn, self.ws, self.principal.user_id, chat_id)

    async def search(
        self,
        query: str,
        *,
        scope: str | None = None,
        near: str | None = None,
        near_experiment: str | None = None,
        limit: int | None = None,
    ) -> list[dict[str, Any]]:
        """Files this principal may read that match, best first (see search.py)."""
        search = self.storage.search
        # Before the connection: the embedding model may be a slow remote API.
        vector = await search.meaning(query)
        async with self.scoped() as conn:
            return await search.search(
                conn,
                self.principal.user_id,
                query,
                vector=vector,
                scope=scope,
                near=near,
                near_experiment=near_experiment,
                limit=limit,
            )

    async def can_see(self, event: dict[str, Any]) -> bool:
        """Whether this principal may hear about a change."""
        user_id = self.principal.user_id
        op = event.get("op")
        # Only wakes open streams to recheck membership (workspaces.py, update).
        if op == "workspace":
            return False
        # Hidden nodes stay hidden: not even their ids go out.
        if op == "node":
            # Who just lost access to a restricted node hears that too, to close it.
            if user_id in (event.get("left") or []):
                return True
            return await self.access.sees_node(user_id, str(event.get("id")))
        if op == "experiment":
            # Who just stopped working on it hears that too, to close it.
            if user_id in (event.get("left") or []):
                return True
            return await self.access.hears_experiment(
                user_id, str(event.get("id")), str(event.get("change"))
            )
        if op == "proposal":
            # Its author too only while they can view its node (docs/restricted-knowledge.md).
            return await self.role(event.get("node")) is not None
        if event.get("experiment"):
            return (
                await self.access.experiment_access(user_id, str(event["experiment"])) is not None
            )
        return await self.role(event.get("node")) is not None

    # The org tree and grants

    async def users(self) -> list[dict[str, Any]]:
        """
        The workspace's members, not everyone who has signed in: names for a
        Member, and emails too for an Owner or Admin.
        """
        return await self.access.users(private=self.membership in ("owner", "admin"))

    async def me(self) -> dict[str, Any] | None:
        """The caller's own id, subject, email and name, while they are a member here."""
        user_id = self.principal.user_id
        return await self.access.user(user_id) if await self.access.is_member(user_id) else None

    async def people(self) -> list[dict[str, Any]]:
        """The workspace's members, with roles and groups: for its Owners and Admins."""
        self.need_admin()
        return await self.access.people()

    async def groups(self) -> list[dict[str, Any]]:
        return await self.access.groups()

    async def create_group(self, parent_id: str | None, name: str) -> str:
        self.need_admin()

        async def in_tx(conn: AsyncConnection, group_id: str) -> None:
            await self._audit(
                "group.create", {"group": group_id, "parent": parent_id, "name": name}
            )(conn)

        return await self.access.create_group(parent_id, name, in_tx)

    async def rename_group(self, group_id: str, name: str) -> bool:
        self.need_admin()
        return await self.access.rename_group(
            group_id, name, self._audit("group.rename", {"group": group_id, "name": name})
        )

    async def delete_group(self, group_id: str) -> bool:
        self.need_admin()
        return await self.access.delete_group(
            group_id, self._audit("group.delete", {"group": group_id})
        )

    async def set_member(self, group_id: str, user_id: str, member: bool) -> bool:
        self.need_admin()
        action = "group.add_member" if member else "group.remove_member"
        return await self.access.set_member(
            group_id,
            user_id,
            member,
            self._audit(action, {"group": group_id, "user": user_id}),
            actor=self.principal.user_id,
        )

    async def grants(self, node_id: str | None) -> list[dict[str, Any]]:
        """Grants on a node (None = workspace); owners of that node may see and change them."""
        await self.need(node_id, "owner")
        return await self.access.grants(node_id)

    async def set_grant(
        self, node_id: str | None, principal_type: str, principal_id: str, role: str
    ) -> str:
        await self.need(node_id, "owner")
        return await self.access.set_grant(
            node_id,
            principal_type,
            principal_id,
            role,
            self.principal.user_id,
            self._audit(
                "grant.set",
                {
                    "node": node_id,
                    "principalType": principal_type,
                    "principalId": principal_id,
                    "role": role,
                },
            ),
        )

    async def revoke(self, grant_id: str) -> bool:
        grant = next((g for g in await self.access.grants() if g["id"] == grant_id), None)
        if not grant:
            return False
        await self.need(grant["nodeId"], "owner")
        return await self.access.revoke(
            grant_id,
            self._audit(
                "grant.revoke",
                {
                    "node": grant["nodeId"],
                    "principalType": grant["principalType"],
                    "principalId": grant["principalId"],
                },
            ),
        )

    async def audit_log(self, limit: int, kinds: list[str]) -> list[dict[str, Any]]:
        """
        Recent changes, for Owners and Admins. A target's name, path or title shows
        only if the reader can see that target now (docs/workspaces.md, "Audit log
        visibility"): otherwise the entry keeps its ids and says `redacted`.
        """
        self.need_admin()
        entries = await self.access.audit_log(limit, kinds)
        seen: dict[tuple[str, str | None], bool] = {}

        async def visible(target: dict[str, Any]) -> bool:
            experiment = target.get("experiment")
            key = ("experiment", experiment) if isinstance(experiment, str) else None
            if key is None:
                node = target.get("node")
                if "node" not in target or not (node is None or isinstance(node, str)):
                    return True
                # A node's own name shows wherever the tree shows the node; anything in
                # it (file paths, notes) needs a role there. An Owner or Admin sees a
                # restricted node's name, never what's in it.
                names_only = _AUDIT_CONTENT.intersection(target) <= _AUDIT_NODE_NAMES
                key = ("node-name" if names_only else "node", node)
            if key not in seen:
                user = self.principal.user_id
                if key[0] == "experiment":
                    found = await self.access.experiment_access(user, key[1])  # pyrefly: ignore[bad-argument-type]
                    seen[key] = found is not None
                elif key[1] is None:
                    seen[key] = await self.role(None) is not None
                elif key[0] == "node-name":
                    seen[key] = await self.access.sees_node(user, key[1])
                else:
                    seen[key] = await self.role(key[1]) is not None
            return seen[key]

        for entry in entries:
            target = entry["target"]
            if (
                isinstance(target, dict)
                and _AUDIT_CONTENT.intersection(target)
                and not await visible(target)
            ):
                entry["target"] = {
                    **{k: v for k, v in target.items() if k not in _AUDIT_CONTENT},
                    "redacted": True,
                }
        return entries


class FilesSession:
    """
    One place's files, as one principal. Reads need
    viewer; writes and deletes need editor, like in a shared folder (a deleted
    file keeps its history, so nothing is lost).
    """

    def __init__(self, session: Session, service: FileService, role: Role) -> None:
        self.session = session
        self.service = service
        self.role = role

    @property
    def node_id(self) -> str | None:
        return self.service.node_id

    @property
    def experiment_id(self) -> str | None:
        return self.service.experiment_id

    def _need_editor(self) -> None:
        if at_least(self.role, "editor"):
            return
        raise ForbiddenError(
            "Only the experiment's maintainer and collaborators can change its files, and not once it is archived"
            if self.experiment_id
            else f"You can only {ROLE_VERB[self.role]} here; this needs editor access"
        )

    def _audit(self, action: str, target: dict[str, Any]):
        place = {"experiment": self.experiment_id} if self.experiment_id else {"node": self.node_id}
        return self.session._audit(action, {**place, **target})

    async def list(self) -> list[dict[str, Any]]:
        async with self.session.scoped() as conn:
            return await self.service.list(conn)

    async def stat(self, path: str) -> dict[str, Any] | None:
        async with self.session.scoped() as conn:
            return await self.service.stat(conn, path)

    async def stat_version(self, path: str, version_id: str) -> dict[str, Any] | None:
        """One of the file's own versions; None for any other id (FileService.stat_version)."""
        async with self.session.scoped() as conn:
            return await self.service.stat_version(conn, path, version_id)

    async def read(
        self, path: str, version_id: str | None = None
    ) -> tuple[dict[str, Any], bytes] | None:
        """The file now, or with `version_id` that version of it, and its bytes."""
        async with self.session.scoped() as conn:
            info = (
                await self.service.stat(conn, path)
                if version_id is None
                else await self.service.stat_version(conn, path, version_id)
            )
        if not info:
            return None
        # The bytes after the connection went back to the pool (FileService.content).
        content = await self.service.content(info)
        await self._record_read(info, version_id)
        return info, content

    async def _record_read(self, info: dict[str, Any], version_id: str | None) -> None:
        """
        A run's agent reading one of its recorded files (its Rules) while it runs
        leaves a record of the version it read (experiments.record_read). Only
        the agent of someone who works on the run counts: viewing isn't running.
        """
        principal = self.session.principal
        if (
            principal.actor != "agent"
            or not principal.via
            or self.experiment_id is None
            or info["path"] not in experiments.RECORDED_READS
            or not at_least(self.role, "editor")
        ):
            return
        async with self.session.scoped() as conn:
            node = await experiments.record_read(
                conn,
                self.session.ws,
                self.experiment_id,
                info["path"],
                info["sha256"],
                principal.user_id,
                principal.via,
                version_id,
            )
            # A new read changes what the run panel shows: whoever has the run open hears it.
            if node is not None:
                await self.session.storage.notify(
                    conn,
                    {
                        "op": "experiment",
                        "change": "update",
                        "id": self.experiment_id,
                        "node": node or None,
                    },
                )

    async def history(self, path: str) -> builtins.list[dict[str, Any]] | None:
        async with self.session.scoped() as conn:
            return await self.service.history(conn, path)

    async def write(
        self,
        path: str,
        data: bytes,
        *,
        mime: str | None = None,
        create_only: bool = False,
        if_match: Collection[str] | None = None,
    ):
        self._need_editor()
        principal = self.session.principal
        # The upload first, while no connection is held for it (FileService.store).
        await self.service.store(path, data, mime)
        async with self.session.scoped() as conn:
            return await self.service.write(
                conn,
                path,
                data,
                mime=mime,
                stored=True,
                create_only=create_only,
                if_match=if_match,
                author=principal.actor,
                author_id=principal.user_id,
                in_tx=self._audit("file.write", {"path": path, "size": len(data)}),
            )

    async def rename(self, source: str, target: str) -> dict[str, Any] | None:
        self._need_editor()
        async with self.session.scoped() as conn:
            return await self.service.rename(
                conn,
                source,
                target,
                author=self.session.principal.actor,
                in_tx=self._audit("file.rename", {"path": source, "to": target}),
            )

    async def remove(self, path: str) -> bool:
        self._need_editor()
        async with self.session.scoped() as conn:
            return await self.service.remove(conn, path, self._audit("file.delete", {"path": path}))


async def _lock_member(conn: AsyncConnection, workspace_id: str, user_id: str) -> bool:
    """
    Whether `user_id` is a member, holding their membership until the transaction
    ends, so a removal can't slip in before the write that gives them a place
    (025_experiment_maintainers.sql, lock_workspace_member).
    """
    if not is_uuid(user_id):
        return False
    cur = await conn.execute("SELECT lock_workspace_member(%s, %s)", (workspace_id, user_id))
    row = await cur.fetchone()
    return bool(row and row[0])
