"""Search over workspace files, as SearchService in apps/agent/src/storage/search.ts.

Full text (006_search.sql): each blob's text is indexed once, when a version
holding it is written (text_index.py), and a search matches the current
version of every live file the user may read, by content or by path,
optionally inside one subtree, ranking files near where the user is working
first. With an embedding model (semantic.py), passages close in meaning to
the query are found too. index_all() indexes files written before search
existed; the server runs it once storage opens.
"""

from __future__ import annotations

import logging
import math
import re
from dataclasses import dataclass
from typing import Any

from psycopg import AsyncConnection
from psycopg_pool import AsyncConnectionPool

from .access import is_uuid, iso
from .blobs import BlobStore, is_not_found
from .paths import JS_SPACE, js_trim, utf16_len
from .semantic import SemanticIndex
from .text_index import from_units, index_blob, to_units

logger = logging.getLogger("api_py")

SNIPPET_CHARS = 220
MAX_RESULTS = 50
# Files each kind of search hands over for merging.
CANDIDATES = 100
# Passages the meaning search looks at, before access and scope filters.
NEAREST = 200
# A meaning-only match at its best counts like a fair word match.
MEANING_WEIGHT = 0.5

_SPACES = re.compile(f"[{JS_SPACE}]+")
_TOKENS = re.compile(f'-?"[^"]*"?|[^{JS_SPACE}]+')
_EXACT = re.compile(f'(^|[{JS_SPACE}])-[^{JS_SPACE}]|"')


class SearchError(Exception):
    """The search can't be run as asked: no words, too long, an unknown scope (400)."""


def any_words(query: str) -> str:
    """The query's wanted words joined with `or`, for finding passages that could match (anyWords in search.ts)."""
    words = []
    for token in _TOKENS.findall(query):
        if token.startswith("-"):
            continue
        for word in _SPACES.split(token.replace('"', " ")):
            if word and word.lower() != "or":
                words.append(word)
    return " or ".join(words)


def _query_terms(query: str) -> list[str]:
    terms = (re.sub(r'^[-"]+|"+$', "", t).lower() for t in _SPACES.split(query))
    return [t for t in terms if t and t != "or"]


def snippet_for(body: str, query: str) -> str:
    """About SNIPPET_CHARS of `body` around the first query word in it, counted as JavaScript counts."""
    flat = to_units(js_trim(_SPACES.sub(" ", body)))
    if len(flat) <= SNIPPET_CHARS:
        return from_units(flat)
    lower = flat.lower()
    whole = lower.find(to_units(js_trim(query).lower()))
    hits = [i for i in (whole, *(lower.find(to_units(t)) for t in _query_terms(query))) if i >= 0]
    at = min(hits) if hits else 0
    start = max(0, min(at - 60, len(flat) - SNIPPET_CHARS))
    end = start + SNIPPET_CHARS
    text = from_units(js_trim(flat[start:end]))
    return f"{'…' if start > 0 else ''}{text}{'…' if end < len(flat) else ''}"


@dataclass
class _Where:
    user_id: str
    scope: str | None  # a node path to stay inside, or None for everywhere
    near: str  # the node path the user is at ("" = the root)
    working_in: str | None  # an experiment whose unchanged copies are kept


_COLUMNS = """
    f.id, f.path, f.kind, f.mime, f.node_id, f.experiment_id, f.updated_at, v.author_type,
    e.title AS experiment_title,
    coalesce(n.path, en.path, ''::ltree)::text AS place_path,
    tree_distance(coalesce(n.path, en.path, ''::ltree), %(near)s::ltree) AS distance"""

_PLACE_JOINS = """
    LEFT JOIN nodes n ON n.id = f.node_id
    LEFT JOIN file_versions fv ON fv.id = f.forked_from
    LEFT JOIN experiments e ON e.id = f.experiment_id
    LEFT JOIN nodes en ON en.id = e.node_id"""


def _filters(scoped: bool) -> str:
    # An experiment's unchanged copy of a node file would only repeat the
    # node's, except for someone working in that experiment.
    return """
    f.workspace_id = %(ws)s AND f.deleted_at IS NULL
    AND place_rank(f.workspace_id, %(user)s, f.node_id, f.experiment_id) >= 1
    AND NOT (fv.blob_sha256 IS NOT DISTINCT FROM v.blob_sha256
             AND f.experiment_id IS DISTINCT FROM %(working_in)s::uuid)""" + (
        " AND coalesce(n.path, en.path) <@ %(scope)s::ltree" if scoped else ""
    )


_FIELDS = ("id", "path", "kind", "mime", "node_id", "experiment_id", "updated_at", "author_type", "experiment_title",
           "place_path", "distance")  # fmt: skip


class SearchService:
    def __init__(
        self, workspace_id: str, blobs: BlobStore | None, semantic: SemanticIndex | None = None
    ) -> None:
        self.workspace_id = workspace_id
        self.blobs = blobs
        # Search by meaning, when this server runs an embedding model.
        self.semantic = semantic

    async def _visible_path(self, conn: AsyncConnection, user_id: str, node_id: str) -> str | None:
        """A node's path if `user_id` can see it (as in the tree), else None."""
        if not is_uuid(node_id):
            return None
        cur = await conn.execute(
            """
            SELECT path::text FROM nodes
            WHERE id = %s AND workspace_id = %s AND deleted_at IS NULL AND sees_path(workspace_id, %s, path)""",
            (node_id, self.workspace_id, user_id),
        )
        row = await cur.fetchone()
        return row[0] if row else None

    async def _experiment_path(
        self, conn: AsyncConnection, user_id: str, experiment_id: str
    ) -> str | None:
        if not is_uuid(experiment_id):
            return None
        cur = await conn.execute(
            """
            SELECT coalesce(n.path, ''::ltree)::text AS path
            FROM experiments e LEFT JOIN nodes n ON n.id = e.node_id
            WHERE e.id = %s AND e.workspace_id = %s AND experiment_access(%s, e.id) IS NOT NULL""",
            (experiment_id, self.workspace_id, user_id),
        )
        row = await cur.fetchone()
        return row[0] if row else None

    async def search(
        self,
        conn: AsyncConnection,
        user_id: str,
        query: str,
        *,
        scope: str | None = None,
        near: str | None = None,
        near_experiment: str | None = None,
        limit: int | None = None,
    ) -> list[dict[str, Any]]:
        """Files `user_id` may read that match `query`, best first. SearchError for a bad query or scope."""
        query = js_trim(query)
        if not query:
            raise SearchError("Search for at least one word")
        if utf16_len(query) > 500:
            raise SearchError("Search text is too long (500 characters at most)")
        limit = min(max(int(limit if limit is not None else 20), 1), MAX_RESULTS)

        scope_path = None
        if scope:
            scope_path = await self._visible_path(conn, user_id, scope)
            if scope_path is None:
                raise SearchError("No such knowledge node to search in")
        near_path = (
            await self._experiment_path(conn, user_id, near_experiment) if near_experiment else None
        )
        if near_path is None and near:
            near_path = await self._visible_path(conn, user_id, near)
        where = _Where(
            user_id=user_id,
            scope=scope_path,
            near=near_path or "",
            working_in=near_experiment if near_experiment and is_uuid(near_experiment) else None,
        )

        # Words always; meaning too when it's available and the query isn't
        # asking for exact words ("phrases", -exclusions).
        by_words = await self._by_words(conn, query, where)
        by_meaning = [] if _EXACT.search(query) else await self._by_meaning(conn, query, where)

        # One list: word matches score by relevance (plus 1 for a path match),
        # meaning matches add up to MEANING_WEIGHT by how close they are, and
        # files nearer where the user is rank higher.
        floor = self.semantic.min_similarity if self.semantic else 0.0
        merged: dict[str, dict[str, Any]] = {}
        for row in by_words:
            merged[row["id"]] = {
                **row,
                "words": float(row["score"]),
                "meaning": 0.0,
                "passage": row["body"],
            }
        for row in by_meaning:
            meaning = (float(row["similarity"]) - floor) / (1 - floor)
            seen = merged.get(row["id"])
            if seen:
                seen["meaning"] = meaning
                if seen["passage"] is None:
                    seen["passage"] = row["body"]
            else:
                merged[row["id"]] = {
                    **row,
                    "words": 0.0,
                    "meaning": meaning,
                    "passage": row["body"],
                }

        def rank(c: dict[str, Any]) -> tuple[float, float, str]:
            score = (c["words"] + MEANING_WEIGHT * c["meaning"]) / (1 + 0.25 * c["distance"])
            # Newer first, at the milliseconds a JavaScript Date keeps, then by path.
            return (-score, -math.floor(c["updated_at"].timestamp() * 1000), c["path"])

        best = sorted(merged.values(), key=rank)[:limit]
        lineages = await self._lineages(conn, [c["place_path"] for c in best])
        return [
            {
                "path": c["path"],
                "kind": c["kind"],
                "mime": c["mime"],
                "node": str(c["node_id"]) if c["node_id"] else None,
                "experiment": str(c["experiment_id"]) if c["experiment_id"] else None,
                "where": lineages.get(c["place_path"], []),
                "experimentTitle": c["experiment_title"],
                "snippet": snippet_for(c["passage"], query) if c["passage"] else "",
                "match": "words" if c["words"] > 0 else "meaning",
                "updatedAt": iso(c["updated_at"]),
                "author": c["author_type"],
            }
            for c in best
        ]

    def _params(self, where: _Where, **extra: Any) -> dict[str, Any]:
        return {"ws": self.workspace_id, "user": where.user_id, "near": where.near, "working_in": where.working_in,
                "scope": where.scope, **extra}  # fmt: skip

    async def _by_words(
        self, conn: AsyncConnection, query: str, where: _Where
    ) -> list[dict[str, Any]]:
        """
        Files whose whole text satisfies the query (so -word and words in
        different passages count across the file), whose text contains the
        query as written (for what full-text search doesn't split into words),
        or whose path does. `anyq` (one of the wanted words) finds candidate
        passages fast and picks the one to show.
        """
        pattern = "%" + re.sub(r"([\\%_])", r"\\\1", query) + "%"
        cur = await conn.execute(
            f"""
            WITH q AS (
              SELECT websearch_to_tsquery('english', %(query)s) AS tsq,
                     websearch_to_tsquery('english', %(any)s) AS anyq
            ),
            candidates AS (
              SELECT {_COLUMNS}, v.blob_sha256
              FROM files f
              JOIN file_versions v ON v.id = f.current_version_id
              {_PLACE_JOINS}
              CROSS JOIN q
              WHERE {_filters(where.scope is not None)}
                AND (f.path ILIKE %(pattern)s OR EXISTS (
                      SELECT 1 FROM blob_chunks c
                      WHERE c.sha256 = v.blob_sha256 AND (c.tsv @@ q.anyq OR c.body ILIKE %(pattern)s)))
            ),
            hits AS (
              SELECT h.*, passage.body,
                (CASE WHEN doc.tsv @@ q.tsq THEN ts_rank(doc.tsv, q.tsq) + 0.1
                      WHEN passage.literal THEN 0.1 ELSE 0 END
                 + CASE WHEN h.path ILIKE %(pattern)s THEN 1 ELSE 0 END) AS score
              FROM candidates h
              CROSS JOIN q
              CROSS JOIN LATERAL (
                SELECT tsvector_agg(c.tsv ORDER BY c.ord) AS tsv
                FROM blob_chunks c WHERE c.sha256 = h.blob_sha256
              ) doc
              LEFT JOIN LATERAL (
                SELECT c.body, c.body ILIKE %(pattern)s AS literal
                FROM blob_chunks c
                WHERE c.sha256 = h.blob_sha256 AND (c.tsv @@ q.anyq OR c.body ILIKE %(pattern)s)
                ORDER BY c.tsv @@ q.tsq DESC, c.body ILIKE %(pattern)s DESC,
                         ts_rank(c.tsv, q.anyq) DESC, c.ord
                LIMIT 1
              ) passage ON true
              WHERE doc.tsv @@ q.tsq OR h.path ILIKE %(pattern)s
                 OR EXISTS (SELECT 1 FROM blob_chunks c
                            WHERE c.sha256 = h.blob_sha256 AND c.body ILIKE %(pattern)s)
            )
            SELECT {", ".join(_FIELDS)}, body, score FROM hits
            ORDER BY score / (1 + 0.25 * distance) DESC, updated_at DESC, path
            LIMIT %(limit)s""",  # pyrefly: ignore[bad-argument-type]
            self._params(
                where, query=query, any=any_words(query), pattern=pattern, limit=CANDIDATES
            ),
        )
        return [
            dict(zip((*_FIELDS, "body", "score"), row, strict=True)) for row in await cur.fetchall()
        ]

    async def _by_meaning(
        self, conn: AsyncConnection, query: str, where: _Where
    ) -> list[dict[str, Any]]:
        """Files with a passage close in meaning to the query, each with its closest passage (semantic.py)."""
        semantic = self.semantic
        if not semantic or not semantic.ready:
            return []
        try:
            vector = await semantic.query_vector(query)
        except Exception:
            logger.exception("[search] could not embed the query; matching words only")
            return []
        async with conn.transaction():
            # Keep scanning the index past passages the filters drop (pgvector 0.8+).
            await conn.execute(
                "SELECT set_config('hnsw.ef_search', '200', true), set_config('hnsw.iterative_scan', 'relaxed_order', true)"
            )
            cur = await conn.execute(
                f"""
                WITH nearest AS MATERIALIZED (
                  SELECT c.sha256, c.body, 1 - (c.embedding <=> %(vector)s::vector) AS similarity
                  FROM blob_chunks c
                  WHERE c.embedding IS NOT NULL
                  ORDER BY c.embedding <=> %(vector)s::vector
                  LIMIT %(nearest)s
                )
                SELECT DISTINCT ON (f.id) {_COLUMNS}, k.body, k.similarity
                FROM nearest k
                JOIN file_versions v ON v.blob_sha256 = k.sha256
                JOIN files f ON f.current_version_id = v.id
                {_PLACE_JOINS}
                WHERE {_filters(where.scope is not None)} AND k.similarity >= %(floor)s
                ORDER BY f.id, k.similarity DESC""",  # pyrefly: ignore[bad-argument-type]
                self._params(where, vector=vector, nearest=NEAREST, floor=semantic.min_similarity),
            )
            rows = await cur.fetchall()
        return [dict(zip((*_FIELDS, "body", "similarity"), row, strict=True)) for row in rows]

    async def _lineages(self, conn: AsyncConnection, paths: list[str]) -> dict[str, list[str]]:
        """Node names from the top down to each place path ("" = the root)."""
        wanted = list(dict.fromkeys(p for p in paths if p))
        if not wanted:
            return {}
        cur = await conn.execute(
            """
            SELECT p.path,
              (SELECT array_agg(a.name ORDER BY nlevel(a.path)) FROM nodes a
               WHERE a.workspace_id = %s AND a.path @> p.path::ltree) AS names
            FROM unnest(%s::text[]) AS p(path)""",
            (self.workspace_id, wanted),
        )
        return {path: names or [] for path, names in await cur.fetchall()}

    async def index_pending(
        self, pool: AsyncConnectionPool, batch: int = 20, skip: set[str] | None = None
    ) -> tuple[int, list[str]]:
        """
        Indexes current file versions written before search existed (or whose
        indexing was missed), a batch at a time, leaving out `skip`. Returns
        how many it indexed and the blobs it couldn't read this time (a store
        error other than "not there"), which stay pending for a later try.
        Runs with the server's own connection, outside any user's rights.
        """
        blobs = self.blobs
        if blobs is None:
            raise RuntimeError("Blob store is not configured")
        async with pool.connection() as conn:
            cur = await conn.execute(
                """
                SELECT DISTINCT v.blob_sha256 AS sha256
                FROM files f
                JOIN file_versions v ON v.id = f.current_version_id
                LEFT JOIN blob_texts t ON t.sha256 = v.blob_sha256
                WHERE f.deleted_at IS NULL AND t.sha256 IS NULL
                  AND NOT (v.blob_sha256 = ANY(%s::text[]))
                LIMIT %s""",
                (sorted(skip or ()), batch),
            )
            rows = [sha for (sha,) in await cur.fetchall()]
        failed: list[str] = []
        for sha256 in rows:
            try:
                data = await blobs.get(sha256)
            except Exception as err:  # Retry store failures later.
                if not is_not_found(err):
                    logger.warning(
                        "[search] could not read blob %s to index it, will retry: %s", sha256, err
                    )
                    failed.append(sha256)
                    continue
                # Gone from the store: recorded as no text, so it isn't retried forever.
                logger.warning(
                    "[search] blob %s is missing from the store; indexed as empty", sha256
                )
                data = b""
            async with pool.connection() as conn, conn.transaction():
                await index_blob(conn, sha256, data)
        return len(rows) - len(failed), failed

    async def index_all(self, pool: AsyncConnectionPool) -> tuple[int, int]:
        """index_pending() until nothing is left but blobs that failed in this pass: (indexed, failed)."""
        skip: set[str] = set()
        indexed = 0
        while True:
            done, failed = await self.index_pending(pool, 20, skip)
            indexed += done
            skip.update(failed)
            if done == 0 and not failed:
                return indexed, len(skip)
