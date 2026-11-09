"""The shapes every paper tool returns.

These are the contract between the chat UI (its paper cards read them) and any
paper search server, this demo or an internal one: keep the field names, and a
server that returns them works with the chatroom unchanged.
"""

from __future__ import annotations

import re
import unicodedata
from typing import Literal

from pydantic import BaseModel, Field

Source = Literal["openalex", "arxiv"]


class Author(BaseModel):
    name: str
    id: str | None = None


class Paper(BaseModel):
    """One paper. `id` is "<scheme>:<id>": openalex:W…, doi:10.…, or arxiv:2401.01234."""

    id: str
    title: str
    authors: list[Author] = Field(description="The first authors, at most 10; author_count has the total.")
    author_count: int
    year: int | None = None
    published: str | None = Field(None, description="ISO date.")
    venue: str | None = None
    abstract: str | None = Field(None, description="Shortened in search results; whole in get_paper.")
    url: str = Field(description="The paper's page.")
    pdf_url: str | None = Field(None, description="An open-access PDF, when known.")
    doi: str | None = None
    arxiv_id: str | None = None
    citation_count: int | None = None
    open_access: bool = False
    source: Source


class PaperDetails(Paper):
    references_count: int | None = None
    bibtex: str


class PaperSearchResult(BaseModel):
    query: str
    results: list[Paper]
    total: int | None = None
    next_cursor: str | None = Field(None, description="Pass back as `cursor` for more results; null at the end.")


class Section(BaseModel):
    title: str
    line: int


class PaperText(BaseModel):
    id: str
    title: str
    text: str = Field(description="Lines offset to offset+limit-1 of the paper's text, numbered.")
    offset: int
    next_offset: int | None = Field(None, description="Where to read on; null at the end.")
    total_lines: int
    sections: list[Section] = Field(description="Headings found in the text, with their line numbers.")


class SavedPaper(BaseModel):
    path: str
    node: str | None = None
    experiment: str | None = None
    pdf_path: str | None = None
    proposed: bool = Field(description="True when the save became a proposal for an editor of the node to accept.")
    note: str | None = None


# --- ids -------------------------------------------------------------------

ARXIV_ID = re.compile(r"^(\d{4}\.\d{4,5}|[a-z-]+(\.[A-Z]{2})?/\d{7})(v\d+)?$", re.IGNORECASE)
OPENALEX_ID = re.compile(r"^W\d+$", re.IGNORECASE)


def parse_id(value: str) -> tuple[str, str]:
    """("openalex" | "doi" | "arxiv", bare id) for a paper id, also accepting plain links and bare ids."""
    raw = value.strip()
    lowered = raw.lower()
    for prefix, scheme in (
        ("openalex:", "openalex"),
        ("https://openalex.org/", "openalex"),
        ("doi:", "doi"),
        ("https://doi.org/", "doi"),
        ("http://doi.org/", "doi"),
        ("arxiv:", "arxiv"),
        ("https://arxiv.org/abs/", "arxiv"),
        ("http://arxiv.org/abs/", "arxiv"),
        ("https://arxiv.org/pdf/", "arxiv"),
    ):
        if lowered.startswith(prefix):
            raw, lowered = raw[len(prefix):], lowered[len(prefix):]
            if scheme == "arxiv":
                raw = raw.removesuffix(".pdf")
            return _checked(scheme, raw)
    if OPENALEX_ID.match(raw):
        return "openalex", raw.upper()
    if raw.startswith("10."):
        return "doi", raw
    if ARXIV_ID.match(raw):
        return "arxiv", raw
    raise ValueError(f"Not a paper id: {value!r}. Use openalex:W…, doi:10.… or arxiv:<id> from search_papers.")


def _checked(scheme: str, bare: str) -> tuple[str, str]:
    if scheme == "openalex" and OPENALEX_ID.match(bare):
        return scheme, bare.upper()
    if scheme == "doi" and bare.startswith("10.") and "/" in bare:
        return scheme, bare
    if scheme == "arxiv" and ARXIV_ID.match(bare):
        return scheme, bare
    raise ValueError(f"Not a valid {scheme} id: {bare!r}")


def arxiv_from_doi(doi: str | None) -> str | None:
    """arXiv's own DOIs (10.48550/arXiv.<id>) name the arXiv paper."""
    if doi and doi.lower().startswith("10.48550/arxiv."):
        return doi[len("10.48550/arxiv."):]
    return None


# --- text helpers ------------------------------------------------------------


def shorten(text: str | None, limit: int) -> str | None:
    if text is None or len(text) <= limit:
        return text
    cut = text[:limit].rsplit(" ", 1)[0]
    return cut.rstrip(" ,;:") + "…"


def slug(title: str, limit: int = 60) -> str:
    """A file name from a title: ascii, lowercase, words joined by -."""
    ascii_title = unicodedata.normalize("NFKD", title).encode("ascii", "ignore").decode()
    words = re.findall(r"[a-z0-9]+", ascii_title.lower())
    out = ""
    for word in words:
        if len(out) + len(word) + 1 > limit:
            break
        out = f"{out}-{word}" if out else word
    return out or "paper"


def bibtex(paper: Paper) -> str:
    first = paper.authors[0].name.split()[-1] if paper.authors else "anon"
    first_word = next((w for w in re.findall(r"[a-z0-9]+", paper.title.lower()) if len(w) > 3), "paper")
    key = re.sub(r"[^a-z0-9]", "", unicodedata.normalize("NFKD", first).encode("ascii", "ignore").decode().lower())
    key = f"{key or 'anon'}{paper.year or ''}{first_word}"
    authors = " and ".join(a.name for a in paper.authors)
    if paper.author_count > len(paper.authors):
        authors += " and others"
    preprint = bool(paper.arxiv_id) and (not paper.venue or "arxiv" in paper.venue.lower())
    fields = [
        ("title", paper.title),
        ("author", authors),
        ("year", str(paper.year) if paper.year else None),
        ("journal", None if preprint else paper.venue),
        ("doi", paper.doi),
        ("eprint", paper.arxiv_id),
        ("archivePrefix", "arXiv" if paper.arxiv_id else None),
        ("url", paper.url),
    ]
    body = ",\n".join(f"  {name} = {{{value}}}" for name, value in fields if value)
    kind = "misc" if preprint else "article"
    return f"@{kind}{{{key},\n{body}\n}}"
