"""Shared memory, as SharedMemoryService in apps/agent/src/storage/shared-memory.ts (issue #93, step 3; migration 020).

Notes like personal memory's, but for a whole workspace, a knowledge node (and
everything below it) or a group of people. Who reads and edits each place
follows the grants (shared_memory_rank in the migration). Every query checks
that rank itself, and with row-level security Postgres checks it too.

Claude never changes a shared note itself: its changes are proposals, which
someone who can edit the place accepts or rejects. A person shares one of
their own notes by copying it in: directly where they can edit, else as a
proposal.

What a chat run uses (forRun, texts, search) stays on the TypeScript server
until #190's step 8c.
"""

from __future__ import annotations

import re
from typing import Any

from psycopg import AsyncConnection
from psycopg_pool import AsyncConnectionPool

from .access import iso
from .memory import (
    MemoryConflictError,
    MemoryError_,
    MemoryNotFoundError,
    Scope,
    _js_string,
    _one,
    _rows,
    check_input,
    clean_reason,
    valid_name,
)
from .paths import JS_SPACE

SHARED_SCOPES = ("workspace", "node", "group")
SHARED_MODES = ("auto", "manual", "off")
# Notes per place; more are refused.
MAX_SHARED_NOTES = 200
# Open proposals per author; more are refused until some are decided.
MAX_SHARED_PROPOSALS = 50

_UUID = re.compile(r"[0-9a-fA-F-]{36}")
_SPACES = re.compile(f"[{JS_SPACE}]+")
_PROPOSAL_COLUMNS = (
    "p.id::text AS id, p.op, p.scope, p.node_id::text AS node_id, p.group_id::text AS group_id, "
    "p.memory_id::text AS memory_id, p.name, p.description, p.type, p.body, p.base_version, "
    "p.author_id::text AS author_id, p.author_type, p.thread_id, p.reason, p.created_at"
)

# A method named list shadows the builtin in the class body's annotations.
Rows = list[dict[str, Any]]


def is_uuid(value: Any) -> bool:
    return isinstance(value, str) and bool(_UUID.fullmatch(value))


def shared_ref(note_id: str) -> str:
    """The handle Claude uses for a shared note, next to personal notes' names."""
    return f"shared:{note_id}"


def place_of(row: dict[str, Any]) -> dict[str, Any]:
    scope = row["scope"]
    label = row.get("label")
    return {
        "scope": scope,
        "nodeId": row["node_id"],
        "groupId": row["group_id"],
        "label": "Workspace"
        if scope == "workspace"
        else label or ("A node" if scope == "node" else "A group"),
    }


def check_place(given: dict[str, Any]) -> dict[str, str | None]:
    """The place, checked: a known scope with the ids it needs."""
    scope = given.get("scope")
    if not isinstance(scope, str) or scope not in SHARED_SCOPES:
        raise MemoryError_("scope is workspace, node or group")
    node_id = given.get("nodeId") if scope == "node" else None
    group_id = given.get("groupId") if scope == "group" else None
    if scope == "node" and not is_uuid(node_id):
        raise MemoryError_("Say which node: nodeId")
    if scope == "group" and not is_uuid(group_id):
        raise MemoryError_("Say which group: groupId")
    return {"scope": scope, "nodeId": node_id, "groupId": group_id}


def _summary(row: dict[str, Any]) -> dict[str, Any]:
    everyone = row["everyone_mode"] or "auto"
    pack = (
        {
            "installId": row["pack_install_id"],
            "name": row["pack_name"] or "",
            "version": row["pack_version"] or 0,
        }
        if row["pack_install_id"]
        else None
    )
    return {
        "id": row["id"],
        "name": row["name"],
        "description": row["description"],
        "type": row["type"],
        "version": row["version"],
        "place": place_of(row),
        "canEdit": row["rank"] >= 2,
        "mode": row["my_mode"] or everyone,
        "myMode": row["my_mode"],
        "everyoneMode": everyone,
        "updatedAt": iso(row["updated_at"]),
        "pack": pack,
    }


def _note(row: dict[str, Any]) -> dict[str, Any]:
    return {**_summary(row), "body": row["body"]}


def _from_pack(row: dict[str, Any]) -> None:
    """A memory pack's notes change only with the pack."""
    if row["pack_install_id"]:
        raise MemoryError_(
            f"{row['name']} comes from the memory pack {row['pack_name']}: update or fork the pack to change it"
        )


_SAME_PLACE = "scope = %s AND node_id IS NOT DISTINCT FROM %s::uuid AND group_id IS NOT DISTINCT FROM %s::uuid"


class SharedMemoryService:
    """Shared notes as one user sees them; `scoped` opens that user's transaction, `pool` reads as the server."""

    def __init__(
        self, scoped: Scope, pool: AsyncConnectionPool, workspace_id: str, user_id: str
    ) -> None:
        self.scoped = scoped
        self.pool = pool
        self.ws = workspace_id
        self.user = user_id

    async def _rank(self, conn: AsyncConnection, place: dict[str, Any]) -> int:
        found = await _one(
            conn,
            "SELECT shared_memory_rank(%s, %s, %s, %s::uuid, %s::uuid) AS rank",
            (self.ws, self.user, place["scope"], place["nodeId"], place["groupId"]),
        )
        return found["rank"] if found else 0

    async def _rows(self, conn: AsyncConnection, where: str, params: tuple = ()) -> Rows:
        """
        Readable notes, with the user's rank and modes. Labels come from groups
        and nodes the user may see the note of, so they are read as the server.
        """
        rows = await _rows(
            conn,
            f"""
            SELECT * FROM (
              SELECT m.id::text AS id, m.scope, m.node_id::text AS node_id, m.group_id::text AS group_id, m.name,
                m.description, m.type, m.body, m.version, m.updated_at,
                shared_memory_rank(m.workspace_id, %s, m.scope, m.node_id, m.group_id) AS rank,
                m.pack_install_id::text AS pack_install_id, pk.name AS pack_name, pv.version AS pack_version,
                (SELECT s.mode FROM shared_memory_settings s WHERE s.memory_id = m.id AND s.user_id = %s) AS my_mode,
                (SELECT s.mode FROM shared_memory_settings s WHERE s.memory_id = m.id AND s.user_id IS NULL)
                  AS everyone_mode
              FROM shared_memories m
              LEFT JOIN nodes n ON n.id = m.node_id
              LEFT JOIN memory_pack_installs pi ON pi.id = m.pack_install_id
              LEFT JOIN hub_memory_packs pk ON pk.id = pi.pack_id
              LEFT JOIN hub_memory_pack_versions pv ON pv.id = pi.version_id
              WHERE m.workspace_id = %s AND (m.node_id IS NULL OR n.deleted_at IS NULL) AND {where}
            ) r
            WHERE r.rank >= 1
            ORDER BY r.scope, r.name""",
            (self.user, self.user, self.ws, *params),
        )
        return await self._label(rows)

    async def _label(self, rows: list[dict[str, Any]]) -> Rows:
        nodes = list(dict.fromkeys(r["node_id"] for r in rows if r["node_id"]))
        groups = list(dict.fromkeys(r["group_id"] for r in rows if r["group_id"]))
        names: dict[str, str] = {}
        if nodes or groups:
            async with self.pool.connection() as conn:
                if nodes:
                    for found in await _rows(
                        conn,
                        "SELECT id::text AS id, name FROM nodes WHERE id = ANY(%s::uuid[])",
                        (nodes,),
                    ):
                        names[found["id"]] = found["name"]
                if groups:
                    for found in await _rows(
                        conn,
                        "SELECT id::text AS id, name FROM groups WHERE id = ANY(%s::uuid[])",
                        (groups,),
                    ):
                        names[found["id"]] = found["name"]
        for row in rows:
            row["label"] = names.get(row["node_id"] or row["group_id"] or "")
        return rows

    async def _lock(self, conn: AsyncConnection, note_id: str) -> None:
        """Holds the note until the transaction ends, so a version check stays true while writing."""
        if is_uuid(note_id):
            await conn.execute("SELECT 1 FROM shared_memories WHERE id = %s FOR UPDATE", (note_id,))

    async def _one(self, conn: AsyncConnection, note_id: Any) -> dict[str, Any]:
        if not is_uuid(note_id):
            raise MemoryNotFoundError(shared_ref(str(note_id)))
        rows = await self._rows(conn, "m.id = %s", (note_id,))
        if not rows:
            raise MemoryNotFoundError(shared_ref(note_id))
        return rows[0]

    async def list(self) -> Rows:
        """Every shared note the user can read."""
        async with self.scoped() as conn:
            return [_summary(r) for r in await self._rows(conn, "true")]

    async def get(self, note_id: str) -> dict[str, Any]:
        async with self.scoped() as conn:
            return _note(await self._one(conn, note_id))

    async def versions(self, note_id: str) -> Rows:
        async with self.scoped() as conn:
            await self._one(conn, note_id)
            rows = await _rows(
                conn,
                """
                SELECT v.version, v.description, v.type, v.body, v.changed_as, v.created_at,
                  (SELECT coalesce(u.name, u.email) FROM users u WHERE u.id = v.changed_by) AS changed_by
                FROM shared_memory_versions v WHERE v.memory_id = %s ORDER BY v.version DESC""",
                (note_id,),
            )
        return [
            {
                "version": r["version"],
                "description": r["description"],
                "type": r["type"],
                "body": r["body"],
                "changedBy": r["changed_by"],
                "changedAs": r["changed_as"],
                "createdAt": iso(r["created_at"]),
            }
            for r in rows
        ]

    async def _write(
        self,
        conn: AsyncConnection,
        row: dict[str, Any] | None,
        place: dict[str, Any],
        name: str,
        given: dict[str, Any],
        by: str,
        as_: str,
    ) -> str:
        """Writes the next version of a note (or its first)."""
        if row:
            written = await _one(
                conn,
                """
                UPDATE shared_memories SET description = %s, type = %s, body = %s,
                  version = version + 1, updated_by = %s, updated_at = now()
                WHERE id = %s RETURNING id::text AS id, version""",
                (given["description"], given["type"], given["body"], by, row["id"]),
            )
        else:
            where = (self.ws, place["scope"], place["nodeId"], place["groupId"])
            counted = await _one(
                conn,
                f"SELECT count(*)::int AS count FROM shared_memories WHERE workspace_id = %s AND {_SAME_PLACE}",
                where,
            )
            if counted and counted["count"] >= MAX_SHARED_NOTES:
                raise MemoryError_(f"A place has at most {MAX_SHARED_NOTES} shared notes")
            taken = await _rows(
                conn,
                """
                SELECT 1 AS taken FROM shared_memories
                WHERE workspace_id = %s AND scope = %s AND name = %s
                  AND node_id IS NOT DISTINCT FROM %s::uuid AND group_id IS NOT DISTINCT FROM %s::uuid""",
                (self.ws, place["scope"], name, place["nodeId"], place["groupId"]),
            )
            if taken:
                raise MemoryConflictError(f"There is already a shared note named {name} there")
            written = await _one(
                conn,
                """
                INSERT INTO shared_memories (workspace_id, scope, node_id, group_id, name, description, type, body,
                                             created_by, updated_by)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                RETURNING id::text AS id, version""",
                (
                    self.ws,
                    place["scope"],
                    place["nodeId"],
                    place["groupId"],
                    name,
                    given["description"],
                    given["type"],
                    given["body"],
                    by,
                    by,
                ),
            )
        assert written is not None
        await conn.execute(
            """
            INSERT INTO shared_memory_versions (memory_id, version, description, type, body, changed_by, changed_as)
            VALUES (%s, %s, %s, %s, %s, %s, %s)""",
            (
                written["id"],
                written["version"],
                given["description"],
                given["type"],
                given["body"],
                by,
                as_,
            ),
        )
        return written["id"]

    async def share(
        self, target: dict[str, Any], name: Any, given: dict[str, Any]
    ) -> dict[str, Any]:
        """Shares a copy of a note into a place: made there when the user can edit it, else proposed to its editors."""
        if not valid_name(name):
            raise MemoryError_(
                "A memory's name is lowercase letters, digits and dashes, at most 64 (e.g. writing-style)"
            )
        place = check_place(target)
        clean = check_input(given)
        async with self.scoped() as conn:
            rank = await self._rank(conn, place)
            if rank < 1:
                raise MemoryError_("You can't share to that place")
            made = (
                await self._write(conn, None, place, name, clean, self.user, "user")
                if rank >= 2
                else None
            )
        if made:
            return {"note": await self.get(made), "proposal": None}
        proposal = await self.propose(
            {"op": "add", "place": target, "name": name, "input": clean}, author_type="user"
        )
        return {"note": None, "proposal": proposal}

    async def update(
        self, note_id: str, given: dict[str, Any], if_version: int | None = None
    ) -> dict[str, Any]:
        """An editor's own change; `if_version` refuses a note that changed since."""
        clean = check_input(given)
        async with self.scoped() as conn:
            await self._lock(conn, note_id)
            row = await self._one(conn, note_id)
            if row["rank"] < 2:
                raise MemoryError_(
                    "Only its place's editors change a shared note; Claude can propose a change"
                )
            _from_pack(row)
            if if_version is not None and row["version"] != if_version:
                raise MemoryConflictError(f"{row['name']} changed since")
            if all(row[k] == clean[k] for k in ("description", "type", "body")):
                return _note(row)
            await self._write(conn, row, place_of(row), row["name"], clean, self.user, "user")
            return _note(await self._one(conn, note_id))

    async def remove(self, note_id: str) -> None:
        """Deletes a note for good, with its versions."""
        async with self.scoped() as conn:
            row = await self._one(conn, note_id)
            if row["rank"] < 2:
                raise MemoryError_("Only its place's editors delete a shared note")
            _from_pack(row)
            await conn.execute("DELETE FROM shared_memories WHERE id = %s", (row["id"],))

    async def propose(
        self, change: dict[str, Any], *, author_type: str, thread_id: str | None = None
    ) -> dict[str, Any]:
        """
        Proposes a change for the place's editors: a new note (`place`), or a
        change to or deletion of one (`id`). Proposing the same again replaces
        the author's open proposal.
        """
        op = change.get("op")
        if op not in ("add", "update", "delete"):
            raise MemoryError_("op is add, update or delete")
        clean = None if op == "delete" else check_input(change.get("input") or {})
        reason = clean_reason(change.get("reason"))
        async with self.scoped() as conn:
            memory_id = None
            base = None
            if op == "add":
                place = check_place(change.get("place") or {})
                name = change.get("name")
                if not valid_name(name):
                    raise MemoryError_(f"Invalid memory name: {_js_string(name)}")
                if await self._rank(conn, place) < 1:
                    raise MemoryError_("You can't propose notes for that place")
            else:
                row = await self._one(conn, change.get("id") or "")
                _from_pack(row)
                place = {
                    "scope": row["scope"],
                    "nodeId": row["node_id"],
                    "groupId": row["group_id"],
                }
                memory_id, name, base = row["id"], row["name"], row["version"]
            counted = await _one(
                conn,
                """
                SELECT count(*)::int AS count FROM shared_memory_proposals
                WHERE workspace_id = %s AND author_id = %s AND status = 'open'""",
                (self.ws, self.user),
            )
            open_ = await _one(
                conn,
                f"""
                SELECT id::text AS id FROM shared_memory_proposals
                WHERE workspace_id = %s AND author_id = %s AND author_type = %s
                  AND status = 'open' AND op = %s AND name = %s AND {_SAME_PLACE}
                FOR UPDATE""",
                (
                    self.ws,
                    self.user,
                    author_type,
                    op,
                    name,
                    place["scope"],
                    place["nodeId"],
                    place["groupId"],
                ),
            )
            content = (
                (clean or {}).get("description"),
                (clean or {}).get("type"),
                (clean or {}).get("body"),
            )
            if open_:
                await conn.execute(
                    """
                    UPDATE shared_memory_proposals SET
                      description = %s, type = %s, body = %s,
                      base_version = %s, thread_id = %s, reason = %s, created_at = now()
                    WHERE id = %s""",
                    (*content, base, thread_id, reason, open_["id"]),
                )
                proposal_id = open_["id"]
            else:
                if counted and counted["count"] >= MAX_SHARED_PROPOSALS:
                    raise MemoryError_(
                        f"You have {MAX_SHARED_PROPOSALS} shared-memory proposals waiting; "
                        "more wait until some are decided"
                    )
                made = await _one(
                    conn,
                    """
                    INSERT INTO shared_memory_proposals
                      (workspace_id, scope, node_id, group_id, memory_id, op, name, description, type, body,
                       base_version, author_id, author_type, thread_id, reason)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                    RETURNING id::text AS id""",
                    (
                        self.ws,
                        place["scope"],
                        place["nodeId"],
                        place["groupId"],
                        memory_id,
                        op,
                        name,
                        *content,
                        base,
                        self.user,
                        author_type,
                        thread_id,
                        reason,
                    ),
                )
                assert made is not None
                proposal_id = made["id"]
        return (await self._proposal_rows(proposal_id))[0]

    async def _proposal_rows(self, proposal_id: str | None = None) -> Rows:
        async with self.scoped() as conn:
            rows = await _rows(
                conn,
                f"""
                SELECT * FROM (
                  SELECT {_PROPOSAL_COLUMNS},
                    shared_memory_rank(p.workspace_id, %s, p.scope, p.node_id, p.group_id) AS rank,
                    (SELECT coalesce(u.name, u.email) FROM users u WHERE u.id = p.author_id) AS author
                  FROM shared_memory_proposals p
                  WHERE p.workspace_id = %s AND p.status = 'open' {"AND p.id = %s" if proposal_id else ""}
                ) r
                WHERE r.author_id = %s OR r.rank >= 2
                ORDER BY r.created_at, r.id""",
                (self.user, self.ws, *([proposal_id] if proposal_id else []), self.user),
            )
        return [
            {
                "id": r["id"],
                "op": r["op"],
                "place": place_of(r),
                "memoryId": r["memory_id"],
                "name": r["name"],
                "description": r["description"],
                "type": r["type"],
                "body": r["body"],
                "baseVersion": r["base_version"],
                "author": r["author"],
                "authorType": r["author_type"],
                "mine": r["author_id"] == self.user,
                "canDecide": r["rank"] >= 2,
                "threadId": r["thread_id"],
                "reason": r["reason"],
                "createdAt": iso(r["created_at"]),
            }
            for r in await self._label(rows)
        ]

    async def proposals(self) -> Rows:
        """Open proposals the user may decide, and their own."""
        return await self._proposal_rows()

    async def decide(self, proposal_id: str, decision: str) -> dict[str, Any]:
        """
        Accepts, rejects or (the author) withdraws a proposal. Accepting makes the
        change, credited to its author; a note changed since is a conflict.
        """
        if not is_uuid(proposal_id):
            raise MemoryNotFoundError("proposal")
        async with self.scoped() as conn:
            p = await _one(
                conn,
                f"""
                SELECT {_PROPOSAL_COLUMNS},
                  shared_memory_rank(p.workspace_id, %s, p.scope, p.node_id, p.group_id) AS rank
                FROM shared_memory_proposals p
                WHERE p.id = %s AND p.workspace_id = %s AND p.status = 'open'
                FOR UPDATE""",
                (self.user, proposal_id, self.ws),
            )
            if not p or (p["author_id"] != self.user and p["rank"] < 2):
                raise MemoryError_("No open proposal like that")
            if decision == "withdraw":
                if p["author_id"] != self.user:
                    raise MemoryError_("Only its author withdraws a proposal")
                await conn.execute(
                    "UPDATE shared_memory_proposals SET status = 'withdrawn', decided_at = now() WHERE id = %s",
                    (proposal_id,),
                )
                return {"note": None}
            if p["rank"] < 2:
                raise MemoryError_("Only its place's editors decide a proposal")
            await conn.execute(
                """
                UPDATE shared_memory_proposals SET status = %s, decided_by = %s, decided_at = now()
                WHERE id = %s""",
                ("accepted" if decision == "accept" else "rejected", self.user, proposal_id),
            )
            if decision == "reject":
                return {"note": None}
            place = {"scope": p["scope"], "nodeId": p["node_id"], "groupId": p["group_id"]}
            content = {"description": p["description"], "type": p["type"], "body": p["body"]}
            if p["op"] == "add":
                made = await self._write(
                    conn, None, place, p["name"], content, p["author_id"], p["author_type"]
                )
                return {"note": _note(await self._one(conn, made))}
            row = (
                await _one(
                    conn,
                    "SELECT id::text AS id, version FROM shared_memories WHERE id = %s FOR UPDATE",
                    (p["memory_id"],),
                )
                if p["memory_id"]
                else None
            )
            if not row or row["version"] != p["base_version"]:
                raise MemoryConflictError(
                    f"{p['name']} changed since this was proposed; reject it, or edit the note yourself"
                )
            if p["op"] == "delete":
                await conn.execute("DELETE FROM shared_memories WHERE id = %s", (row["id"],))
                return {"note": None}
            await self._write(
                conn, row, place, p["name"], content, p["author_id"], p["author_type"]
            )
            return {"note": _note(await self._one(conn, row["id"]))}

    async def set_mode(self, note_id: str, mode: Any, everyone: bool) -> dict[str, Any]:
        """
        Sets a note's mode for the user, or (`everyone`, its editors) the default
        for everyone; None clears the user's own, back to everyone's.
        """
        if mode is not None and (not isinstance(mode, str) or mode not in SHARED_MODES):
            raise MemoryError_("mode is auto, manual or off")
        if everyone and mode is None:
            raise MemoryError_("Say the mode for everyone")
        async with self.scoped() as conn:
            row = await self._one(conn, note_id)
            if everyone and row["rank"] < 2:
                raise MemoryError_("Only its place's editors set a shared note for everyone")
            if mode is None:
                await conn.execute(
                    "DELETE FROM shared_memory_settings WHERE memory_id = %s AND user_id = %s",
                    (row["id"], self.user),
                )
            else:
                await conn.execute(
                    """
                    INSERT INTO shared_memory_settings (memory_id, user_id, mode) VALUES (%s, %s, %s)
                    ON CONFLICT (memory_id, user_id) DO UPDATE SET mode = EXCLUDED.mode, updated_at = now()""",
                    (row["id"], None if everyone else self.user, mode),
                )
            return _summary(await self._one(conn, note_id))

    async def targets(self, node_id: str | None) -> Rows:
        """Places the user can share to: the workspace, `node_id`, their groups."""
        node = node_id if node_id and is_uuid(node_id) else None
        async with self.scoped() as conn:
            rows = await _rows(
                conn,
                """
                SELECT * FROM (
                  SELECT 'workspace' AS scope, NULL::text AS node_id, NULL::text AS group_id, NULL::text AS label,
                    shared_memory_rank(%s, %s, 'workspace', NULL, NULL) AS rank
                  UNION ALL
                  SELECT 'node', %s::uuid::text, NULL, NULL,
                    shared_memory_rank(%s, %s, 'node', %s::uuid, NULL)
                  WHERE %s::uuid IS NOT NULL
                ) r WHERE r.rank >= 1""",
                (self.ws, self.user, node, self.ws, self.user, node, node),
            )
        # Groups aren't readable as the user: the rank says which are theirs.
        async with self.pool.connection() as conn:
            rows += await _rows(
                conn,
                """
                SELECT * FROM (
                  SELECT 'group' AS scope, NULL::text AS node_id, id::text AS group_id, NULL::text AS label,
                    shared_memory_rank(%s, %s, 'group', NULL, id) AS rank
                  FROM groups WHERE workspace_id = %s
                ) r WHERE r.rank >= 1""",
                (self.ws, self.user, self.ws),
            )
        return [{**place_of(r), "canEdit": r["rank"] >= 2} for r in await self._label(rows)]
