"""Skills per user and the skill hub, as apps/agent/src/skills/service.ts and hub.ts (issue #7).

SkillService: which skills exist for a user (built-in, installed from the hub,
and the workspace's own; the latter two if they can read the workspace root)
and the mode each is in, chosen at up to three levels: for everyone (by an
editor of the workspace root), by the user, and by the user for one chat; the
most specific applies (009_skills.sql, 010_skill_scopes.sql).

SkillHub, one per deployment: owners of the workspace publish its skills as
immutable, numbered versions (files kept as blobs); editors install one pinned
to a version, update it, or fork it into the workspace's skills/ to change it.
Each version is scanned when it's published (skill_catalog.scan_skill); hub
admins (HUB_ADMINS, or the local user without login) verify versions and
handle reports; a publisher can yank a version. Skills also move in and out
as .zip files in the Agent Skills layout (<name>/SKILL.md + files).

Everything here is the user's own doing over HTTP: Claude has no tools for the
hub, so a document can't talk it into installing a skill. The TypeScript
server keeps its own SkillService for the chats it runs, reading the same tables.
"""

from __future__ import annotations

import asyncio
import io
import logging
import re
import zipfile
from collections.abc import Iterable
from pathlib import Path
from typing import Any

from psycopg.types.json import Jsonb

from .access import ForbiddenError, Principal, Role, at_least, is_uuid, iso
from .blobs import sha256_hex
from .collation import collation_key
from .paths import JS_SPACE, InvalidPathError, js_trim, mime_for_path, normalize_path, utf16_len
from .session import FilesSession, Session
from .skill_catalog import (
    LARGE_FILE_BYTES,
    MAX_SKILL_BYTES,
    MAX_SKILL_FILE_BYTES,
    SKILL_MODES,
    Skill,
    SkillFile,
    builtin_skills,
    chosen_mode,
    code_unit_key,
    decode_text,
    describe,
    effective_mode,
    is_skill_name,
    manifest_of,
    merge_skills,
    scan_skill,
    skill_from_files,
    strict_text,
    workspace_skills,
)
from .storage import Storage

logger = logging.getLogger("api_py")

MODE_SCOPES = ("workspace", "user", "chat")
# Most files a skill (published or imported) may have.
MAX_FILES = 200
# Biggest .zip accepted for import.
MAX_ZIP_BYTES = 10 * 1024 * 1024
_MB = 1024 * 1024
_BLOB_CACHE_SIZE = 500


class UnknownSkillError(Exception):
    """No such skill for this user: 404."""


class InvalidModeError(ValueError):
    """A mode or scope that doesn't exist: 400."""


class SkillForbiddenError(Exception):
    """Not allowed (setting the workspace's defaults, publishing, installing...): 403."""


class HubError(ValueError):
    """The request is wrong (bad zip, wrong kind of skill...): 400."""


class HubNotFoundError(Exception):
    """404."""


class HubConflictError(Exception):
    """Something is in the way (a skill folder of that name...): 409."""


def parse_admins(value: str | None) -> frozenset[str]:
    """HUB_ADMINS: emails or login subjects, separated by commas or spaces."""
    return frozenset(v.lower() for v in re.split(f"[{JS_SPACE},]+", value or "") if js_trim(v))


class SkillService:
    def __init__(self, storage: Storage, builtins_dir: Path, scripts: bool) -> None:
        self.storage = storage
        self.builtins = builtin_skills(builtins_dir)
        self.scripts = scripts
        # Skill file bytes by content hash, so unchanged files aren't fetched again.
        self._blobs: dict[str, bytes] = {}

    def _session(self, user_id: str, actor: str = "agent") -> Session:
        return Session(self.storage, self.storage.access, Principal(user_id=user_id, actor=actor))  # type: ignore[arg-type]

    async def list(self, user_id: str, thread_id: str | None = None) -> dict[str, Any]:
        """Every skill the user can see, with its modes (with `thread_id`, that chat's too)."""
        skills, layers, role = await asyncio.gather(
            self.skills(user_id), self.layers(user_id, thread_id), self.root_role(user_id)
        )
        return {
            "skills": [describe(skill, layers.get(skill.name)) for skill in skills],
            "canSetDefaults": at_least(role, "editor"),
            "canPublish": at_least(role, "owner"),
            "hub": True,
            "scripts": self.scripts,
        }

    async def for_run(self, user_id: str, thread_id: str | None = None) -> list[tuple[Skill, str]]:
        """The skills a run for this user (in this chat) gets: everything not off, with its mode."""
        skills, layers = await asyncio.gather(self.skills(user_id), self.layers(user_id, thread_id))
        run = [
            (skill, effective_mode(skill, chosen_mode(layers.get(skill.name)))) for skill in skills
        ]
        return [(skill, mode) for skill, mode in run if mode != "off"]

    async def set_mode(
        self, user_id: str, name: str, mode: Any, scope: Any = "user", thread_id: str | None = None
    ) -> dict[str, Any]:
        """Sets a skill's mode at one level; None clears it there. Returns the skill as this user now sees it."""
        if mode is not None and mode not in SKILL_MODES:
            raise InvalidModeError(
                f"mode must be one of {', '.join(SKILL_MODES)}, or null to clear it"
            )
        if not isinstance(scope, str) or scope not in MODE_SCOPES:
            raise InvalidModeError(f"scope must be one of {', '.join(MODE_SCOPES)}")
        if scope == "chat" and not (thread_id and utf16_len(thread_id) <= 200):
            raise InvalidModeError("A chat's mode needs its thread")
        skill = await self.find(user_id, name)
        if skill is None:
            raise UnknownSkillError(f"No skill named {name}")
        if scope == "workspace" and not at_least(await self.root_role(user_id), "editor"):
            raise SkillForbiddenError("Only editors of the workspace can set its defaults")
        ws = self.storage.workspace_id
        async with self.storage.pool.connection() as conn:
            if scope == "chat":
                if mode is None:
                    await conn.execute(
                        """
                        DELETE FROM chat_skill_settings
                        WHERE workspace_id = %s AND user_id = %s AND thread_id = %s AND skill = %s""",
                        (ws, user_id, thread_id, name),
                    )
                else:
                    await conn.execute(
                        """
                        INSERT INTO chat_skill_settings (workspace_id, user_id, thread_id, skill, mode)
                        VALUES (%s, %s, %s, %s, %s)
                        ON CONFLICT (workspace_id, user_id, thread_id, skill)
                        DO UPDATE SET mode = EXCLUDED.mode, updated_at = now()""",
                        (ws, user_id, thread_id, name, mode),
                    )
            else:
                owner = None if scope == "workspace" else user_id
                if mode is None:
                    await conn.execute(
                        """
                        DELETE FROM skill_settings
                        WHERE workspace_id = %s AND user_id IS NOT DISTINCT FROM %s::uuid AND skill = %s""",
                        (ws, owner, name),
                    )
                else:
                    await conn.execute(
                        """
                        INSERT INTO skill_settings (workspace_id, user_id, skill, mode)
                        VALUES (%s, %s, %s, %s)
                        ON CONFLICT (workspace_id, user_id, skill)
                        DO UPDATE SET mode = EXCLUDED.mode, updated_at = now()""",
                        (ws, owner, name, mode),
                    )
        layers = await self.layers(user_id, thread_id if scope == "chat" else None)
        return describe(skill, layers.get(name))

    async def record(
        self, user_id: str, thread_id: str, run_id: str, skill: str, source: str, trigger: str
    ) -> None:
        """Notes that a turn used a skill; history for later (best effort)."""
        try:
            async with self.storage.pool.connection() as conn:
                await conn.execute(
                    """
                    INSERT INTO skill_invocations (workspace_id, user_id, thread_id, run_id, skill, source, trigger)
                    VALUES (%s, %s, %s, %s, %s, %s, %s)""",
                    (self.storage.workspace_id, user_id, thread_id, run_id, skill, source, trigger),
                )
        except Exception as err:  # noqa: BLE001 - never fails a run
            logger.warning("[skills] couldn't record a skill use: %s", err)

    async def layers(self, user_id: str, thread_id: str | None = None) -> dict[str, dict[str, str]]:
        """Each skill's choices at the three levels."""
        ws = self.storage.workspace_id
        async with self.storage.pool.connection() as conn:
            cur = await conn.execute(
                """
                SELECT skill, mode, CASE WHEN user_id IS NULL THEN 'workspace' ELSE 'user' END AS level
                FROM skill_settings
                WHERE workspace_id = %s AND (user_id IS NULL OR user_id = %s)
                UNION ALL
                SELECT skill, mode, 'chat' FROM chat_skill_settings
                WHERE workspace_id = %s AND user_id = %s AND thread_id = %s""",
                (ws, user_id, ws, user_id, thread_id or ""),
            )
            rows = await cur.fetchall()
        layers: dict[str, dict[str, str]] = {}
        for skill, mode, level in rows:
            layers.setdefault(skill, {})[level] = mode
        return layers

    async def find(self, user_id: str, name: str) -> Skill | None:
        """The skill named so, with its files, as this user sees it."""
        return next((s for s in await self.skills(user_id) if s.name == name), None)

    async def root_role(self, user_id: str) -> Role | None:
        return await self.storage.access.role(user_id, None)

    async def blob(self, sha256: str) -> bytes:
        """A blob's bytes, from the cache when this server has read it before."""
        data = self._blobs.get(sha256)
        if data is None:
            data = await self.storage.require_blobs().get(sha256)
            self._remember(sha256, data)
        return data

    async def files_of(self, listed: Iterable[dict[str, Any]]) -> list[SkillFile]:
        """A hub version's files ({path, sha256}), with their bytes."""
        listed = list(listed)
        data = await asyncio.gather(*(self.blob(f["sha256"]) for f in listed))
        return [SkillFile(f["path"], d) for f, d in zip(listed, data, strict=True)]

    async def skills(self, user_id: str) -> list[Skill]:
        # A workspace skill hides an installed hub skill of the same name (e.g. its fork).
        hub, workspace = await asyncio.gather(self.installed(user_id), self.workspace(user_id))
        return merge_skills(self.builtins, hub, workspace)

    async def installed(self, user_id: str) -> list[Skill]:
        """The hub skills installed in the workspace, at their pinned versions."""
        if not await self.root_role(user_id):
            return []
        async with self.storage.pool.connection() as conn:
            cur = await conn.execute(
                """
                SELECT h.name, v.version, v.files, v.verified_at IS NOT NULL AS verified,
                       v.yanked_at IS NOT NULL AS yanked, v.yank_reason,
                       (SELECT max(version) FROM hub_skill_versions
                        WHERE hub_skill_id = h.id AND yanked_at IS NULL) AS latest
                FROM skill_installs i
                JOIN hub_skills h ON h.id = i.hub_skill_id
                JOIN hub_skill_versions v ON v.id = i.version_id
                WHERE i.workspace_id = %s
                ORDER BY h.name""",
                (self.storage.workspace_id,),
            )
            rows = await cur.fetchall()

        async def one(row: tuple) -> Skill | None:
            name, version, files, verified, yanked, yank_reason, latest = row
            skill = skill_from_files(name, await self.files_of(files), "hub", None)
            if skill is None:
                return None
            pin = {
                "version": version,
                "latest": latest if latest is not None else version,
                "verified": verified,
                "yanked": yanked,
                "yankReason": yank_reason,
            }
            return skill.with_hub(name, pin)

        return [s for s in await asyncio.gather(*(one(r) for r in rows)) if s is not None]

    async def workspace(self, user_id: str) -> list[Skill]:
        """skills/<name>/... at the workspace root, as far as the user may read it."""
        try:
            files = await self._session(user_id).files(None)
        except ForbiddenError:
            return []  # No access to the workspace root: no workspace skills.
        infos = [
            f for f in await files.list() if f["path"].startswith("skills/") and f["size"] <= _MB
        ]

        async def read(info: dict[str, Any]) -> tuple[str, bytes] | None:
            data = self._blobs.get(info["sha256"])
            if data is None:
                found = await files.read(info["path"])
                if found is None:
                    return None
                data = found[1]
                self._remember(info["sha256"], data)
            return info["path"], data

        read_files = await asyncio.gather(*(read(i) for i in infos))
        return workspace_skills([f for f in read_files if f is not None])

    def _remember(self, sha256: str, data: bytes) -> None:
        if len(self._blobs) >= _BLOB_CACHE_SIZE:
            del self._blobs[next(iter(self._blobs))]
        self._blobs[sha256] = data


# Hub skills with their newest version that isn't yanked (else the newest),
# this workspace's install and the open reports; the WHERE is added.
_LISTINGS = """
    SELECT h.id::text, h.name, h.owner_id::text, h.updated_at, v.id::text AS version_id, v.version AS latest,
           v.manifest, v.files, v.flags, v.verified_at IS NOT NULL AS verified, v.yanked_at IS NOT NULL AS yanked,
           coalesce(u.name, u.email) AS publisher, iv.version AS installed,
           (SELECT count(*)::int FROM hub_skill_reports r
            WHERE r.hub_skill_id = h.id AND r.dismissed_at IS NULL) AS reports
    FROM hub_skills h
    JOIN LATERAL (
      SELECT id, version, manifest, files, flags, verified_at, yanked_at FROM hub_skill_versions
      WHERE hub_skill_id = h.id ORDER BY (yanked_at IS NULL) DESC, version DESC LIMIT 1
    ) v ON true
    LEFT JOIN users u ON u.id = h.owner_id
    LEFT JOIN skill_installs i ON i.hub_skill_id = h.id AND i.workspace_id = %s
    LEFT JOIN hub_skill_versions iv ON iv.id = i.version_id
"""
_LISTING_KEYS = [
    "id",
    "name",
    "owner_id",
    "updated_at",
    "version_id",
    "latest",
    "manifest",
    "files",
    "flags",
    "verified",
    "yanked",
    "publisher",
    "installed",
    "reports",
]


class SkillHub:
    def __init__(self, storage: Storage, skills: SkillService, admins: frozenset[str]) -> None:
        self.storage = storage
        self.skills = skills
        self.admins = admins

    @property
    def ws(self) -> str:
        return self.storage.workspace_id

    async def list(self, user_id: str, query: str = "") -> dict[str, Any]:
        """The hub's skills, newest first; `query` matches names and descriptions."""
        role = await self._open(user_id, "viewer")
        like = "%" + re.sub(r"[\\%_]", lambda m: "\\" + m.group(0), js_trim(query)) + "%"
        rows = await self._listings(
            "WHERE h.name ILIKE %s OR v.manifest->>'description' ILIKE %s ORDER BY h.updated_at DESC LIMIT 100",
            (like, like),
        )
        await self._scanned(rows)
        admin = await self.is_admin(user_id)
        return {
            "skills": [self._listing(row, user_id, admin) for row in rows],
            "canInstall": at_least(role, "editor"),
            "canPublish": at_least(role, "owner"),
            "isAdmin": admin,
        }

    async def detail(self, user_id: str, name: str, version: int | None = None) -> dict[str, Any]:
        """One hub skill with its versions, showing `version` (default the latest)."""
        await self._open(user_id, "viewer")
        found = await self._listings("WHERE h.name = %s", (name,))
        if not found:
            raise HubNotFoundError(f"No skill named {name} on the hub")
        row = found[0]
        async with self.storage.pool.connection() as conn:
            cur = await conn.execute(
                """
                SELECT v.id::text AS version_id, v.version, v.published_at, v.files, v.manifest, v.flags,
                       v.verified_at IS NOT NULL AS verified, v.yanked_at IS NOT NULL AS yanked, v.yank_reason,
                       coalesce(u.name, u.email) AS published_by
                FROM hub_skill_versions v LEFT JOIN users u ON u.id = v.published_by
                WHERE v.hub_skill_id = %s
                ORDER BY v.version DESC""",
                (row["id"],),
            )
            keys = [c.name for c in cur.description]  # type: ignore[union-attr]
            versions = [dict(zip(keys, r, strict=True)) for r in await cur.fetchall()]
        await self._scanned([row, *versions])
        wanted = version if version is not None else row["latest"]
        shown = next((v for v in versions if v["version"] == wanted), None)
        if shown is None:
            raise HubNotFoundError(f"{name} has no version {version}")
        main = next((f for f in shown["files"] if f["path"] == "SKILL.md"), None)
        admin = await self.is_admin(user_id)
        mine = row["owner_id"] == user_id
        open_reports = None
        if admin or mine:
            async with self.storage.pool.connection() as conn:
                cur = await conn.execute(
                    """
                    SELECT r.id::text, r.version, r.reason, r.created_at, coalesce(u.name, u.email) AS reporter
                    FROM hub_skill_reports r LEFT JOIN users u ON u.id = r.reporter_id
                    WHERE r.hub_skill_id = %s AND r.dismissed_at IS NULL
                    ORDER BY r.created_at DESC""",
                    (row["id"],),
                )
                open_reports = [
                    {
                        "id": id_,
                        "version": v,
                        "reason": reason,
                        "reporter": reporter,
                        "createdAt": iso(created),
                    }
                    for id_, v, reason, created, reporter in await cur.fetchall()
                ]
        return {
            **self._listing(row, user_id, admin),
            "versions": [
                {
                    "version": v["version"],
                    "publishedAt": iso(v["published_at"]),
                    "publishedBy": v["published_by"],
                    "files": len(v["files"]),
                    "size": sum(f["size"] for f in v["files"]),
                    "needsExecution": v["manifest"]["needsExecution"],
                    "verified": v["verified"],
                    "yanked": v["yanked"],
                    "yankReason": v["yank_reason"],
                    "flags": v["flags"] or [],
                }
                for v in versions
            ],
            "version": shown["version"],
            "skillMd": decode_text(await self.skills.blob(main["sha256"])) if main else "",
            "canModerate": admin,
            "canYank": admin or mine,
            "openReports": open_reports,
        }

    async def diff(
        self, user_id: str, name: str, before_version: int, after_version: int
    ) -> dict[str, Any]:
        """What changed between two versions, file by file (for reviewing an update)."""
        await self._open(user_id, "viewer")
        async with self.storage.pool.connection() as conn:
            cur = await conn.execute(
                """
                SELECT v.id::text AS version_id, v.version, v.files, v.flags
                FROM hub_skills h JOIN hub_skill_versions v ON v.hub_skill_id = h.id
                WHERE h.name = %s AND v.version IN (%s, %s)""",
                (name, before_version, after_version),
            )
            rows = [
                {"version_id": vid, "version": v, "files": files, "flags": flags}
                for vid, v, files, flags in await cur.fetchall()
            ]
        before = next((r for r in rows if r["version"] == before_version), None)
        after = next((r for r in rows if r["version"] == after_version), None)
        if before is None or after is None:
            missing = before_version if before is None else after_version
            raise HubNotFoundError(f"{name} has no version {missing} on the hub")
        await self._scanned([after])

        async def text(file: dict[str, Any] | None) -> str | None:
            if file is None or file["size"] > LARGE_FILE_BYTES:
                return None
            data = await self.skills.blob(file["sha256"])
            return None if b"\0" in data else strict_text(data)

        old = {f["path"]: f for f in before["files"]}
        now = {f["path"]: f for f in after["files"]}
        files = []
        for path in sorted({*old, *now}, key=code_unit_key):
            a, b = old.get(path), now.get(path)
            if a and b and a["sha256"] == b["sha256"]:
                continue
            before_text, after_text = await asyncio.gather(text(a), text(b))
            files.append(
                {
                    "path": path,
                    "change": "added" if not a else "removed" if not b else "changed",
                    "before": before_text,
                    "after": after_text,
                    "binary": (bool(a) and before_text is None) or (bool(b) and after_text is None),
                }
            )
        return {
            "name": name,
            "from": before_version,
            "to": after_version,
            "files": files,
            "flags": after["flags"] or [],
        }

    async def verify(self, user_id: str, name: str, version: int, verified: bool) -> dict[str, Any]:
        """Marks a version verified, or takes that back (hub admins)."""
        await self._open(user_id, "viewer")
        if not await self.is_admin(user_id):
            raise SkillForbiddenError("Only hub admins can verify skills")
        async with self.storage.pool.connection() as conn, conn.transaction():
            cur = await conn.execute(
                """
                UPDATE hub_skill_versions v
                SET verified_at = CASE WHEN %s THEN now() END, verified_by = %s
                FROM hub_skills h
                WHERE v.hub_skill_id = h.id AND h.name = %s AND v.version = %s""",
                (verified, user_id if verified else None, name, version),
            )
            if not cur.rowcount:
                raise HubNotFoundError(f"{name} has no version {version} on the hub")
            action = "skill.verify" if verified else "skill.unverify"
            await self._audit(conn, user_id, action, {"name": name, "version": version})
        return {"name": name, "version": version, "verified": verified}

    async def yank(
        self, user_id: str, name: str, version: int, yanked: bool, reason: str | None
    ) -> dict[str, Any]:
        """Yanks a version (its publisher or a hub admin): it can no longer be installed. False restores it."""
        await self._open(user_id, "viewer")
        why = js_trim(reason or "")
        if utf16_len(why) > 500:
            raise HubError("Keep the reason under 500 characters")
        async with self.storage.pool.connection() as conn:
            cur = await conn.execute(
                "SELECT owner_id::text FROM hub_skills WHERE name = %s", (name,)
            )
            hub = await cur.fetchone()
        if hub is None:
            raise HubNotFoundError(f"No skill named {name} on the hub")
        if hub[0] != user_id and not await self.is_admin(user_id):
            raise SkillForbiddenError("Only its publisher or a hub admin can yank a version")
        async with self.storage.pool.connection() as conn, conn.transaction():
            cur = await conn.execute(
                """
                UPDATE hub_skill_versions v
                SET yanked_at = CASE WHEN %s THEN now() END, yanked_by = %s, yank_reason = %s
                FROM hub_skills h
                WHERE v.hub_skill_id = h.id AND h.name = %s AND v.version = %s""",
                (
                    yanked,
                    user_id if yanked else None,
                    why if yanked and why else None,
                    name,
                    version,
                ),
            )
            if not cur.rowcount:
                raise HubNotFoundError(f"{name} has no version {version} on the hub")
            target: dict[str, Any] = {
                "name": name,
                "version": version,
                **({"reason": why} if yanked and why else {}),
            }
            await self._audit(conn, user_id, "skill.yank" if yanked else "skill.unyank", target)
        return {"name": name, "version": version, "yanked": yanked}

    async def report(
        self, user_id: str, name: str, reason: Any, version: int | None = None
    ) -> dict[str, Any]:
        """Reports a hub skill to its publisher and the hub admins; reporting again replaces your open report."""
        await self._open(user_id, "viewer")
        why = js_trim(reason) if isinstance(reason, str) else ""
        if not why:
            raise HubError("Say what's wrong with it")
        if utf16_len(why) > 2000:
            raise HubError("Keep the report under 2000 characters")
        async with self.storage.pool.connection() as conn:
            cur = await conn.execute(
                """
                SELECT id, EXISTS (
                  SELECT 1 FROM hub_skill_versions WHERE hub_skill_id = hub_skills.id AND version = %s
                ) AS has_version
                FROM hub_skills WHERE name = %s""",
                (version if version is not None else 0, name),
            )
            hub = await cur.fetchone()
        if hub is None:
            raise HubNotFoundError(f"No skill named {name} on the hub")
        if version is not None and not hub[1]:
            raise HubNotFoundError(f"{name} has no version {version}")
        async with self.storage.pool.connection() as conn, conn.transaction():
            cur = await conn.execute(
                """
                INSERT INTO hub_skill_reports (hub_skill_id, version, reporter_id, reason)
                VALUES (%s, %s, %s, %s)
                ON CONFLICT (hub_skill_id, reporter_id) WHERE dismissed_at IS NULL
                DO UPDATE SET reason = EXCLUDED.reason, version = EXCLUDED.version, created_at = now()
                RETURNING id::text""",
                (hub[0], version, user_id, why),
            )
            (report_id,) = await cur.fetchone()  # type: ignore[misc]
            await self._audit(conn, user_id, "skill.report", {"name": name, "version": version})
        return {"id": report_id}

    async def dismiss_report(self, user_id: str, name: str, report_id: str) -> dict[str, Any]:
        """Closes a report (hub admins)."""
        await self._open(user_id, "viewer")
        if not await self.is_admin(user_id):
            raise SkillForbiddenError("Only hub admins can dismiss reports")
        if not is_uuid(report_id):
            raise HubNotFoundError("No such report")
        async with self.storage.pool.connection() as conn, conn.transaction():
            cur = await conn.execute(
                """
                UPDATE hub_skill_reports r SET dismissed_at = now(), dismissed_by = %s
                FROM hub_skills h
                WHERE r.hub_skill_id = h.id AND h.name = %s AND r.id = %s AND r.dismissed_at IS NULL""",
                (user_id, name, report_id),
            )
            if not cur.rowcount:
                raise HubNotFoundError("No such open report")
            await self._audit(
                conn, user_id, "skill.report.dismiss", {"name": name, "id": report_id}
            )
        return {"id": report_id, "dismissed": True}

    async def publish(self, user_id: str, name: str) -> dict[str, Any]:
        """
        Publishes the workspace's skill as the next version of the hub skill of
        that name (creating it, owned by this user, if it's new). Unchanged
        files add no version.
        """
        await self._open(user_id, "owner", "Only owners of the workspace can publish to the hub")
        skill = await self.skills.find(user_id, name)
        if skill is None:
            raise HubNotFoundError(f"No skill named {name}")
        if skill.source != "workspace":
            raise HubError(
                f"{name} comes from the hub; fork it into the workspace to publish your own version"
                if skill.source == "hub"
                else f"{name} is built in; only the workspace's own skills can be published"
            )
        # The catalog leaves out files over the limits; refuse rather than publish part of the folder.
        folder = skill.path[: -len("SKILL.md")]  # type: ignore[index]
        files_here = await self.skills._session(user_id).files(None)
        listed = [f for f in await files_here.list() if f["path"].startswith(folder)]
        total = sum(f["size"] for f in listed)
        if (
            len(listed) > MAX_FILES
            or total > MAX_SKILL_BYTES
            or any(f["size"] > MAX_SKILL_FILE_BYTES for f in listed)
        ):
            raise HubError(
                f"{name} is too big to publish: a skill may have at most {MAX_FILES} files and "
                f"{MAX_SKILL_BYTES // _MB} MB, each file {MAX_SKILL_FILE_BYTES // _MB} MB"
            )
        files = []
        for file in sorted(skill.files, key=lambda f: collation_key(f.path)):
            sha256 = sha256_hex(file.data)
            await self.storage.require_blobs().put(sha256, file.data, mime_for_path(file.path))
            files.append({"path": file.path, "sha256": sha256, "size": len(file.data)})
        fingerprint = sha256_hex("\n".join(f"{f['path']}\0{f['sha256']}" for f in files).encode())

        async with self.storage.pool.connection() as conn, conn.transaction():
            await conn.execute(
                "INSERT INTO hub_skills (name, owner_id) VALUES (%s, %s) ON CONFLICT (name) DO NOTHING",
                (name, user_id),
            )
            cur = await conn.execute(
                "SELECT id, owner_id::text FROM hub_skills WHERE name = %s FOR UPDATE", (name,)
            )
            hub_id, owner = await cur.fetchone()  # type: ignore[misc]
            if owner != user_id:
                raise SkillForbiddenError(f"{name} on the hub was published by someone else")
            cur = await conn.execute(
                "SELECT version, fingerprint FROM hub_skill_versions WHERE hub_skill_id = %s ORDER BY version DESC LIMIT 1",
                (hub_id,),
            )
            latest = await cur.fetchone()
            if latest and latest[1] == fingerprint:
                return {"name": name, "version": latest[0], "unchanged": True}
            version = (latest[0] if latest else 0) + 1
            await conn.execute(
                """
                INSERT INTO hub_skill_versions (hub_skill_id, version, manifest, files, fingerprint, published_by, flags)
                VALUES (%s, %s, %s, %s, %s, %s, %s)""",
                (
                    hub_id,
                    version,
                    Jsonb(manifest_of(skill)),
                    Jsonb(files),
                    fingerprint,
                    user_id,
                    Jsonb(scan_skill(skill.files)),
                ),
            )
            await conn.execute("UPDATE hub_skills SET updated_at = now() WHERE id = %s", (hub_id,))
            await self._audit(conn, user_id, "skill.publish", {"name": name, "version": version})
        return {"name": name, "version": version, "unchanged": False}

    async def install(self, user_id: str, name: str, version: int | None = None) -> dict[str, Any]:
        """Installs (or moves the workspace's install to) a version, by default the newest that isn't yanked."""
        await self._open(
            user_id, "editor", "Installing skills needs editor access to the workspace"
        )
        pinned = "" if version is None else "AND v.version = %s"
        async with self.storage.pool.connection() as conn:
            cur = await conn.execute(
                f"""
                SELECT h.id, v.id, v.version, v.yanked_at IS NOT NULL AS yanked, v.yank_reason,
                       i.version_id AS current
                FROM hub_skills h JOIN hub_skill_versions v ON v.hub_skill_id = h.id
                LEFT JOIN skill_installs i ON i.hub_skill_id = h.id AND i.workspace_id = %s
                WHERE h.name = %s {pinned}
                ORDER BY (v.yanked_at IS NULL) DESC, v.version DESC LIMIT 1""",  # type: ignore[arg-type]
                (self.ws, name) if version is None else (self.ws, name, version),
            )
            row = await cur.fetchone()
        if row is None:
            raise HubNotFoundError(
                f"No skill named {name} on the hub"
                if version is None
                else f"{name} has no version {version}"
            )
        hub_id, version_id, found, yanked, yank_reason, current = row
        if yanked and current != version_id:
            why = f" ({yank_reason})" if yank_reason else ""
            raise HubError(f"{name} v{found} was yanked{why}, so it can't be installed")
        # A workspace skill of that name would hide the install (forking is what replaces one with the other).
        existing = await self.skills.find(user_id, name)
        if existing and existing.source == "workspace":
            raise HubConflictError(
                f"The workspace already has a skill named {name}; rename or remove it to install this one"
            )
        async with self.storage.pool.connection() as conn, conn.transaction():
            await conn.execute(
                """
                INSERT INTO skill_installs (workspace_id, hub_skill_id, version_id, installed_by)
                VALUES (%s, %s, %s, %s)
                ON CONFLICT (workspace_id, hub_skill_id)
                DO UPDATE SET version_id = EXCLUDED.version_id, installed_by = EXCLUDED.installed_by,
                              installed_at = now()""",
                (self.ws, hub_id, version_id, user_id),
            )
            await self._audit(conn, user_id, "skill.install", {"name": name, "version": found})
        return {"name": name, "version": found}

    async def uninstall(self, user_id: str, name: str) -> bool:
        await self._open(user_id, "editor", "Removing skills needs editor access to the workspace")
        async with self.storage.pool.connection() as conn, conn.transaction():
            cur = await conn.execute(
                """
                DELETE FROM skill_installs i USING hub_skills h
                WHERE i.hub_skill_id = h.id AND h.name = %s AND i.workspace_id = %s""",
                (name, self.ws),
            )
            removed = cur.rowcount
            if removed:
                await self._audit(conn, user_id, "skill.uninstall", {"name": name})
        return removed > 0

    async def fork(self, user_id: str, name: str) -> dict[str, Any]:
        """Copies the installed version (else the latest) into the workspace's skills/<name>/, replacing the install."""
        await self._open(user_id, "editor", "Forking skills needs editor access to the workspace")
        async with self.storage.pool.connection() as conn:
            cur = await conn.execute(
                """
                SELECT v.files
                FROM hub_skills h
                JOIN hub_skill_versions v ON v.hub_skill_id = h.id
                LEFT JOIN skill_installs i ON i.hub_skill_id = h.id AND i.workspace_id = %s
                WHERE h.name = %s
                ORDER BY (v.id = i.version_id) DESC NULLS LAST, (v.yanked_at IS NULL) DESC, v.version DESC
                LIMIT 1""",
                (self.ws, name),
            )
            row = await cur.fetchone()
        if row is None:
            raise HubNotFoundError(f"No skill named {name} on the hub")
        await self._write_skill(user_id, name, await self.skills.files_of(row[0]), replace=False)
        await self.uninstall(user_id, name)
        return {"name": name, "path": f"skills/{name}/SKILL.md"}

    async def export_zip(self, user_id: str, name: str) -> bytes:
        """A skill you can see (any source) as a .zip: <name>/SKILL.md and its files."""
        skill = await self.skills.find(user_id, name)
        if skill is None:
            raise HubNotFoundError(f"No skill named {name}")
        out = io.BytesIO()
        with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as archive:
            for file in skill.files:
                archive.writestr(f"{name}/{file.path}", file.data)
        return out.getvalue()

    async def import_zip(
        self, user_id: str, data: bytes, *, replace: bool = False, filename: str | None = None
    ) -> dict[str, Any]:
        """
        Adds a skill from a .zip to the workspace as skills/<name>/. Its SKILL.md
        may be at the top of the zip or in one folder. With `replace`, an
        existing skill folder of that name is replaced; otherwise that's a conflict.
        """
        if not at_least(await self.skills.root_role(user_id), "editor"):
            raise SkillForbiddenError("Importing skills needs editor access to the workspace")
        entries = read_zip(data)
        folders = {e.path.split("/")[0] for e in entries}
        if any(e.path == "SKILL.md" for e in entries):
            stem = re.sub(r"\.zip\Z", "", filename or "", flags=re.IGNORECASE | re.ASCII).lower()
            folder = re.sub(r"^-+|-+$", "", re.sub(r"[^a-z0-9-]+", "-", stem))
            files = entries
        elif len(folders) == 1 and any(
            e.path == f"{next(iter(folders))}/SKILL.md" for e in entries
        ):
            folder = next(iter(folders))
            files = [SkillFile(e.path[len(folder) + 1 :], e.data) for e in entries]
        else:
            raise HubError("The zip needs a SKILL.md, at its top or in a single folder")
        skill = skill_from_files(
            folder if is_skill_name(folder) else "imported-skill", files, "workspace", None
        )
        if skill is None:
            raise HubError("SKILL.md has no usable name: give it `name:` in its front matter")
        await self._write_skill(user_id, skill.name, files, replace=replace)
        return {"name": skill.name, "path": f"skills/{skill.name}/SKILL.md", "files": len(files)}

    async def delete_skill(self, user_id: str, name: str) -> dict[str, Any]:
        """
        Deletes the workspace skill called `name`: every file in its folder, as
        the user (editors). SKILL.md goes last, so a failure part way leaves the
        skill listed to try again.
        """
        await self._open(user_id, "editor", "Deleting skills needs editor access to the workspace")
        skill = await self.skills.find(user_id, name)
        if skill is None or skill.source != "workspace" or not skill.path:
            raise HubNotFoundError(f"The workspace has no skill named {name}")
        session = await self.skills._session(user_id, "user").files(None)
        prefix = skill.path[: -len("SKILL.md")]
        main = f"{prefix}SKILL.md"
        files = sorted(
            (f for f in await session.list() if f["path"].startswith(prefix)),
            key=lambda f: f["path"] == main,
        )
        for file in files:
            await session.remove(file["path"])
        return {"name": name, "deleted": len(files)}

    async def _write_skill(
        self, user_id: str, name: str, files: list[SkillFile], *, replace: bool
    ) -> None:
        """Writes a skill's files to skills/<name>/ as the user."""
        session: FilesSession = await self.skills._session(user_id, "user").files(None)
        prefix = f"skills/{name}/"
        existing = [f for f in await session.list() if f["path"].startswith(prefix)]
        if existing and not replace:
            raise HubConflictError(f"The workspace already has a skill folder {prefix}")
        for file in files:
            await session.write(prefix + file.path, file.data)
        kept = {prefix + f.path for f in files}
        for old in existing:
            if old["path"] not in kept:
                await session.remove(old["path"])

    async def _open(self, user_id: str, minimum: Role, why: str | None = None) -> Role:
        """The user's role at the root, which must be at least `minimum`."""
        role = await self.storage.access.role(user_id, None)
        if not role or not at_least(role, minimum):
            raise SkillForbiddenError(why or "The hub needs access to the workspace")
        return role

    async def _audit(self, conn, user_id: str, action: str, target: dict[str, Any]) -> None:
        await self.storage.access.audit(conn, Principal(user_id=user_id), action, target)

    async def is_admin(self, user_id: str) -> bool:
        """Hub admins: HUB_ADMINS (emails or login subjects), and the local user when there is no login."""
        async with self.storage.pool.connection() as conn:
            cur = await conn.execute("SELECT subject, email FROM users WHERE id = %s", (user_id,))
            user = await cur.fetchone()
        if user is None:
            return False
        subject, email = user
        return (
            subject == "local"
            or subject.lower() in self.admins
            or bool(email and email.lower() in self.admins)
        )

    async def _scanned(self, rows: list[dict[str, Any]]) -> None:
        """Scans versions published before scanning existed (flags NULL), and keeps the result."""
        for row in rows:
            if row["flags"] is not None:
                continue
            row["flags"] = scan_skill(await self.skills.files_of(row["files"]))
            async with self.storage.pool.connection() as conn:
                await conn.execute(
                    "UPDATE hub_skill_versions SET flags = %s WHERE id = %s",
                    (Jsonb(row["flags"]), row["version_id"]),
                )

    async def _listings(self, where: str, params: tuple) -> list[dict[str, Any]]:
        async with self.storage.pool.connection() as conn:
            cur = await conn.execute(_LISTINGS + where, (self.ws, *params))  # type: ignore[arg-type]
            return [dict(zip(_LISTING_KEYS, r, strict=True)) for r in await cur.fetchall()]

    @staticmethod
    def _listing(row: dict[str, Any], user_id: str, admin: bool) -> dict[str, Any]:
        mine = row["owner_id"] == user_id
        return {
            **row["manifest"],
            "name": row["name"],
            "publisher": row["publisher"],
            "mine": mine,
            "latest": row["latest"],
            "verified": row["verified"],
            "yanked": row["yanked"],
            "flags": len(row["flags"] or []),
            "updatedAt": iso(row["updated_at"]),
            "installed": row["installed"],
            "reports": row["reports"] if admin or mine else None,
        }


_IGNORED = re.compile(r"(^|/)(__MACOSX/|\.DS_Store\Z|Thumbs\.db\Z)")


def read_zip(data: bytes) -> list[SkillFile]:
    """A zip's files, within the skill limits; directories and OS clutter left out (readZip in hub.ts)."""
    too_big = f"A skill may be at most {MAX_SKILL_BYTES // _MB} MB, each file {MAX_SKILL_FILE_BYTES // _MB} MB"
    try:
        # Names without the UTF-8 flag read as Latin-1, as fflate reads them.
        archive = zipfile.ZipFile(io.BytesIO(data), metadata_encoding="latin-1")
        count = declared = 0
        wanted: list[zipfile.ZipInfo] = []
        for info in archive.infolist():
            if info.filename.endswith("/") or _IGNORED.search(info.filename):
                continue
            count += 1
            declared += info.file_size
            if count > MAX_FILES:
                raise HubError(f"A skill may have at most {MAX_FILES} files")
            if info.file_size > MAX_SKILL_FILE_BYTES or declared > MAX_SKILL_BYTES:
                raise HubError(too_big)
            if info.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED):
                raise zipfile.BadZipFile("unsupported compression")
            wanted.append(info)
        # A name given twice keeps its first place and its last bytes, as an object would.
        unzipped: dict[str, bytes] = {}
        for info in wanted:
            unzipped[info.filename] = archive.read(info)
    except HubError:
        raise
    except Exception as err:
        raise HubError("That isn't a readable .zip file") from err
    total = 0
    files: list[SkillFile] = []
    for name, content in unzipped.items():
        total += len(content)
        if len(content) > MAX_SKILL_FILE_BYTES or total > MAX_SKILL_BYTES:
            raise HubError(f"A skill may be at most {MAX_SKILL_BYTES // _MB} MB")
        try:
            files.append(SkillFile(normalize_path(name), content))
        except InvalidPathError as err:
            raise HubError(f"The zip has an invalid path: {name}") from err
    return files
