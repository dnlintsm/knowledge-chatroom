"""Search by meaning, as apps/agent/src/storage/semantic.ts.

Every passage of indexed text (blob_chunks, 006_search.sql) gets an embedding
from a small model that runs inside this server with ONNX Runtime (the same
quantized ONNX file transformers.js runs in the TypeScript server), or from an
OpenAI-compatible embeddings API (EMBEDDING_BASE_URL). The vectors are stored
with pgvector; a search embeds the query and finds the nearest passages. It
is optional: without pgvector, or with EMBEDDING_MODEL=off, search stays
word-based.

Embedding happens in the background (SemanticIndex.start), so a new file is
found by its words at once and by meaning a few seconds later. This server
runs that loop; the TypeScript server behind it, started with
SEARCH_INDEXER=off, only embeds queries (issue #190, step 5).
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import math
import re
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol

import httpx
from psycopg_pool import AsyncConnectionPool

logger = logging.getLogger("api_py")

DEFAULT_EMBEDDING_MODEL = "Xenova/multilingual-e5-small"
DEFAULT_CACHE_DIR = Path.home() / ".cache" / "knowledge-chatroom" / "models"
# pgvector's HNSW index takes vectors of at most this many dimensions.
MAX_INDEXED_DIMS = 2000
BATCH = 16
IDLE_SECONDS = 5.0
RETRY_SECONDS = 60.0
API_TIMEOUT_SECONDS = 60.0
# What transformers.js loads for dtype "q8".
ONNX_FILE = "onnx/model_quantized.onnx"
_E5 = re.compile(r"(^|/)(multilingual-)?e5-", re.IGNORECASE)


class Embedder(Protocol):
    model: str
    # What the stored vectors came from, when the model name alone doesn't say;
    # a change starts the vectors over. Written as the TypeScript server writes it.
    source: str

    async def embed(self, texts: list[str], kind: str) -> list[list[float]]:
        """One unit-length vector per text; kind is "query" or "passage"."""
        ...


def e5_prefix(model: str, kind: str) -> str:
    """E5 models were trained with "query: " and "passage: " prefixes."""
    return f"{kind}: " if _E5.search(model) else ""


def unit_length(vector: list[float]) -> list[float]:
    """Not every provider normalizes; cosine search and the similarity bar assume it."""
    norm = math.sqrt(sum(x * x for x in vector))
    return [x / norm for x in vector] if norm > 0 else vector


def to_vector(vector: list[float]) -> str:
    """pgvector's text form of a vector."""
    return "[" + ",".join(repr(float(x)) for x in vector) + "]"


class LocalEmbedder:
    """
    A model from the Hugging Face hub run with ONNX Runtime in this process,
    downloaded to `cache_dir` on first use: its tokenizer and the quantized
    ONNX file transformers.js uses, mean-pooled and normalized as its
    feature-extraction pipeline does, so both servers' vectors agree.
    """

    def __init__(self, model: str, cache_dir: Path | str | None = None) -> None:
        self.model = model
        self.source = model
        self.cache_dir = Path(cache_dir) if cache_dir else DEFAULT_CACHE_DIR
        self._loaded: tuple[Any, Any] | None = None
        self._lock = asyncio.Lock()

    def _load(self) -> tuple[Any, Any]:
        # Imported only when used, so the server starts fast and tests don't need them.
        import onnxruntime
        from huggingface_hub import hf_hub_download
        from tokenizers import Tokenizer

        def fetch(name: str) -> str:
            return hf_hub_download(self.model, name, cache_dir=str(self.cache_dir))

        tokenizer = Tokenizer.from_file(fetch("tokenizer.json"))
        config: dict[str, Any] = {}
        with contextlib.suppress(Exception):
            config = json.loads(Path(fetch("tokenizer_config.json")).read_text())
        longest = config.get("model_max_length")
        tokenizer.enable_truncation(
            longest if isinstance(longest, int) and 0 < longest <= 8192 else 512
        )
        pad = config.get("pad_token")
        pad = pad.get("content") if isinstance(pad, dict) else pad
        pad_id = tokenizer.token_to_id(pad) if isinstance(pad, str) else None
        tokenizer.enable_padding(
            pad_id=pad_id or 0, pad_token=pad if pad_id is not None else "[PAD]"
        )
        options = onnxruntime.SessionOptions()
        options.log_severity_level = 3
        session = onnxruntime.InferenceSession(
            fetch(ONNX_FILE), options, providers=["CPUExecutionProvider"]
        )
        return tokenizer, session

    def _run(self, texts: list[str]) -> list[list[float]]:
        import numpy as np

        tokenizer, session = self._loaded  # type: ignore[misc]
        encodings = tokenizer.encode_batch(texts)
        ids = np.array([e.ids for e in encodings], dtype=np.int64)
        mask = np.array([e.attention_mask for e in encodings], dtype=np.int64)
        given = {"input_ids": ids, "attention_mask": mask, "token_type_ids": np.zeros_like(ids)}
        feeds = {i.name: given[i.name] for i in session.get_inputs() if i.name in given}
        names = [o.name for o in session.get_outputs()]
        output = session.run([names[names.index("last_hidden_state")] if "last_hidden_state" in names else names[0]],
                             feeds)[0]  # fmt: skip
        weights = mask[:, :, None].astype(output.dtype)
        pooled = (output * weights).sum(axis=1) / np.maximum(weights.sum(axis=1), 1e-9)
        norms = np.maximum(np.linalg.norm(pooled, axis=1, keepdims=True), 1e-12)
        return (pooled / norms).astype(float).tolist()

    async def embed(self, texts: list[str], kind: str) -> list[list[float]]:
        if self._loaded is None:
            async with self._lock:
                if self._loaded is None:
                    self._loaded = await asyncio.to_thread(self._load)
        prefix = e5_prefix(self.model, kind)
        return await asyncio.to_thread(self._run, [prefix + t for t in texts])


class ApiEmbedder:
    """
    A model behind an OpenAI-compatible `POST /embeddings` endpoint: a
    self-hosted one through LiteLLM, vLLM or Ollama, or an online API such as
    OpenRouter or OpenAI. Passages leave the server, unlike LocalEmbedder.
    """

    def __init__(
        self,
        model: str,
        base_url: str,
        api_key: str | None = None,
        dimensions: int | None = None,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self.model = model
        self.url = re.sub(r"/+$", "", base_url) + "/embeddings"
        self.source = f"{model} at {self.url}"
        self.api_key = api_key
        self.dimensions = dimensions
        self._transport = transport

    async def embed(self, texts: list[str], kind: str) -> list[list[float]]:
        prefix = e5_prefix(self.model, kind)
        body: dict[str, Any] = {
            "model": self.model,
            "input": [prefix + t for t in texts],
            "encoding_format": "float",
        }
        if self.dimensions:
            body["dimensions"] = self.dimensions
        headers = {"content-type": "application/json"}
        if self.api_key:
            headers["authorization"] = f"Bearer {self.api_key}"
        async with httpx.AsyncClient(
            timeout=API_TIMEOUT_SECONDS, transport=self._transport
        ) as client:
            answer = await client.post(self.url, json=body, headers=headers)
        if answer.status_code >= 300:
            raise RuntimeError(
                f"embeddings endpoint {self.url} answered {answer.status_code}: {answer.text[:500]}"
            )
        data = answer.json().get("data") or []
        if len(data) != len(texts):
            raise RuntimeError(
                f"embeddings endpoint returned {len(data)} vectors for {len(texts)} texts"
            )
        vectors = []
        for item in sorted(data, key=lambda d: d.get("index") or 0):
            embedding = item.get("embedding")
            if (
                not isinstance(embedding, list)
                or not embedding
                or not isinstance(embedding[0], int | float)
            ):
                raise RuntimeError(
                    "embeddings endpoint returned a vector that isn't a list of numbers"
                )
            vectors.append(unit_length([float(x) for x in embedding]))
        return vectors


@dataclass(frozen=True)
class EmbeddingSettings:
    """EMBEDDING_* as the TypeScript server reads them (storage/config.ts)."""

    model: str
    cache_dir: str | None = None
    base_url: str | None = None
    api_key: str | None = None
    dimensions: int | None = None
    # SEARCH_MIN_SIMILARITY, when set.
    min_similarity: float | None = None

    def embedder(self) -> Embedder:
        if self.base_url:
            return ApiEmbedder(self.model, self.base_url, self.api_key, self.dimensions)
        return LocalEmbedder(self.model, self.cache_dir)


def js_parse_float(text: str) -> float | None:
    """Number.parseFloat, None for NaN."""
    match = re.match(r"\s*([+-]?(?:Infinity|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?))", text)
    if not match:
        return None
    value = match.group(1)
    return float(value.replace("Infinity", "inf"))


def default_min_similarity(model: str, configured: float | None = None) -> float:
    """
    How similar a passage must be to count as a result. E5 models give
    unrelated text a fairly high cosine similarity, so their bar is higher.
    SEARCH_MIN_SIMILARITY overrides it.
    """
    if configured is not None:
        return configured
    return 0.82 if re.search(r"e5-", model, re.IGNORECASE) else 0.5


class SemanticIndex:
    """Keeps blob_chunks.embedding filled for `embedder`, and embeds queries; `ready` once the database can hold its vectors."""

    def __init__(
        self, pool: AsyncConnectionPool, embedder: Embedder, min_similarity: float | None = None
    ) -> None:
        self.pool = pool
        self.embedder = embedder
        self.min_similarity = default_min_similarity(embedder.model, min_similarity)
        self.ready = False
        self._task: asyncio.Task[None] | None = None

    async def prepare(self) -> bool:
        """
        Makes sure pgvector is on and blob_chunks has a column for this model's
        vectors (a different model or size starts the column over). Returns
        whether search by meaning can be used; False without pgvector.
        """
        # pgvector first, so a database without it never loads the model.
        if not await self._enable_vectors():
            self.ready = False
            return False
        [probe] = await self.embedder.embed(["probe"], "passage")
        dims = len(probe)
        model = self.embedder.source
        async with self.pool.connection() as conn, conn.transaction():
            # Same lock as the migrations: schema changes one process at a time.
            await conn.execute(
                "SELECT pg_advisory_xact_lock(hashtext('knowledge-chatroom:migrate'))"
            )
            await conn.execute(
                """
                CREATE TABLE IF NOT EXISTS search_embedding (
                  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
                  model text NOT NULL,
                  dims  integer NOT NULL
                )"""
            )
            cur = await conn.execute("SELECT model, dims FROM search_embedding")
            current = await cur.fetchone()
            if not (current and current[0] == model and current[1] == dims):
                # Vectors from another model don't compare with this one's: start over.
                await conn.execute("ALTER TABLE blob_chunks DROP COLUMN IF EXISTS embedding")
                await conn.execute(  # type: ignore[arg-type]
                    f"ALTER TABLE blob_chunks ADD COLUMN embedding vector({int(dims)})"
                )
                if dims <= MAX_INDEXED_DIMS:
                    await conn.execute(
                        "CREATE INDEX blob_chunks_embedding ON blob_chunks USING hnsw (embedding vector_cosine_ops)"
                    )
                else:
                    logger.warning(
                        "[search] %s gives %d dimensions, more than pgvector can index (%d), so search by meaning "
                        "compares every passage; set EMBEDDING_DIMENSIONS to shorten its vectors",
                        model, dims, MAX_INDEXED_DIMS,
                    )  # fmt: skip
                await conn.execute(
                    "CREATE INDEX blob_chunks_unembedded ON blob_chunks (sha256, ord) WHERE embedding IS NULL"
                )
                await conn.execute(
                    """
                    INSERT INTO search_embedding (model, dims) VALUES (%s, %s)
                    ON CONFLICT (singleton) DO UPDATE SET model = EXCLUDED.model, dims = EXCLUDED.dims""",
                    (model, dims),
                )
                logger.info("[search] search by meaning uses %s (%d dimensions)", model, dims)
        self.ready = True
        return True

    async def _enable_vectors(self) -> bool:
        """Turns pgvector on if Postgres has it; False (and a log line) if not."""
        async with self.pool.connection() as conn:
            cur = await conn.execute("SELECT 1 FROM pg_available_extensions WHERE name = 'vector'")
            if not await cur.fetchone():
                logger.warning(
                    "[search] Postgres has no pgvector, so search matches words only "
                    "(use the pgvector/pgvector image, or install pgvector, for search by meaning)"
                )
                return False
            try:
                await conn.execute("CREATE EXTENSION IF NOT EXISTS vector")
            except Exception as err:  # Word search still works.
                logger.warning(
                    "[search] could not turn on pgvector (an admin can run CREATE EXTENSION vector); "
                    "search matches words only: %s",
                    err,
                )
                return False
        return True

    async def embed_pending(self, batch: int = BATCH) -> int:
        """Embeds up to `batch` passages that have no vector yet; returns how many."""
        async with self.pool.connection() as conn:
            cur = await conn.execute(
                "SELECT sha256, ord, body FROM blob_chunks WHERE embedding IS NULL ORDER BY sha256, ord LIMIT %s",
                (batch,),
            )
            rows = await cur.fetchall()
        if not rows:
            return 0
        vectors = await self.embedder.embed([body for _, _, body in rows], "passage")
        async with self.pool.connection() as conn:
            await conn.execute(
                """
                UPDATE blob_chunks c SET embedding = u.embedding::vector
                FROM unnest(%s::text[], %s::int[], %s::text[]) AS u(sha256, ord, embedding)
                WHERE c.sha256 = u.sha256 AND c.ord = u.ord AND c.embedding IS NULL""",
                ([r[0] for r in rows], [r[1] for r in rows], [to_vector(v) for v in vectors]),
            )
        return len(rows)

    async def embed_all(self) -> int:
        """embed_pending() until every passage has a vector."""
        total = 0
        while n := await self.embed_pending():
            total += n
        return total

    async def query_vector(self, query: str) -> str:
        """The query as a pgvector value."""
        [vector] = await self.embedder.embed([query], "query")
        return to_vector(vector)

    def start(self) -> None:
        """
        Runs in the background: loads the model (downloading it the first
        time), prepares the database, then embeds new passages as they appear.
        Failures are logged and retried; search by words never waits.
        """
        if self._task is None:
            self._task = asyncio.create_task(self._run())

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task
            self._task = None

    async def _run(self) -> None:
        while not self.ready:
            try:
                if not await self.prepare():
                    return  # no pgvector: nothing to retry
            except Exception:
                logger.exception(
                    "[search] could not load %s; trying again in a minute", self.embedder.model
                )
                await asyncio.sleep(RETRY_SECONDS)
        while True:
            try:
                if await self.embed_pending() == 0:
                    await asyncio.sleep(IDLE_SECONDS)
            except Exception:
                logger.exception("[search] embedding passages failed; trying again in a minute")
                await asyncio.sleep(RETRY_SECONDS)


def embedding_settings(env: Mapping[str, str]) -> EmbeddingSettings | None:
    """EMBEDDING_MODEL (off, or a model; default the TypeScript server's), EMBEDDING_BASE_URL and the rest."""
    from .config import ConfigError

    model = env.get("EMBEDDING_MODEL") or ""
    if model == "off":
        return None
    base_url = env.get("EMBEDDING_BASE_URL") or None
    if base_url and not model:
        raise ConfigError(
            "EMBEDDING_BASE_URL needs EMBEDDING_MODEL, the model name the endpoint knows "
            "(e.g. openai/text-embedding-3-small on OpenRouter)"
        )
    dimensions = None
    if base_url:
        raw = (env.get("EMBEDDING_DIMENSIONS") or "").strip()
        if raw and not re.fullmatch(r"[1-9]\d*", raw):
            raise ConfigError("EMBEDDING_DIMENSIONS must be a positive whole number")
        dimensions = int(raw) if raw else None
    return EmbeddingSettings(
        model=model or DEFAULT_EMBEDDING_MODEL,
        cache_dir=env.get("EMBEDDING_CACHE_DIR") or None,
        base_url=base_url,
        api_key=(env.get("EMBEDDING_API_KEY") or None) if base_url else None,
        dimensions=dimensions,
        min_similarity=js_parse_float(env.get("SEARCH_MIN_SIMILARITY") or ""),
    )
