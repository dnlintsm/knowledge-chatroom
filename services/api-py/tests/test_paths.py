"""File paths, types and kinds (paths.py), as the browser reads them.

tests/unit/file-contracts.spec.ts checks the browser's side against the same
table; it compared both with the TypeScript agent's paths.ts until #264 removed it.
"""

from __future__ import annotations

import pytest

from api_py.paths import (
    InvalidPathError,
    clean_mime,
    is_text_file,
    kind_for_path,
    mime_for_path,
    normalize_path,
    shown_inline,
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


def test_a_claimed_content_type_is_stored_normalised_or_not_at_all():
    assert clean_mime("Text/HTML; charset=utf-8") == "text/html"
    assert clean_mime(" image/PNG ") == "image/png"
    for nothing in (
        None,
        "",
        "application/octet-stream",
        "not a type",
        "text/",
        "/html",
        "a/b/c",
        "te xt/html",
    ):
        assert clean_mime(nothing) is None, nothing
    # Spelling doesn't change what counts as text.
    assert is_text_file("x.bin", "Text/HTML") and is_text_file("x.bin", "APPLICATION/JSON")


def test_only_media_opens_in_place_from_the_object_store():
    for kind in (
        "image/png",
        "image/jpeg",
        "Image/WebP",
        "application/pdf",
        "video/mp4",
        "audio/mpeg",
    ):
        assert shown_inline(kind), kind
    for kind in (
        "image/svg+xml",
        "text/html",
        "application/xhtml+xml",
        "application/xml",
        "application/zip",
        "application/octet-stream",
        "application/pdf+evil",
        "",
    ):
        assert not shown_inline(kind), kind
