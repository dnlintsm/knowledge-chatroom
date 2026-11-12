"""Reading a POST /experiments/upload body, as readParts() in apps/agent/src/storage/http.ts reads it with busboy.

The body is multipart/form-data: a "meta" part with the experiment's fields as
JSON, and one part per file, named by its path in the experiment. It is read
part by part, refusing it as soon as a file grows past the upload limit or the
"meta" part past MAX_META_BYTES, so an oversized part is never held whole.
Which parts are files, and the names and types they carry, follow busboy:
a part with a filename, or typed application/octet-stream, is a file; one
with no form-data Content-Disposition is skipped; a part's type defaults to
text/plain. Names are read as UTF-8.
"""

from __future__ import annotations

import codecs
import re
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import Any

from python_multipart.exceptions import MultipartParseError
from python_multipart.multipart import MultipartParser

# The "meta" part is small JSON: a title, a hypothesis (at most 20000
# characters) and params and results (at most 64 KiB of JSON each), with room to spare.
MAX_META_BYTES = 256 * 1024
UNREADABLE = "The multipart body could not be read"
# busboy's limits on a part's headers.
_MAX_HEADER_PAIRS = 2000
_MAX_HEADER_BYTES = 16 * 1024

_TOKEN = re.compile(r"[!#$%&'*+\-.^_`|~0-9A-Za-z]+")
_CHARSET = re.compile(r"[!#$%&+\-^_`{}~0-9A-Za-z]+")
_EXTENDED = re.compile(r"(?:[!#$&+\-.^_`|~0-9A-Za-z]|%[0-9A-Fa-f]{2})*")
_QUOTED = re.compile(r'"((?:[\t \x21\x23-\x5b\x5d-\x7e\x80-\xff]|\\[\s\S])*)"')
_SPACE = re.compile(r"[ \t]*")
# busboy reads these as latin1, windows-1252 included.
_LATIN1 = {"latin1", "ascii", "us-ascii", "iso-8859-1", "iso8859-1", "iso88591", "iso_8859-1", "windows-1252",
           "iso_8859-1:1987", "cp1252", "x-cp1252"}  # fmt: skip


class UploadError(Exception):
    """Why an upload can't be read, with the status to answer."""

    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status


def _charset(name: str) -> str | None:
    name = name.lower()
    if name in ("utf8", "utf-8"):
        return "utf-8"
    if name in _LATIN1:
        return "latin-1"
    if name in ("utf16le", "utf-16le", "ucs2", "ucs-2"):
        return "utf-16-le"
    try:
        return codecs.lookup(name).name
    except LookupError:
        return None


def _params(text: str, i: int, *, utf8_values: bool) -> dict[str, str] | None:
    """`; name=value` parameters from position i, as busboy reads them; None when malformed. First one wins."""
    params: dict[str, str] = {}
    while i < len(text):
        i = _SPACE.match(text, i).end()  # type: ignore[union-attr]
        if i == len(text):
            break
        if text[i] != ";":
            return None
        i = _SPACE.match(text, i + 1).end()  # type: ignore[union-attr]
        name_match = _TOKEN.match(text, i)
        if not name_match or name_match.end() == len(text) or text[name_match.end()] != "=":
            return None
        name = name_match.group()
        i = name_match.end() + 1
        if name.endswith("*"):
            # RFC 5987: charset'language'percent-encoded
            charset = _CHARSET.match(text, i)
            if not charset or charset.end() == len(text) or text[charset.end()] != "'":
                return None
            quote = text.find("'", charset.end() + 1)
            if quote < 0 or quote + 1 == len(text):
                return None
            raw = _EXTENDED.match(text, quote + 1)
            assert raw is not None
            i = raw.end()
            if i < len(text) and text[i] == "%":
                return None
            encoding = _charset(charset.group())
            if encoding is None:
                return None
            data = re.sub(r"%([0-9A-Fa-f]{2})", lambda m: chr(int(m.group(1), 16)), raw.group())
            value = data.encode("latin-1").decode(encoding, errors="replace")
        else:
            if i == len(text):
                return None
            if text[i] == '"':
                quoted = _QUOTED.match(text, i)
                if not quoted:
                    return None
                value = re.sub(r"\\([\s\S])", r"\1", quoted.group(1))
                i = quoted.end()
            else:
                token = _TOKEN.match(text, i)
                if not token:
                    return None
                value = token.group()
                i = token.end()
            if utf8_values:
                value = value.encode("latin-1", errors="replace").decode("utf-8", errors="replace")
        params.setdefault(name.lower(), value)
    return params


def parse_content_type(text: str) -> tuple[str, dict[str, str]] | None:
    """`type/subtype` (lower case) and its parameters, or None when busboy couldn't read it."""
    kind = re.match(r"([!#$%&'*+\-.^_`|~0-9A-Za-z]+)/([!#$%&'*+\-.^_`|~0-9A-Za-z]+)", text)
    if not kind:
        return None
    params = _params(text, kind.end(), utf8_values=False)
    if params is None:
        return None
    return f"{kind.group(1).lower()}/{kind.group(2).lower()}", params


def _disposition(text: str) -> tuple[str, dict[str, str]] | None:
    kind = _TOKEN.match(text)
    end = kind.end() if kind else 0
    params = _params(text, end, utf8_values=True)
    if params is None or not text:
        return None
    return text[:end].lower(), params


@dataclass
class _Part:
    headers: dict[str, str] = field(default_factory=dict)
    name: str | None = None
    kind: str = "skip"  # skip, field or file
    mime: str = "text/plain"
    charset: str = "utf-8"
    chunks: list[bytes] = field(default_factory=list)
    size: int = 0


@dataclass
class Upload:
    meta: str | None
    files: list[dict[str, Any]]


class _Reader:
    def __init__(self, boundary: str, max_file_bytes: int) -> None:
        self.max_file_bytes = max_file_bytes
        self.meta: str | None = None
        self.files: list[dict[str, Any]] = []
        self.ended = False
        self.part = _Part()
        self._header_name = bytearray()
        self._header_value = bytearray()
        self._header_bytes = 0
        self._header_pairs = 0
        self.parser = MultipartParser(
            boundary,
            {
                "on_part_begin": self._begin,
                "on_header_field": self._header_field,
                "on_header_value": self._header_value_data,
                "on_header_end": self._header_end,
                "on_headers_finished": self._headers_done,
                "on_part_data": self._data,
                "on_part_end": self._end,
                "on_end": self._finish,
            },
            max_header_count=_MAX_HEADER_PAIRS,
            max_header_size=_MAX_HEADER_BYTES,
        )

    def _too_large(self, name: str | None) -> UploadError:
        if name == "meta":
            return UploadError(413, f'The "meta" part exceeds {MAX_META_BYTES} bytes')
        return UploadError(413, f"{name} exceeds {self.max_file_bytes} bytes")

    def _set_meta(self, text: str) -> None:
        if self.meta is not None:
            raise UploadError(400, 'Send one "meta" part')
        self.meta = text

    def _begin(self) -> None:
        self.part = _Part()
        self._header_bytes = 0
        self._header_pairs = 0

    def _count(self, size: int) -> None:
        self._header_bytes += size
        if self._header_bytes >= _MAX_HEADER_BYTES:
            raise UploadError(400, UNREADABLE)

    def _header_field(self, data: bytes, start: int, end: int) -> None:
        self._count(end - start)
        self._header_name += data[start:end]

    def _header_value_data(self, data: bytes, start: int, end: int) -> None:
        self._count(end - start)
        self._header_value += data[start:end]

    def _header_end(self) -> None:
        name = self._header_name.decode("latin-1").strip().lower()
        value = self._header_value.decode("latin-1").strip(" \t")
        self._header_name.clear()
        self._header_value.clear()
        self._header_pairs += 1
        if self._header_pairs <= _MAX_HEADER_PAIRS:
            self.part.headers.setdefault(name, value)

    def _headers_done(self) -> None:
        part = self.part
        found = _disposition(part.headers.get("content-disposition", ""))
        if not found or found[0] != "form-data":
            return  # skipped, as busboy skips it
        params = found[1]
        part.name = params.get("name") or None
        filename = params.get("filename*") or params.get("filename") or None
        content_type = parse_content_type(part.headers.get("content-type", ""))
        if content_type:
            part.mime = content_type[0]
            if "charset" in content_type[1]:
                part.charset = _charset(content_type[1]["charset"]) or "utf-8"
        part.kind = (
            "file" if filename is not None or part.mime == "application/octet-stream" else "field"
        )

    def _data(self, data: bytes, start: int, end: int) -> None:
        part = self.part
        if part.kind == "skip":
            return
        part.size += end - start
        if part.kind == "file":
            if part.name is None:
                raise UploadError(400, "Name each file part by its path in the experiment")
            if part.size > (MAX_META_BYTES if part.name == "meta" else self.max_file_bytes):
                raise self._too_large(part.name)
        elif part.size > MAX_META_BYTES:
            # Refused now, with the answer its end would get, so a large field is never held.
            self._check_field(part)
            raise self._too_large("meta")
        part.chunks.append(data[start:end])

    @staticmethod
    def _check_field(part: _Part) -> None:
        if part.name != "meta":
            name = "undefined" if part.name is None else part.name
            raise UploadError(
                400, f'"{name}" isn\'t a file: put everything but files in the "meta" part'
            )

    def _end(self) -> None:
        part = self.part
        if part.kind == "field":
            self._check_field(part)
            self._set_meta(b"".join(part.chunks).decode(part.charset, errors="replace"))
        elif part.kind == "file":
            if part.name is None:
                raise UploadError(400, "Name each file part by its path in the experiment")
            content = b"".join(part.chunks)
            if part.name == "meta":
                # As TextDecoder reads it: a leading byte order mark dropped.
                self._set_meta(content.decode("utf-8-sig", errors="replace"))
                return
            upload: dict[str, Any] = {"path": part.name, "bytes": content}
            if part.mime and part.mime != "application/octet-stream":
                upload["mime"] = part.mime
            self.files.append(upload)

    def _finish(self) -> None:
        self.ended = True

    def write(self, data: bytes) -> None:
        try:
            self.parser.write(data)
        except MultipartParseError as err:
            raise UploadError(400, UNREADABLE) from err


async def read_parts(content_type: str, body: AsyncIterator[bytes], max_file_bytes: int) -> Upload:
    """The "meta" part's text (None if there is none) and the files of a multipart body."""
    parsed = parse_content_type(content_type)
    boundary = parsed[1].get("boundary") if parsed else None
    if not boundary:
        raise UploadError(400, UNREADABLE)
    reader = _Reader(boundary, max_file_bytes)
    # Text before the first boundary (a preamble) is skipped, as busboy skips it:
    # the body starts at "--boundary" at its very start or after a line break.
    start = b"--" + boundary.encode("latin-1")
    pending = b"\r\n"
    started = False
    async for chunk in body:
        if started:
            reader.write(chunk)
            continue
        pending += chunk
        found = pending.find(b"\r\n" + start)
        if found < 0:
            pending = pending[-(len(start) + 1) :]
            continue
        started = True
        rest = pending[found + 2 :]
        if rest.startswith(start + b"--"):
            reader.ended = True  # an empty form
            break
        reader.write(rest)
    if not reader.ended:
        raise UploadError(400, UNREADABLE)
    return Upload(reader.meta, reader.files)
