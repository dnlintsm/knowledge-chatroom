"""/search and the search indexer served by api-py (search.py, semantic.py).

The route tests need TEST_DATABASE_URL and S3_ENDPOINT, as test_files.py;
search by meaning also needs pgvector in that Postgres (CI's has it), and
runs with a small stand-in model. EMBEDDING_TEST=1 also checks the real
model (downloaded on first use, about 120 MB), as embeddings.test.ts does
for the TypeScript server.
"""

from __future__ import annotations

import asyncio
import json
import os
import re

import httpx
import psycopg
import pytest
from support import ALICE, BOB, Client, storage_token
from test_files import S3_ENDPOINT, SECRET, URL, s3

from api_py.config import ConfigError
from api_py.search import any_words, snippet_for
from api_py.semantic import (
    DEFAULT_EMBEDDING_MODEL,
    ApiEmbedder,
    LocalEmbedder,
    SemanticIndex,
    default_min_similarity,
    embedding_settings,
)

pytestmark = [pytest.mark.anyio]
needs_services = pytest.mark.skipif(
    not URL or not S3_ENDPOINT, reason="TEST_DATABASE_URL and S3_ENDPOINT are not set"
)


def test_query_words_and_snippets():
    assert any_words('etch -wet "chamber wall" OR rate') == "etch or chamber or wall or rate"
    assert any_words("") == ""
    body = "intro " * 60 + "The plasma etch rate fell.\n\n" + "outro " * 60
    snippet = snippet_for(body, "etch rate")
    assert snippet.startswith("…") and snippet.endswith("…") and "plasma etch rate fell" in snippet
    assert len(snippet) <= 222  # 220 characters, trimmed, and an ellipsis each side
    assert snippet_for("  short\n text ", "x") == "short text"
    # Lengths count as JavaScript counts them: an emoji is two.
    assert snippet_for("😀" * 120, "x") == "😀" * 110 + "…"


def test_embedding_settings():
    assert embedding_settings({"EMBEDDING_MODEL": "off"}) is None
    local = embedding_settings({})
    assert (local.model, local.base_url, local.min_similarity) == (
        DEFAULT_EMBEDDING_MODEL,
        None,
        None,
    )
    api = embedding_settings(
        {"EMBEDDING_BASE_URL": "https://x.test/v1/", "EMBEDDING_MODEL": "m", "EMBEDDING_DIMENSIONS": "256",
         "EMBEDDING_API_KEY": "k", "SEARCH_MIN_SIMILARITY": " 0.3x"}
    )  # fmt: skip
    assert (api.dimensions, api.api_key, api.min_similarity) == (256, "k", 0.3)
    assert api.embedder().source == "m at https://x.test/v1/embeddings"
    assert (
        isinstance(local.embedder(), LocalEmbedder)
        and local.embedder().source == DEFAULT_EMBEDDING_MODEL
    )
    with pytest.raises(ConfigError, match="EMBEDDING_BASE_URL needs EMBEDDING_MODEL"):
        embedding_settings({"EMBEDDING_BASE_URL": "https://x.test/v1"})
    with pytest.raises(ConfigError, match="EMBEDDING_DIMENSIONS must be a positive whole number"):
        embedding_settings(
            {
                "EMBEDDING_BASE_URL": "https://x.test/v1",
                "EMBEDDING_MODEL": "m",
                "EMBEDDING_DIMENSIONS": "0",
            }
        )
    assert default_min_similarity("Xenova/multilingual-e5-small") == 0.82
    assert default_min_similarity("text-embedding-3-small") == 0.5
    assert default_min_similarity("e5-x", 0.1) == 0.1


async def test_api_embedder():
    sent = []

    def answer(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        sent.append((request.headers.get("authorization"), body))
        if body["input"] == ["query: boom"]:
            return httpx.Response(500, text="nope")
        data = [{"index": i, "embedding": [3.0, 4.0]} for i in reversed(range(len(body["input"])))]
        return httpx.Response(200, json={"data": data})

    embedder = ApiEmbedder(
        "intfloat/multilingual-e5-large", "https://x.test/v1", "key", 2, httpx.MockTransport(answer)
    )
    assert await embedder.embed(["a", "b"], "passage") == [[0.6, 0.8], [0.6, 0.8]]
    assert sent[0] == ("Bearer key", {"model": "intfloat/multilingual-e5-large", "input": ["passage: a", "passage: b"],
                                      "encoding_format": "float", "dimensions": 2})  # fmt: skip
    with pytest.raises(RuntimeError, match="answered 500: nope"):
        await embedder.embed(["boom"], "query")


@pytest.fixture
async def api(database):
    async with Client(database, SECRET, s3=s3()) as (client, app):
        await client.get("/access", headers=ALICE)
        await client.get("/access", headers=BOB)
        yield client, app


@needs_services
async def test_search_by_words(api):
    client, _app = api
    etch = (
        await client.post("/nodes", headers=ALICE, json={"parentId": None, "name": "Etch"})
    ).json()["id"]
    module = (
        await client.post("/nodes", headers=ALICE, json={"parentId": etch, "name": "Module 3"})
    ).json()["id"]
    text = (
        "Chamber notes.\n\n"
        + "Filler paragraph about other things. " * 40
        + "\n\nThe plasma etch rate fell by 8 percent."
    )
    await client.put(f"/files/notes/rate.md?node={module}", headers=ALICE, content=text.encode())
    await client.put("/files/plasma-plan.md", headers=ALICE, content=b"Plan for next quarter.")
    await client.put("/files/data/X-1234.csv", headers=ALICE, content=b"part,X-1234\n")
    await client.put("/files/old-notes.md", headers=ALICE, content=b"The etch rate fell.")

    found = await client.get("/search?q=plasma etch", headers=ALICE)
    assert found.status_code == 200, found.text
    results = found.json()["results"]
    assert [r["path"] for r in results] == ["notes/rate.md"]
    hit = results[0]
    assert (hit["node"], hit["where"], hit["match"], hit["author"], hit["kind"]) == (
        module, ["Etch", "Module 3"], "words", "user", "note",
    )  # fmt: skip
    assert "plasma etch rate fell" in hit["snippet"] and hit["updatedAt"].endswith("Z")

    # A path match counts; so does text full-text search doesn't split into words.
    assert [r["path"] for r in (await client.get("/search?q=plasma", headers=ALICE)).json()["results"]] == [
        "plasma-plan.md", "notes/rate.md",
    ]  # fmt: skip
    assert [
        r["path"] for r in (await client.get("/search?q=X-1234", headers=ALICE)).json()["results"]
    ] == ["data/X-1234.csv"]
    excluded = (await client.get("/search?q=plasma -quarter", headers=ALICE)).json()["results"]
    assert [r["path"] for r in excluded] == [
        "notes/rate.md"
    ]  # the path doesn't hold "plasma -quarter"
    scoped = (await client.get(f"/search?q=plasma&scope={etch}&limit=1", headers=ALICE)).json()[
        "results"
    ]
    assert [r["path"] for r in scoped] == ["notes/rate.md"]
    # Files nearer where the user is rank higher.
    anywhere = (await client.get("/search?q=rate fell", headers=ALICE)).json()["results"]
    assert [r["path"] for r in anywhere] == ["old-notes.md", "notes/rate.md"]
    near = (await client.get(f"/search?q=rate fell&near={module}", headers=ALICE)).json()["results"]
    assert [r["path"] for r in near] == ["notes/rate.md", "old-notes.md"]

    # Bob can't read the root or the node: he finds nothing, and can't search in it.
    assert (await client.get("/search?q=plasma", headers=BOB)).json() == {"results": []}
    hidden = await client.get(f"/search?q=plasma&scope={etch}", headers=BOB)
    assert (hidden.status_code, hidden.json()) == (
        400,
        {"error": "No such knowledge node to search in"},
    )
    # Once he may read the node, he finds its files and not the root's.
    bob = (await client.get("/access/users", headers=ALICE)).json()["users"][1]["id"]
    grant = {"node": module, "principalType": "user", "principalId": bob, "role": "viewer"}
    await client.post("/access/grants", headers=ALICE, json=grant)
    assert [
        r["path"] for r in (await client.get("/search?q=plasma", headers=BOB)).json()["results"]
    ] == ["notes/rate.md"]
    # Claude through a storage token searches as its user.
    assert (
        len(
            (await client.get("/search?q=plasma", headers=storage_token("kc|alice"))).json()[
                "results"
            ]
        )
        == 2
    )


@needs_services
async def test_search_refusals(api):
    client, _app = api
    for query, message in (("", "Search for at least one word"), ("   ", "Search for at least one word"),
                           ("x" * 501, "Search text is too long (500 characters at most)")):  # fmt: skip
        refused = await client.get("/search", headers=ALICE, params={"q": query})
        assert (refused.status_code, refused.json()) == (400, {"error": message})
    assert (await client.get("/search/more?q=x", headers=ALICE)).json() == {"error": "Not found"}
    assert (await client.post("/search?q=x", headers=ALICE)).status_code == 405
    assert (await client.get("/search?q=x")).status_code == 401
    assert (await client.get("/search/?q=x&limit=abc", headers=ALICE)).json() == {"results": []}


@needs_services
async def test_the_indexer_indexes_files_written_before_search(database):
    async with Client(database, SECRET, s3=s3()) as (client, _app):
        await client.get("/access", headers=ALICE)
        await client.put("/files/old.md", headers=ALICE, content=b"An old note about plasma.")
    async with await psycopg.AsyncConnection.connect(database, autocommit=True) as conn:
        await conn.execute("DELETE FROM blob_texts")
    async with Client(database, SECRET, s3=s3()) as (client, _app):
        for _ in range(50):
            results = (await client.get("/search?q=plasma", headers=ALICE)).json()["results"]
            if results:
                break
            await asyncio.sleep(0.1)
        assert [r["path"] for r in results] == ["old.md"]


# Search by meaning, with a stand-in model: each topic is one dimension.
TOPICS = [r"etch|plasma|chamber|deposition|wafer", r"budget|finance|money", r"lunch|plants|lobby"]


class TopicEmbedder:
    def __init__(self, model: str = "topics", extra: int = 0) -> None:
        self.model = self.source = model
        self.extra = extra
        self.calls = 0

    async def embed(self, texts: list[str], kind: str) -> list[list[float]]:
        self.calls += 1
        out = []
        for text in texts:
            vector = (
                [float(len(re.findall(t, text.lower()))) for t in TOPICS]
                + [0.0] * self.extra
                + [0.1]
            )
            norm = sum(x * x for x in vector) ** 0.5
            out.append([x / norm for x in vector])
        return out


async def has_pgvector(database: str) -> bool:
    async with await psycopg.AsyncConnection.connect(database) as conn:
        cur = await conn.execute("SELECT 1 FROM pg_available_extensions WHERE name = 'vector'")
        return await cur.fetchone() is not None


@needs_services
async def test_search_by_meaning(api, database):
    if not await has_pgvector(database):
        pytest.skip("this Postgres has no pgvector")
    client, app = api
    await client.put(
        "/files/notes/liner.md",
        headers=ALICE,
        content=b"Polymer deposition on the liner grows weekly.",
    )
    await client.put(
        "/files/notes/budget.md", headers=ALICE, content=b"The quarterly budget moved."
    )
    await client.put("/files/notes/fab.md", headers=ALICE, content=b"Money for the new fab.")
    storage = app.state.storage
    semantic = SemanticIndex(storage.pool, TopicEmbedder())
    storage.semantic = semantic
    assert await semantic.prepare() and semantic.ready
    assert await semantic.embed_all() == 3
    assert await semantic.embed_all() == 0

    found = (await client.get("/search?q=chamber wall", headers=ALICE)).json()["results"]
    assert [(r["path"], r["match"]) for r in found] == [("notes/liner.md", "meaning")]
    assert found[0]["snippet"] == "Polymer deposition on the liner grows weekly."
    # Exact-word queries don't search by meaning.
    assert (await client.get('/search?q="chamber wall"', headers=ALICE)).json() == {"results": []}
    # Words and meaning together: the word match comes first.
    both = (await client.get("/search?q=budget", headers=ALICE)).json()["results"]
    assert [(r["path"], r["match"]) for r in both] == [
        ("notes/budget.md", "words"),
        ("notes/fab.md", "meaning"),
    ]

    # Another model (or size) starts the vectors over; the same one keeps them.
    async with storage.pool.connection() as conn:
        cur = await conn.execute("SELECT model, dims FROM search_embedding")
        assert await cur.fetchone() == ("topics", 4)
    again = SemanticIndex(storage.pool, TopicEmbedder())
    await again.prepare()
    assert await again.embed_pending() == 0
    other = SemanticIndex(storage.pool, TopicEmbedder("topics-2", extra=2))
    await other.prepare()
    assert await other.embed_all() == 3
    async with storage.pool.connection() as conn:
        cur = await conn.execute("SELECT model, dims FROM search_embedding")
        assert await cur.fetchone() == ("topics-2", 6)


@pytest.mark.skipif(not os.environ.get("EMBEDDING_TEST"), reason="EMBEDDING_TEST not set")
async def test_the_real_model():
    """The local model loads, and related passages clear the search bar while unrelated ones don't."""
    embedder = LocalEmbedder(DEFAULT_EMBEDDING_MODEL, os.environ.get("EMBEDDING_CACHE_DIR"))
    floor = default_min_similarity(DEFAULT_EMBEDDING_MODEL)
    cases = [
        ("chamber wall buildup", "Polymer deposition on the chamber liner grows every week and flakes onto wafers.",
         "The quarterly budget review moved to Thursday afternoon."),
        ("why did the etch rate drop", "After the RF generator was replaced, oxide etch rate fell by 8 percent.",
         "Remember to water the plants in the lobby."),
        ("腔体内壁沉积", "刻蚀腔室衬里上的聚合物沉积每周都在增加。", "下周三的团队午餐改到楼下餐厅。"),
    ]  # fmt: skip

    def dot(a: list[float], b: list[float]) -> float:
        return sum(x * y for x, y in zip(a, b, strict=True))

    for query, related, unrelated in cases:
        [q] = await embedder.embed([query], "query")
        r, u = await embedder.embed([related, unrelated], "passage")
        assert len(q) == 384 and abs(dot(q, q) - 1) < 1e-3
        close, far = dot(q, r), dot(q, u)
        print(f"[embeddings] {query!r}: related {close:.3f}, unrelated {far:.3f} (bar {floor})")
        assert close > far and close >= floor and far < floor
