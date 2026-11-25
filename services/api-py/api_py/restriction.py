"""Restricted Knowledge nodes (docs/restricted-knowledge.md).

A restricted node stops grants above it (on its ancestors and on the
workspace root) from reaching it or anything below it. The boundary itself
lives in SQL (028_restricted_nodes.sql: restriction_boundary, role_within and
the three access functions); this module answers who has access to a node and
why, previews what restricting or lifting would change, and makes the change.
Each function runs on the connection it is given, with the owner's rights,
since it reads other people's grants.
"""

from __future__ import annotations

from typing import Any

from psycopg import AsyncConnection

from .access import ROLES, iso

_RANK: dict[str, int] = {role: n for n, role in enumerate(ROLES, start=1)}


def rank(role: str | None) -> int:
    return _RANK.get(role, 0) if role else 0


async def node_row(
    conn: AsyncConnection, ws: str, node_id: str, lock: bool = False
) -> dict[str, Any] | None:
    """The live node's path, name and restriction, or None."""
    cur = await conn.execute(
        """
        SELECT n.path::text, n.name, n.restricted, n.restricted_at, n.restricted_by, u.name,
               restriction_boundary(n.workspace_id, n.path)::text
        FROM nodes n LEFT JOIN users u ON u.id = n.restricted_by
        WHERE n.id = %s AND n.workspace_id = %s AND n.deleted_at IS NULL"""
        + (" FOR UPDATE OF n" if lock else ""),  # pyrefly: ignore[bad-argument-type]
        (node_id, ws),
    )
    row = await cur.fetchone()
    if not row:
        return None
    path, name, restricted, at, by, by_name, boundary = row
    return {
        "id": node_id,
        "path": path,
        "name": name,
        "restricted": restricted,
        "restrictedAt": iso(at),
        "restrictedBy": {"id": str(by), "name": by_name} if by else None,
        "boundary": boundary,
    }


async def sources(
    conn: AsyncConnection, ws: str, path: str, boundary: str | None, me: str
) -> list[dict[str, Any]]:
    """
    Each member's grants that reach the node at `path`, counting only grants at
    or below `boundary` (and root grants only without one): one row per member
    and grant, strongest first. The built-in local user is left out, as in the
    member list, unless it is `me`, the one asking.
    """
    cur = await conn.execute(
        """
        SELECT u.id, u.name, g.role, g.node_id, a.name, grp.id, grp.name, g.takeover, g.created_at,
               g.principal_type
        FROM grants g
        LEFT JOIN nodes a ON a.id = g.node_id
        LEFT JOIN groups grp ON g.principal_type = 'group' AND grp.id = g.principal_id
        JOIN workspace_members m ON m.workspace_id = g.workspace_id
        JOIN users u ON u.id = m.user_id
        WHERE g.workspace_id = %(ws)s
          AND ((g.node_id IS NULL AND %(b)s::ltree IS NULL)
               OR (a.path @> %(p)s::ltree AND (%(b)s::ltree IS NULL OR %(b)s::ltree @> a.path)))
          AND grant_holder(u.id, g.principal_type, g.principal_id)
          AND (u.subject <> 'local' OR u.id = %(me)s)
        ORDER BY lower(coalesce(u.name, u.email, '')), u.id, role_rank(g.role) DESC,
                 nlevel(a.path) DESC NULLS LAST, g.principal_type DESC, lower(grp.name)""",
        {"ws": ws, "p": path, "b": boundary, "me": me},
    )
    return [
        {
            "userId": str(uid),
            "userName": uname,
            "role": role,
            "nodeId": str(node) if node else None,
            "nodeName": node_name,
            "group": {"id": str(gid), "name": gname} if ptype == "group" else None,
            "takeover": takeover,
            "since": iso(created),
        }
        for uid, uname, role, node, node_name, gid, gname, takeover, created, ptype in await cur.fetchall()
    ]


def _source(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "role": row["role"],
        "node": {"id": row["nodeId"], "name": row["nodeName"]} if row["nodeId"] else None,
        "group": row["group"],
        "takeover": row["takeover"],
        "since": row["since"],
    }


def people(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Rows from sources(), as one entry per person: their role and every source of it."""
    found: dict[str, dict[str, Any]] = {}
    for row in rows:
        person = found.setdefault(
            row["userId"],
            {
                "user": {"id": row["userId"], "name": row["userName"]},
                "role": row["role"],
                "sources": [],
            },
        )
        person["sources"].append(_source(row))
    return list(found.values())


async def explain(conn: AsyncConnection, ws: str, node: dict[str, Any], me: str) -> dict[str, Any]:
    """Who can open the node, with their role and why (GET /nodes/{id}/access)."""
    boundary = node["boundary"]
    stops = None
    if boundary is not None:
        cur = await conn.execute(
            "SELECT id, name FROM nodes WHERE workspace_id = %s AND path = %s::ltree",
            (ws, boundary),
        )
        found = await cur.fetchone()
        stops = {"id": str(found[0]), "name": found[1]} if found else None
    return {
        "nodeId": node["id"],
        "restricted": node["restricted"],
        "inheritanceStopsAt": stops,
        "people": people(await sources(conn, ws, node["path"], boundary, me)),
    }


def _parent(path: str) -> str | None:
    labels = path.split(".")
    return ".".join(labels[:-1]) or None


async def changes(
    conn: AsyncConnection, ws: str, node: dict[str, Any], me: str
) -> list[dict[str, Any]]:
    """
    What switching the node's restriction would change: for an open node, who
    would lose access (or keep less) if it were restricted, through which grant,
    and how many of their Experiments below it would close to them; for a
    restricted node, who would gain access if it were lifted. `me`, who asks,
    isn't listed for restricting: they keep Full access.
    """
    path, node_id = node["path"], node["id"]
    if node["restricted"]:
        # Lifting it: the next boundary up, if any, decides.
        parent = _parent(path)
        cur = await conn.execute("SELECT restriction_boundary(%s, %s::ltree)::text", (ws, parent))
        (after_boundary,) = await cur.fetchone()  # pyrefly: ignore[not-iterable]
        rows = await sources(conn, ws, path, after_boundary, me)
        now_rows = [r for r in rows if r["nodeId"] == node_id]
        after_rows = rows
    else:
        rows = await sources(conn, ws, path, node["boundary"], me)
        now_rows = rows
        after_rows = [r for r in rows if r["nodeId"] == node_id]

    def best(of: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
        top: dict[str, dict[str, Any]] = {}
        for row in of:  # strongest first per person
            top.setdefault(row["userId"], row)
        return top

    now, after = best(now_rows), best(after_rows)
    changed: list[dict[str, Any]] = []
    for uid in dict.fromkeys(r["userId"] for r in rows):
        if uid == me and not node["restricted"]:
            continue
        was, becomes = now.get(uid), after.get(uid)
        was_role: str | None = was["role"] if was else None
        becomes_role: str | None = becomes["role"] if becomes else None
        if rank(was_role) == rank(becomes_role):
            continue
        # The grant that gives the role being lost, or the one being gained.
        through = becomes if node["restricted"] else was
        row = through or was or becomes
        assert row is not None
        changed.append(
            {
                "user": {"id": uid, "name": row["userName"]},
                "role": was_role,
                "becomes": becomes_role,
                "through": _source(through) if through else None,
                "experiments": 0,
            }
        )
    losing = [c["user"]["id"] for c in changed if rank(c["becomes"]) < rank(c["role"])]
    if losing and not node["restricted"]:
        # Their Experiments below the node that they could open now and couldn't then.
        cur = await conn.execute(
            """
            SELECT e.maintainer_id, count(*)
            FROM experiments e JOIN nodes x ON x.id = e.node_id
            WHERE e.workspace_id = %(ws)s AND e.deleted_at IS NULL AND x.path <@ %(p)s::ltree
              AND e.maintainer_id = ANY(%(users)s::uuid[])
              AND path_role(%(ws)s, e.maintainer_id, x.path) IS NOT NULL
              AND role_within(%(ws)s, e.maintainer_id, x.path,
                    CASE WHEN restriction_boundary(%(ws)s, x.path) <@ %(p)s::ltree
                         THEN restriction_boundary(%(ws)s, x.path) ELSE %(p)s::ltree END) IS NULL
            GROUP BY e.maintainer_id""",
            {"ws": ws, "p": path, "users": losing},
        )
        counts = {str(uid): n for uid, n in await cur.fetchall()}
        for change in changed:
            change["experiments"] = int(counts.get(change["user"]["id"], 0))
    return changed
