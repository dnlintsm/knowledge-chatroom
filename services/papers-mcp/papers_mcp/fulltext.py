"""A paper's text from its open-access PDF, read a page of lines at a time.

PDF text comes out with hard line breaks and hyphenation; lines are kept as
they are (so line numbers stay stable between calls) apart from dropping blank
runs. Recently read papers stay in memory, so paging through one doesn't
download it again.
"""

from __future__ import annotations

import io
import os
import re
from collections import OrderedDict

from . import net
from .models import Section

MAX_PDF_BYTES = int(os.environ.get("PAPERS_MAX_PDF_BYTES", str(30_000_000)))
CACHE_SIZE = 16
_cache: OrderedDict[str, list[str]] = OrderedDict()

# "3 Method", "3.2. Training details", "IV. RESULTS", and common unnumbered ones.
NUMBERED = re.compile(r"^(\d{1,2}(\.\d{1,2}){0,2}\.?|[IVX]{1,5}\.)\s+[A-Z][\w ,:&()/-]{2,70}$")
NAMED = re.compile(
    r"^(abstract|introduction|background|related work|method(s|ology)?|approach|experiments?|results|"
    r"evaluation|discussion|conclusions?|limitations|acknowledg(e)?ments?|references|bibliography|appendix)$",
    re.IGNORECASE,
)


def pdf_lines(data: bytes) -> list[str]:
    from pypdf import PdfReader  # only read_paper needs it

    try:
        reader = PdfReader(io.BytesIO(data))
        text = "\n".join(page.extract_text() or "" for page in reader.pages)
    except Exception as err:  # pypdf raises many kinds for broken files
        raise net.SourceError(f"Couldn't read the PDF: {err}") from err
    lines: list[str] = []
    for line in text.splitlines():
        line = re.sub(r"\s+", " ", line).strip()
        if line or (lines and lines[-1]):
            lines.append(line)
    while lines and not lines[-1]:
        lines.pop()
    if not any(lines):
        raise net.SourceError("The PDF has no text layer (a scan?); only its abstract is available.")
    return lines


def lines_for(pdf_url: str) -> list[str]:
    if pdf_url in _cache:
        _cache.move_to_end(pdf_url)
        return _cache[pdf_url]
    data = net.get(pdf_url, accept="application/pdf", max_bytes=MAX_PDF_BYTES)
    if not data.startswith(b"%PDF"):
        raise net.SourceError(f"{pdf_url} isn't a PDF (the publisher may want a login); use the abstract instead.")
    lines = pdf_lines(data)
    _cache[pdf_url] = lines
    if len(_cache) > CACHE_SIZE:
        _cache.popitem(last=False)
    return lines


def sections(lines: list[str]) -> list[Section]:
    found = []
    for number, line in enumerate(lines, start=1):
        if len(line) <= 80 and (NUMBERED.match(line) or NAMED.match(line)):
            found.append(Section(title=line, line=number))
    return found[:60]


def page(lines: list[str], offset: int, limit: int) -> tuple[str, int | None]:
    """Lines offset..offset+limit-1, each with its number, and where to read on (None at the end)."""
    start = max(offset, 1) - 1
    chunk = lines[start : start + limit]
    width = len(str(len(lines)))
    text = "\n".join(f"{start + i + 1:>{width}}  {line}" for i, line in enumerate(chunk))
    end = start + len(chunk)
    return text, (end + 1 if end < len(lines) else None)
