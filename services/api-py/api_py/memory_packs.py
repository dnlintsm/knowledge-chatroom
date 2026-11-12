"""Memory packs, as MemoryPackHub in apps/agent/src/storage/memory-packs.ts (issue #93, step 4; migration 021).

A place's shared notes published to the hub as immutable, numbered versions,
for any workspace on the deployment to install, the way skills are.

- Publishing takes the place's own shared notes (not ones from other packs);
  whoever publishes a name first owns it, and only they add versions.
  Unchanged notes add no version. Each version is scanned like a skill.
- Installing pins a version in a place you edit: its notes become that
  place's shared notes, read-only, and Manual for everyone, so nobody's
  chats change until someone turns them on. Updating to another version
  keeps each note's modes; uninstalling removes the notes.
- Forking turns an install's notes into the place's own, editable ones.
- Hub admins (HUB_ADMINS, or the local user without login) verify versions;
  the publisher or an admin yanks one, after which it can't be newly installed.

These run as the server (not as the user), as on the TypeScript server:
shared_memory_rank decides who may do what.
"""

from __future__ import annotations

import hashlib
import re
from typing import Any

from psycopg import AsyncConnection
from psycopg.types.json import Jsonb
from psycopg_pool import AsyncConnectionPool

from .access import iso
from .memory import (
    MemoryConflictError,
    MemoryError_,
    MemoryNotFoundError,
    _one,
    _rows,
    to_markdown,
    valid_name,
)
from .paths import JS_SPACE, js_trim, utf16_len
from .run_report import js_json
from .shared_memory import _SAME_PLACE, _SPACES, MAX_SHARED_NOTES, check_place, is_uuid
from .skill_catalog import SkillFile, scan_skill
from .text_index import from_units, to_units

MAX_PACK_NOTES = 100
_VERSION_COLUMNS = (
    "v.id::text AS id, v.pack_id::text AS pack_id, v.version, v.description, v.notes, v.flags, v.published_at, "
    "v.verified_at, v.yanked_at, v.yank_reason"
)
_WORDS = f"[{JS_SPACE}]+"


def _version(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "version": row["version"],
        "description": row["description"],
        "notes": len(row["notes"]),
        "flags": row["flags"],
        "publishedBy": row["published_by"],
        "publishedAt": iso(row["published_at"]),
        "verified": row["verified_at"] is not None,
        "yanked": row["yanked_at"] is not None,
        "yankReason": row["yank_reason"],
    }


def scan_notes(notes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """The notes as files, for the skills' scan."""
    return scan_skill([SkillFile(f"{n['name']}.md", to_markdown(n).encode()) for n in notes])


def fingerprint(about: str, notes: list[dict[str, Any]]) -> str:
    """sha256 of JSON.stringify([about, notes]), as the TypeScript server computes it."""
    return hashlib.sha256(js_json([about, notes]).encode("utf-8", errors="surrogatepass")).hexdigest()


def _json(value: Any) -> Jsonb:
    return Jsonb(value, dumps=js_json)


class MemoryPackHub:
    def __init__(self, pool: AsyncConnectionPool, workspace_id: str, admins: frozenset[str]) -> None:
        self.pool = pool
        self.ws = workspace_id
        self.admins = admins

    async def is_admin(self, user_id: str) -> bool:
        async with self.pool.connection() as conn:
            user = await _one(conn, "SELECT subject, email FROM users WHERE id = %s", (user_id,))
        if not user:
            return False
        subject, email = user["subject"], user["email"]
        return subject == "local" or subject.lower() in self.admins or bool(email and email.lower() in self.admins)

    async def _rank(self, conn: AsyncConnection, user_id: str, place: dict[str, Any]) -> int:
        found = await _one(
            conn,
            "SELECT shared_memory_rank(%s, %s, %s, %s::uuid, %s::uuid) AS rank",
            (self.ws, user_id, place["scope"], place["nodeId"], place["groupId"]),
        )
        return found["rank"] if found else 0

    async def _versions(self, conn: AsyncConnection, pack_id: str) -> list[dict[str, Any]]:
        return await _rows(
            conn,
            f"""
            SELECT {_VERSION_COLUMNS},
              (SELECT coalesce(u.name, u.email) FROM users u WHERE u.id = v.published_by) AS published_by
            FROM hub_memory_pack_versions v WHERE v.pack_id = %s ORDER BY v.version DESC""",
            (pack_id,),
        )

    async def list(self, user_id: str, query: str = "") -> dict[str, Any]:
        """The hub's packs, newest first; `query` matches names and descriptions."""
        words = [w for w in re.split(_WORDS, query.lower()) if w]
        packs = []
        async with self.pool.connection() as conn:
            rows = await _rows(
                conn,
                """
                SELECT p.id::text AS id, p.name, p.owner_id::text AS owner_id, p.updated_at,
                  (SELECT coalesce(u.name, u.email) FROM users u WHERE u.id = p.owner_id) AS owner
                FROM hub_memory_packs p ORDER BY p.updated_at DESC, p.name LIMIT 200""",
            )
            for row in rows:
                latest = next((v for v in await self._versions(conn, row["id"]) if not v["yanked_at"]), None)
                text = f"{row['name']} {latest['description'] if latest else ''}".lower()
                if any(w not in text for w in words):
                    continue
                packs.append(
                    {
                        "name": row["name"],
                        "owner": row["owner"],
                        "mine": row["owner_id"] == user_id,
                        "latest": _version(latest) if latest else None,
                        "updatedAt": iso(row["updated_at"]),
                    }
                )
        return {"packs": packs, "isAdmin": await self.is_admin(user_id)}

    async def detail(self, user_id: str, name: str, version: int | None = None) -> dict[str, Any]:
        async with self.pool.connection() as conn:
            pack = await _one(
                conn,
                """
                SELECT p.id::text AS id, p.name, p.owner_id::text AS owner_id, p.updated_at,
                  (SELECT coalesce(u.name, u.email) FROM users u WHERE u.id = p.owner_id) AS owner
                FROM hub_memory_packs p WHERE p.name = %s""",
                (name,),
            )
            if not pack:
                raise MemoryNotFoundError(f"pack {name}")
            versions = await self._versions(conn, pack["id"])
        latest = next((v for v in versions if not v["yanked_at"]), None)
        if version is None:
            chosen = latest or (versions[0] if versions else None)
        else:
            chosen = next((v for v in versions if v["version"] == version), None)
        if not chosen:
            raise MemoryNotFoundError(f"pack {name} version {_js_version(version)}")
        return {
            "name": pack["name"],
            "owner": pack["owner"],
            "mine": pack["owner_id"] == user_id,
            "latest": _version(latest) if latest else None,
            "updatedAt": iso(pack["updated_at"]),
            "versions": [_version(v) for v in versions],
            "version": _version(chosen),
            "notes": chosen["notes"],
            "isAdmin": await self.is_admin(user_id),
        }

    async def publish(self, user_id: str, target: dict[str, Any], name: Any, description: Any) -> dict[str, Any]:
        """Publishes a place's own shared notes as the next version of the pack `name` (made, yours, if it's new)."""
        if not valid_name(name):
            raise MemoryError_("A pack's name is lowercase letters, digits and dashes, at most 64")
        about = js_trim(_SPACES.sub(" ", description)) if isinstance(description, str) else ""
        if not about or utf16_len(about) > 300:
            raise MemoryError_("A pack needs a one-line description, at most 300 characters")
        place = check_place(target)
        async with self.pool.connection() as conn, conn.transaction():
            if await self._rank(conn, user_id, place) < 2:
                raise MemoryError_("Only the place's editors publish its notes")
            notes = await _rows(
                conn,
                f"""
                SELECT name, description, type, body FROM shared_memories
                WHERE workspace_id = %s AND pack_install_id IS NULL AND {_SAME_PLACE}
                ORDER BY name""",
                (self.ws, place["scope"], place["nodeId"], place["groupId"]),
            )
            if not notes:
                raise MemoryError_("That place has no notes of its own to publish")
            if len(notes) > MAX_PACK_NOTES:
                raise MemoryError_(f"A pack has at most {MAX_PACK_NOTES} notes")
            printed = fingerprint(about, notes)
            await conn.execute(
                "INSERT INTO hub_memory_packs (name, owner_id) VALUES (%s, %s) ON CONFLICT (name) DO NOTHING",
                (name, user_id),
            )
            pack = await _one(
                conn,
                "SELECT id::text AS id, owner_id::text AS owner_id FROM hub_memory_packs WHERE name = %s FOR UPDATE",
                (name,),
            )
            assert pack is not None
            if pack["owner_id"] != user_id:
                raise MemoryConflictError(f"The pack {name} on the hub was published by someone else")
            latest = await _one(
                conn,
                """
                SELECT version, fingerprint FROM hub_memory_pack_versions WHERE pack_id = %s
                ORDER BY version DESC LIMIT 1""",
                (pack["id"],),
            )
            if latest and latest["fingerprint"] == printed:
                return {"name": name, "version": latest["version"], "unchanged": True}
            version = (latest["version"] if latest else 0) + 1
            await conn.execute(
                """
                INSERT INTO hub_memory_pack_versions (pack_id, version, description, notes, fingerprint, flags,
                                                      published_by)
                VALUES (%s, %s, %s, %s, %s, %s, %s)""",
                (pack["id"], version, about, _json(notes), printed, _json(scan_notes(notes)), user_id),
            )
            await conn.execute("UPDATE hub_memory_packs SET updated_at = now() WHERE id = %s", (pack["id"],))
            return {"name": name, "version": version, "unchanged": False}

    async def install(self, user_id: str, target: dict[str, Any], name: Any, version: int | None = None) -> dict:
        """
        Installs a pack in a place (or moves its install there to `version`, by
        default the newest that isn't yanked). Notes it adds are Manual for
        everyone; notes it keeps keep their modes.
        """
        if not valid_name(name):
            raise MemoryError_("Say which pack: name")
        place = check_place(target)
        where = (self.ws, place["scope"], place["nodeId"], place["groupId"])
        async with self.pool.connection() as conn, conn.transaction():
            if await self._rank(conn, user_id, place) < 2:
                raise MemoryError_("Installing a memory pack needs edit access to the place")
            pack = await _one(conn, "SELECT id::text AS id FROM hub_memory_packs WHERE name = %s", (name,))
            if not pack:
                raise MemoryNotFoundError(f"pack {name}")
            chosen = await _one(
                conn,
                f"""
                SELECT v.id::text AS id, v.version, v.notes, v.yanked_at, v.yank_reason
                FROM hub_memory_pack_versions v WHERE v.pack_id = %s
                  AND {"v.yanked_at IS NULL" if version is None else "v.version = %s"}
                ORDER BY v.version DESC LIMIT 1""",
                (pack["id"],) if version is None else (pack["id"], version),
            )
            if not chosen:
                raise MemoryNotFoundError(f"pack {name}{'' if version is None else f' version {version}'}")
            current = await _one(
                conn,
                f"""
                SELECT id::text AS id, version_id::text AS version_id FROM memory_pack_installs
                WHERE workspace_id = %s AND {_SAME_PLACE} AND pack_id = %s FOR UPDATE""",
                (*where, pack["id"]),
            )
            if chosen["yanked_at"] and (current or {}).get("version_id") != chosen["id"]:
                why = f": {chosen['yank_reason']}" if chosen["yank_reason"] else ""
                raise MemoryError_(f"Version {chosen['version']} of {name} was yanked{why}")
            others = " AND (pack_install_id IS NULL OR pack_install_id <> %s)" if current else ""
            extra = (current["id"],) if current else ()
            taken = await _rows(
                conn,
                f"""
                SELECT name FROM shared_memories
                WHERE workspace_id = %s AND {_SAME_PLACE} AND name = ANY(%s::text[]){others}""",
                (*where, [n["name"] for n in chosen["notes"]], *extra),
            )
            if taken:
                names = ", ".join(t["name"] for t in taken)
                raise MemoryConflictError(f"The place already has notes named {names}; rename them first")
            # The install's own notes are replaced, so they don't count.
            counted = await _one(
                conn,
                f"SELECT count(*)::int AS count FROM shared_memories WHERE workspace_id = %s AND {_SAME_PLACE}{others}",
                (*where, *extra),
            )
            total = (counted["count"] if counted else 0) + len(chosen["notes"])
            if total > MAX_SHARED_NOTES:
                raise MemoryError_(f"A place has at most {MAX_SHARED_NOTES} shared notes; this pack would make {total}")
            if current:
                install_id = current["id"]
                await conn.execute(
                    """
                    UPDATE memory_pack_installs SET version_id = %s, installed_by = %s, installed_at = now()
                    WHERE id = %s""",
                    (chosen["id"], user_id, install_id),
                )
            else:
                made = await _one(
                    conn,
                    """
                    INSERT INTO memory_pack_installs (workspace_id, scope, node_id, group_id, pack_id, version_id,
                                                      installed_by)
                    VALUES (%s, %s, %s, %s, %s, %s, %s)
                    RETURNING id::text AS id""",
                    (*where, pack["id"], chosen["id"], user_id),
                )
                assert made is not None
                install_id = made["id"]
            existing = {
                r["name"]: r
                for r in await _rows(
                    conn,
                    """
                    SELECT id::text AS id, name, description, type, body FROM shared_memories
                    WHERE pack_install_id = %s""",
                    (install_id,),
                )
            }
            for note in chosen["notes"]:
                had = existing.pop(note["name"], None)
                if had and all(had[k] == note[k] for k in ("description", "type", "body")):
                    continue
                if had:
                    written = await _one(
                        conn,
                        """
                        UPDATE shared_memories SET description = %s, type = %s, body = %s,
                          version = version + 1, updated_by = %s, updated_at = now()
                        WHERE id = %s RETURNING id::text AS id, version""",
                        (note["description"], note["type"], note["body"], user_id, had["id"]),
                    )
                else:
                    written = await _one(
                        conn,
                        """
                        INSERT INTO shared_memories (workspace_id, scope, node_id, group_id, name, description, type,
                                                     body, created_by, updated_by, pack_install_id)
                        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                        RETURNING id::text AS id, version""",
                        (
                            *where,
                            note["name"],
                            note["description"],
                            note["type"],
                            note["body"],
                            user_id,
                            user_id,
                            install_id,
                        ),
                    )
                    assert written is not None
                    await conn.execute(
                        "INSERT INTO shared_memory_settings (memory_id, user_id, mode) VALUES (%s, NULL, 'manual')",
                        (written["id"],),
                    )
                assert written is not None
                await conn.execute(
                    """
                    INSERT INTO shared_memory_versions (memory_id, version, description, type, body, changed_by,
                                                        changed_as)
                    VALUES (%s, %s, %s, %s, %s, %s, 'user')""",
                    (written["id"], written["version"], note["description"], note["type"], note["body"], user_id),
                )
            # Notes the version no longer has.
            if existing:
                await conn.execute(
                    "DELETE FROM shared_memories WHERE id = ANY(%s::uuid[])", ([g["id"] for g in existing.values()],)
                )
        return next(i for i in await self.installs(user_id) if i["id"] == install_id)

    async def installs(self, user_id: str) -> list[dict[str, Any]]:
        """Installed packs in places the user reads."""
        async with self.pool.connection() as conn:
            rows = await _rows(
                conn,
                """
                SELECT * FROM (
                  SELECT i.id::text AS id, p.name, v.version, i.scope, i.node_id::text AS node_id,
                    i.group_id::text AS group_id, i.installed_at,
                    (SELECT max(l.version) FROM hub_memory_pack_versions l
                     WHERE l.pack_id = p.id AND l.yanked_at IS NULL AND l.version > v.version) AS latest,
                    coalesce((SELECT n.name FROM nodes n WHERE n.id = i.node_id),
                             (SELECT g.name FROM groups g WHERE g.id = i.group_id)) AS label,
                    shared_memory_rank(i.workspace_id, %s, i.scope, i.node_id, i.group_id) AS rank,
                    (SELECT count(*)::int FROM shared_memories m WHERE m.pack_install_id = i.id) AS notes
                  FROM memory_pack_installs i
                  JOIN hub_memory_packs p ON p.id = i.pack_id
                  JOIN hub_memory_pack_versions v ON v.id = i.version_id
                  WHERE i.workspace_id = %s
                ) r WHERE r.rank >= 1
                ORDER BY r.name""",
                (user_id, self.ws),
            )
        return [
            {
                "id": r["id"],
                "name": r["name"],
                "version": r["version"],
                "latest": r["latest"],
                "place": {
                    "scope": r["scope"],
                    "nodeId": r["node_id"],
                    "groupId": r["group_id"],
                    "label": "Workspace"
                    if r["scope"] == "workspace"
                    else r["label"] or ("A node" if r["scope"] == "node" else "A group"),
                },
                "canEdit": r["rank"] >= 2,
                "notes": r["notes"],
                "installedAt": iso(r["installed_at"]),
            }
            for r in rows
        ]

    async def _editable_install(self, conn: AsyncConnection, user_id: str, install_id: str) -> None:
        if not is_uuid(install_id):
            raise MemoryNotFoundError("pack install")
        row = await _one(
            conn,
            """
            SELECT scope, node_id::text AS node_id, group_id::text AS group_id FROM memory_pack_installs
            WHERE id = %s AND workspace_id = %s FOR UPDATE""",
            (install_id, self.ws),
        )
        if not row:
            raise MemoryNotFoundError("pack install")
        place = {"scope": row["scope"], "nodeId": row["node_id"], "groupId": row["group_id"]}
        if await self._rank(conn, user_id, place) < 2:
            raise MemoryError_("Only the place's editors change its packs")

    async def uninstall(self, user_id: str, install_id: str) -> None:
        """Removes an install and its notes."""
        async with self.pool.connection() as conn, conn.transaction():
            await self._editable_install(conn, user_id, install_id)
            await conn.execute("DELETE FROM memory_pack_installs WHERE id = %s", (install_id,))

    async def fork(self, user_id: str, install_id: str) -> dict[str, int]:
        """Makes an install's notes the place's own (editable) and drops the install."""
        async with self.pool.connection() as conn, conn.transaction():
            await self._editable_install(conn, user_id, install_id)
            cur = await conn.execute(
                "UPDATE shared_memories SET pack_install_id = NULL WHERE pack_install_id = %s", (install_id,)
            )
            kept = cur.rowcount
            await conn.execute("DELETE FROM memory_pack_installs WHERE id = %s", (install_id,))
        return {"notes": kept}

    async def verify(self, user_id: str, name: str, version: int, verified: bool) -> None:
        """Marks a version checked (hub admins) or not."""
        if not await self.is_admin(user_id):
            raise MemoryError_("Only hub admins verify packs")
        async with self.pool.connection() as conn:
            cur = await conn.execute(
                f"""
                UPDATE hub_memory_pack_versions v SET
                  verified_at = {"now()" if verified else "NULL"}, verified_by = %s
                FROM hub_memory_packs p WHERE p.id = v.pack_id AND p.name = %s AND v.version = %s""",
                (user_id if verified else None, name, version),
            )
        if not cur.rowcount:
            raise MemoryNotFoundError(f"pack {name} version {_js_version(version)}")

    async def yank(self, user_id: str, name: str, version: int, yanked: bool, reason: Any = None) -> None:
        """Yanks a version (its publisher or a hub admin), or takes the yank back."""
        async with self.pool.connection() as conn:
            pack = await _one(
                conn, "SELECT id::text AS id, owner_id::text AS owner_id FROM hub_memory_packs WHERE name = %s", (name,)
            )
        if not pack:
            raise MemoryNotFoundError(f"pack {name}")
        if pack["owner_id"] != user_id and not await self.is_admin(user_id):
            raise MemoryError_("Only its publisher or a hub admin yanks a version")
        why = (from_units(to_units(js_trim(reason))[:500]) or None) if isinstance(reason, str) else None
        async with self.pool.connection() as conn:
            cur = await conn.execute(
                f"""
                UPDATE hub_memory_pack_versions SET
                  yanked_at = {"now()" if yanked else "NULL"}, yanked_by = %s, yank_reason = %s
                WHERE pack_id = %s AND version = %s""",
                (user_id if yanked else None, why if yanked else None, pack["id"], version),
            )
        if not cur.rowcount:
            raise MemoryNotFoundError(f"pack {name} version {_js_version(version)}")


def _js_version(version: int | None) -> str:
    return "undefined" if version is None else str(version)
