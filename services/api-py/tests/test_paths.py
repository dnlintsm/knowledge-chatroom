"""File paths, types and kinds (paths.py), as the browser reads them.

tests/unit/file-contracts.spec.ts checks the browser's side against the same
table; it compared both with the TypeScript agent's paths.ts until #264 removed it.
"""

from __future__ import annotations

import pytest

from api_py.paths import (
    InvalidPathError,
    is_text_file,
    kind_for_path,
    mime_for_path,
    normalize_path,
)

TYPES = [
    ("notes/a.MD", "text/markdown", "note"),
    ("notes/a.html", "text/html", "note"),
    ("uploads/a.svg", "image/svg+xml", "upload"),
    ("uploads/a.png", "image/png", "upload"),
    ("artifacts/a.json", "application/json", "artifact"),
    ("uploads/a.unknown", "application/octet-stream", "upload"),
]


def test_relative_paths_reject_traversal_and_control_bytes():
    assert normalize_path(" /notes//folder\\a.md ") == "notes/folder/a.md"
    for path in ("", "notes/", "../secret", "notes/./a", "notes/../a", "notes/\x00a", "a" * 1025):
        with pytest.raises(InvalidPathError):
            normalize_path(path)


@pytest.mark.parametrize(("path", "mime", "kind"), TYPES)
def test_types_and_kinds_match_the_browser(path: str, mime: str, kind: str):
    assert mime_for_path(path) == mime and kind_for_path(path) == kind


def test_svg_is_stored_as_text():
    # The browser shows it as an image (types.ts isTextFile is false for it).
    assert is_text_file("uploads/a.svg", "image/svg+xml")
