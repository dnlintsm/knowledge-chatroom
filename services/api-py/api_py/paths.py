"""File path rules, as packages/contracts/src/files.ts gives them to the app and the TypeScript server.

The top-level folder decides the kind of file (notes/, skills/, uploads/,
artifacts/; anything else is a note). Lengths count UTF-16 code units and
trim() strips JavaScript's whitespace, so a path is accepted or refused here
exactly as there.
"""

from __future__ import annotations

import json
import re

KIND_FOLDERS: dict[str, str] = {
    "note": "notes",
    "skill": "skills",
    "upload": "uploads",
    "artifact": "artifacts",
}

# What String.prototype.trim() and \s strip in JavaScript (WhiteSpace and LineTerminator).
JS_SPACE = "\t\n\v\f\r    -     　﻿"
_TRIM = re.compile(f"^[{JS_SPACE}]+|[{JS_SPACE}]+$")
_CONTROL = re.compile(r"[\x00-\x1f]")

MIME_BY_EXT: dict[str, str] = {
    "md": "text/markdown",
    "markdown": "text/markdown",
    "txt": "text/plain",
    "csv": "text/csv",
    "json": "application/json",
    "html": "text/html",
    "pdf": "application/pdf",
    "png": "image/png",
    "jpg": "image/jpeg",
    "jpeg": "image/jpeg",
    "gif": "image/gif",
    "webp": "image/webp",
    "svg": "image/svg+xml",
    "bmp": "image/bmp",
    "ico": "image/x-icon",
    "avif": "image/avif",
    "apng": "image/apng",
    "tsv": "text/tab-separated-values",
    "htm": "text/html",
    "mp3": "audio/mpeg",
    "wav": "audio/wav",
    "ogg": "audio/ogg",
    "oga": "audio/ogg",
    "opus": "audio/ogg",
    "m4a": "audio/mp4",
    "aac": "audio/aac",
    "flac": "audio/flac",
    "mp4": "video/mp4",
    "m4v": "video/mp4",
    "webm": "video/webm",
    "ogv": "video/ogg",
    "mov": "video/quicktime",
}

TEXT_EXTENSIONS = frozenset(
    {
        "md",
        "markdown",
        "txt",
        "json",
        "csv",
        "ts",
        "tsx",
        "js",
        "jsx",
        "py",
        "yaml",
        "yml",
        "html",
        "css",
        "sql",
        "sh",
        "toml",
        "xml",
        "htm",
        "tsv",
        "log",
        "ini",
        "cfg",
        "conf",
        "env",
        "jsonl",
        "ipynb",
        "mjs",
        "cjs",
        "mts",
        "cts",
        "scss",
        "less",
        "vue",
        "svelte",
        "graphql",
        "go",
        "rs",
        "java",
        "kt",
        "c",
        "h",
        "cpp",
        "hpp",
        "cc",
        "cs",
        "rb",
        "php",
        "swift",
        "scala",
        "r",
        "lua",
        "pl",
        "bash",
        "zsh",
        "ps1",
        "bat",
        "tex",
        "rst",
    }
)


class InvalidPathError(ValueError):
    pass


def js_trim(text: str) -> str:
    return _TRIM.sub("", text)


def utf16_len(text: str) -> int:
    """String.prototype.length: characters outside the BMP count twice."""
    return len(text) + sum(1 for c in text if ord(c) > 0xFFFF)


def js_stringify(value: str) -> str:
    """JSON.stringify for a string."""
    return json.dumps(value, ensure_ascii=False)


def normalize_path(raw: str) -> str:
    """A relative path, cleaned; refuses anything that could escape the tree."""
    path = re.sub(r"/+", "/", re.sub(r"^/+", "", js_trim(raw).replace("\\", "/")))
    segments = path.split("/")
    if (
        path == ""
        or path.endswith("/")
        or utf16_len(path) > 1024
        or any(s in (".", "..") or _CONTROL.search(s) for s in segments)
    ):
        raise InvalidPathError(f"Invalid path: {js_stringify(raw)}")
    return path


def kind_for_path(path: str) -> str:
    top = path.split("/")[0]
    return next((kind for kind, folder in KIND_FOLDERS.items() if folder == top), "note")


def extension(path: str) -> str:
    name = path.split("/")[-1]
    dot = name.rfind(".")
    return "" if dot == -1 else name[dot + 1 :].lower()


def mime_for_path(path: str) -> str:
    ext = extension(path)
    return MIME_BY_EXT.get(ext) or (
        "text/plain" if ext in TEXT_EXTENSIONS else "application/octet-stream"
    )


_MIME = re.compile(r"[a-z0-9][a-z0-9!#$&^_.+-]{0,126}/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}")
# What a browser may show in place when it opens a signed link to the object
# store. Everything else is downloaded: the store's origin has none of the
# sandboxing the app puts on the files it serves itself, so a page, an SVG or
# an XML document there would run as a site of its own.
_INLINE = re.compile(r"(image/(?!svg\+xml$)|audio/|video/)[a-z0-9.+-]+|application/pdf")


def clean_mime(value: str | None) -> str | None:
    """
    A content type as it is stored: its type/subtype in lowercase, without
    parameters. None when it isn't one, or says nothing (application/octet-stream),
    so the type comes from the path instead.
    """
    mime = (value or "").split(";")[0].strip().lower()
    if not _MIME.fullmatch(mime) or mime == "application/octet-stream":
        return None
    return mime


def shown_inline(mime: str) -> bool:
    """Whether a file of this type may open in the browser from the object store's own origin."""
    return bool(_INLINE.fullmatch(mime.lower()))


def is_text_file(path: str, mime: str, svg_as_text: bool = True) -> bool:
    mime = mime.lower()
    return (
        mime.startswith("text/")
        or mime == "application/json"
        or (svg_as_text and mime == "image/svg+xml")
        or extension(path) in TEXT_EXTENSIONS
    )
