"""What one principal may do with the knowledge tree and access, as Session in apps/agent/src/storage/session.ts.

Every route goes through here, so access is checked and audited in one place.
A node the principal can't see at all is reported as not found, so its
existence doesn't leak. With row-level security, node queries also run as
the restricted database role for this principal (db.as_user), so Postgres
enforces the same rules if a check here is ever missed.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

from psycopg import AsyncConnection

from . import nodes
from .access import AccessService, ForbiddenError, Principal, Role, at_least
from .db import as_user
from .files import FileService
from .nodes import NodeNotFoundError
from .storage import Storage

# What a role lets you do, for refusals: "You can only view here; ...".
ROLE_VERB: dict[str, str] = {"viewer": "view", "editor": "edit", "owner": "manage"}


class Session:
    def __init__(self, storage: Storage, access: AccessService, principal: Principal) -> None:
        self.storage = storage
        self.access = access
        self.principal = principal

    @property
    def ws(self) -> str:
        return self.storage.workspace_id

    async def role(self, node_id: str | None) -> Role | None:
        return await self.access.role(self.principal.user_id, node_id)

    async def need(self, node_id: str | None, minimum: Role) -> Role:
        role = await self.role(node_id)
        if role is None:
            if node_id is not None:
                raise NodeNotFoundError("Node not found")
            raise ForbiddenError("You have no access to this workspace")
        if not at_least(role, minimum):
            raise ForbiddenError(f"You can only {ROLE_VERB[role]} here; this needs {minimum} access")
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
            if not roles.get(node["id"]):
                continue
            current: dict[str, Any] | None = node
            while current and current["id"] not in shown:
                shown.add(current["id"])
                current = by_id.get(current["parentId"] or "")
        visible = []
        for node in every:
            if node["id"] not in shown:
                continue
            role = roles.get(node["id"])
            visible.append({**node, "role": role, "fileCount": node["fileCount"] if role else 0})
        return {"types": levels, "rootRole": root_role, "nodes": visible}

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
            await self._audit("node.create", {"node": node_id, "parent": parent_id, "name": name})(conn)

        async with self.scoped() as conn:
            return await nodes.create(conn, self.storage, parent_id, name, in_tx)

    async def rename_node(self, node_id: str, name: str) -> dict[str, Any] | None:
        await self.need(node_id, "editor")
        async with self.scoped() as conn:
            return await nodes.rename(
                conn, self.storage, node_id, name, self._audit("node.rename", {"node": node_id, "name": name})
            )

    async def delete_node(self, node_id: str) -> bool:
        await self.need(node_id, "owner")
        async with self.scoped() as conn:
            return await nodes.remove(conn, self.storage, node_id, self._audit("node.delete", {"node": node_id}))

    # Files

    async def files(self, node_id: str | None) -> FilesSession:
        """Files at the workspace root (None) or in a node."""
        role = await self.need(node_id, "viewer")
        async with self.storage.pool.connection() as conn:
            service = await FileService(self.storage).in_node(conn, node_id)
        if not service:
            raise NodeNotFoundError("Node not found")
        return FilesSession(self, service, role)

    async def can_see(self, event: dict[str, Any]) -> bool:
        """Whether this principal may hear about a change."""
        user_id = self.principal.user_id
        op = event.get("op")
        # Hidden nodes stay hidden: not even their ids go out.
        if op == "node":
            return await self.access.sees_node(user_id, str(event.get("id")))
        if op == "experiment":
            return await self.access.hears_experiment(user_id, str(event.get("id")), str(event.get("change")))
        if op == "proposal":
            return event.get("authorId") == user_id or await self.role(event.get("node")) is not None
        if event.get("experiment"):
            return await self.access.experiment_access(user_id, str(event["experiment"])) is not None
        return await self.role(event.get("node")) is not None

    # The org tree and grants

    async def users(self) -> list[dict[str, Any]]:
        return await self.access.users()

    async def people(self) -> list[dict[str, Any]]:
        """Everyone who has signed in, with roles and groups: for workspace owners."""
        await self.need(None, "owner")
        return await self.access.people()

    async def groups(self) -> list[dict[str, Any]]:
        return await self.access.groups()

    async def create_group(self, parent_id: str | None, name: str) -> str:
        await self.need(None, "owner")

        async def in_tx(conn: AsyncConnection, group_id: str) -> None:
            await self._audit("group.create", {"group": group_id, "parent": parent_id, "name": name})(conn)

        return await self.access.create_group(parent_id, name, in_tx)

    async def rename_group(self, group_id: str, name: str) -> bool:
        await self.need(None, "owner")
        return await self.access.rename_group(
            group_id, name, self._audit("group.rename", {"group": group_id, "name": name})
        )

    async def delete_group(self, group_id: str) -> bool:
        await self.need(None, "owner")
        return await self.access.delete_group(group_id, self._audit("group.delete", {"group": group_id}))

    async def set_member(self, group_id: str, user_id: str, member: bool) -> bool:
        await self.need(None, "owner")
        action = "group.add_member" if member else "group.remove_member"
        return await self.access.set_member(
            group_id, user_id, member, self._audit(action, {"group": group_id, "user": user_id})
        )

    async def grants(self, node_id: str | None) -> list[dict[str, Any]]:
        """Grants on a node (None = workspace); owners of that node may see and change them."""
        await self.need(node_id, "owner")
        return await self.access.grants(node_id)

    async def set_grant(self, node_id: str | None, principal_type: str, principal_id: str, role: str) -> str:
        await self.need(node_id, "owner")
        return await self.access.set_grant(
            node_id,
            principal_type,
            principal_id,
            role,
            self.principal.user_id,
            self._audit(
                "grant.set",
                {"node": node_id, "principalType": principal_type, "principalId": principal_id, "role": role},
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
                {"node": grant["nodeId"], "principalType": grant["principalType"], "principalId": grant["principalId"]},
            ),
        )

    async def audit_log(self, limit: int, kinds: list[str]) -> list[dict[str, Any]]:
        await self.need(None, "owner")
        return await self.access.audit_log(limit, kinds)


class FilesSession:
    """
    One place's files, as one principal (FilesSession in session.ts). Reads need
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

    def _need_editor(self) -> None:
        if not at_least(self.role, "editor"):
            raise ForbiddenError(f"You can only {ROLE_VERB[self.role]} here; this needs editor access")

    def _audit(self, action: str, target: dict[str, Any]):
        return self.session._audit(action, {"node": self.node_id, **target})

    async def list(self) -> list[dict[str, Any]]:
        async with self.session.scoped() as conn:
            return await self.service.list(conn)

    async def stat(self, path: str) -> dict[str, Any] | None:
        async with self.session.scoped() as conn:
            return await self.service.stat(conn, path)

    async def read(self, path: str) -> tuple[dict[str, Any], bytes] | None:
        async with self.session.scoped() as conn:
            return await self.service.read(conn, path)

    async def history(self, path: str) -> list[dict[str, Any]] | None:
        async with self.session.scoped() as conn:
            return await self.service.history(conn, path)

    async def write(self, path: str, data: bytes, *, mime: str | None = None, create_only: bool = False):
        self._need_editor()
        principal = self.session.principal
        async with self.session.scoped() as conn:
            return await self.service.write(
                conn,
                path,
                data,
                mime=mime,
                create_only=create_only,
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
