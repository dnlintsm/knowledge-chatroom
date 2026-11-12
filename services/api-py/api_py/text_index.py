"""The full-text index a write adds, as indexBlob() in apps/agent/src/storage/search.ts builds it.

Each distinct content's text is cut into chunks of about a paragraph, once,
inside the transaction that adds the version holding it. Search reads them,
and the background indexer embeds them for search by meaning (semantic.py).
Lengths count UTF-16 code units, as JavaScript does, so both servers
cut a text into the same chunks.
"""

from __future__ import annotations

import codecs
import re

from psycopg import AsyncConnection

from .paths import JS_SPACE, js_trim

MAX_INDEX_BYTES = 2 * 1024 * 1024
CHUNK_TARGET = 1000
CHUNK_MAX = 1500
_PARAGRAPH = re.compile(f"\n[{JS_SPACE}]*\n")


def extract_text(data: bytes) -> str | None:
    """Valid UTF-8 without NUL characters (a character cut at the size limit is dropped); None otherwise."""
    try:
        # TextDecoder("utf-8", {fatal: true}).decode(..., {stream: true}): strict, BOM dropped.
        text = codecs.getincrementaldecoder("utf-8-sig")("strict").decode(
            data[:MAX_INDEX_BYTES], final=False
        )
    except UnicodeDecodeError:
        return None
    return None if "\x00" in text else text


def to_units(text: str) -> str:
    """The text as UTF-16 code units, one Python character each (pairs for characters outside the BMP)."""
    if all(ord(c) <= 0xFFFF for c in text):
        return text
    return "".join(_units(text))


def _units(text: str):
    for c in text:
        code = ord(c)
        if code <= 0xFFFF:
            yield c
        else:
            code -= 0x10000
            yield chr(0xD800 + (code >> 10))
            yield chr(0xDC00 + (code & 0x3FF))


def from_units(units: str) -> str:
    """Back to text; a pair cut in two becomes U+FFFD, as TextEncoder writes it."""
    return units.encode("utf-16-le", "surrogatepass").decode("utf-16-le", "replace")


def chunk_text(text: str) -> list[str]:
    """Pieces of about a paragraph or a few, none over CHUNK_MAX characters."""
    chunks: list[str] = []
    current = ""

    def flush() -> None:
        nonlocal current
        piece = js_trim(current)
        if piece:
            chunks.append(from_units(piece))
        current = ""

    for paragraph in _PARAGRAPH.split(to_units(text)):
        if current and len(current) + len(paragraph) + 2 > CHUNK_TARGET:
            flush()
        rest = paragraph
        while len(rest) > CHUNK_MAX:
            flush()
            cut = rest.rfind(" ", 0, CHUNK_MAX + 1)
            if cut < CHUNK_MAX / 2:
                cut = CHUNK_MAX
            current = rest[:cut]
            flush()
            rest = rest[cut:]
        current = f"{current}\n\n{rest}" if current else rest
    flush()
    return chunks


async def index_blob(conn: AsyncConnection, sha256: str, data: bytes) -> None:
    """Indexes a blob's text once per distinct content; `conn` is in the write's transaction."""
    text = extract_text(data)
    chunks = chunk_text(text) if text else []
    cur = await conn.execute(
        "INSERT INTO blob_texts (sha256, chars) VALUES (%s, %s) ON CONFLICT (sha256) DO NOTHING RETURNING sha256",
        (sha256, len(to_units(text)) if text else 0),
    )
    if not await cur.fetchone() or not chunks:
        return
    async with conn.cursor() as cur:
        await cur.executemany(
            "INSERT INTO blob_chunks (sha256, ord, body) VALUES (%s, %s, %s)",
            [(sha256, ord_, body) for ord_, body in enumerate(chunks)],
        )
