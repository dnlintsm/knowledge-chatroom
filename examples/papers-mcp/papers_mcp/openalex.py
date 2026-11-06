"""Search and look up papers in OpenAlex (https://docs.openalex.org).

OpenAlex covers some 250 million works, arXiv included, with DOIs, citation
counts and open-access PDF links. It needs no key; OPENALEX_API_KEY raises the
daily budget and OPENALEX_MAILTO joins the "polite pool".
"""

from __future__ import annotations

import os
import re
import urllib.parse
from typing import Any, Literal

from . import net
from .models import Author, Paper, PaperDetails, PaperSearchResult, arxiv_from_doi, bibtex, shorten

API = os.environ.get("OPENALEX_URL", "https://api.openalex.org").rstrip("/")
MAX_AUTHORS = 10
SEARCH_ABSTRACT_CHARS = 600
Sort = Literal["relevance", "recent", "citations"]
SORTS = {"relevance": None, "recent": "publication_date:desc", "citations": "cited_by_count:desc"}
FIELDS = ",".join(
    [
        "id",
        "doi",
        "display_name",
        "publication_year",
        "publication_date",
        "authorships",
        "primary_location",
        "best_oa_location",
        "open_access",
        "cited_by_count",
        "abstract_inverted_index",
        "locations",
        "referenced_works_count",
    ]
)


def _url(path: str, params: dict[str, Any]) -> str:
    params = {k: v for k, v in params.items() if v is not None}
    if os.environ.get("OPENALEX_API_KEY"):
        params["api_key"] = os.environ["OPENALEX_API_KEY"]
    if os.environ.get("OPENALEX_MAILTO"):
        params["mailto"] = os.environ["OPENALEX_MAILTO"]
    return f"{API}{path}?{urllib.parse.urlencode(params, safe=':|,*')}"


def short_id(url: str | None) -> str | None:
    return url.rsplit("/", 1)[-1] if url else None


def _doi(value: str | None) -> str | None:
    if not value:
        return None
    for prefix in ("https://doi.org/", "http://doi.org/"):
        if value.lower().startswith(prefix):
            return value[len(prefix):]
    return value


def abstract_text(index: dict[str, list[int]] | None) -> str | None:
    """OpenAlex ships abstracts as {word: [positions]}; put the words back in order."""
    if not index:
        return None
    words: dict[int, str] = {}
    for word, positions in index.items():
        for position in positions:
            words[position] = word
    return " ".join(words[i] for i in sorted(words)) or None


def _arxiv_id(work: dict[str, Any]) -> str | None:
    found = arxiv_from_doi(_doi(work.get("doi")))
    if found:
        return found
    for location in work.get("locations") or []:
        page = (location or {}).get("landing_page_url") or ""
        if "arxiv.org/abs/" in page:
            return page.split("arxiv.org/abs/", 1)[1].split("?")[0]
    return None


def to_paper(work: dict[str, Any], abstract_limit: int | None = SEARCH_ABSTRACT_CHARS) -> Paper:
    authorships = work.get("authorships") or []
    primary = work.get("primary_location") or {}
    best = work.get("best_oa_location") or {}
    source = primary.get("source") or {}
    doi = _doi(work.get("doi"))
    arxiv_id = _arxiv_id(work)
    abstract = abstract_text(work.get("abstract_inverted_index"))
    openalex_url = work.get("id") or ""
    if arxiv_id:
        url = f"https://arxiv.org/abs/{arxiv_id}"
    elif doi:
        url = f"https://doi.org/{doi}"
    else:
        url = primary.get("landing_page_url") or openalex_url
    pdf = best.get("pdf_url") or primary.get("pdf_url") or (f"https://arxiv.org/pdf/{arxiv_id}" if arxiv_id else None)
    return Paper(
        id=f"openalex:{short_id(openalex_url)}",
        title=work.get("display_name") or work.get("title") or "(untitled)",
        authors=[
            Author(name=a["author"]["display_name"], id=short_id(a["author"].get("id")))
            for a in authorships[:MAX_AUTHORS]
            if (a.get("author") or {}).get("display_name")
        ],
        author_count=len(authorships),
        year=work.get("publication_year"),
        published=work.get("publication_date"),
        venue=source.get("display_name"),
        abstract=shorten(abstract, abstract_limit) if abstract_limit else abstract,
        url=url,
        pdf_url=pdf,
        doi=doi,
        arxiv_id=arxiv_id,
        citation_count=work.get("cited_by_count"),
        open_access=bool((work.get("open_access") or {}).get("is_oa")),
        source="openalex",
    )


def details(work: dict[str, Any]) -> PaperDetails:
    paper = to_paper(work, abstract_limit=None)
    return PaperDetails(**paper.model_dump(), references_count=work.get("referenced_works_count"), bibtex=bibtex(paper))


def _lookup(kind: str, name: str) -> str | None:
    """The best-matching author or source id for a name, or None."""
    found = net.get_json(_url(f"/{kind}", {"search": name, "per-page": 1, "select": "id"}))
    results = found.get("results") or []
    return short_id(results[0].get("id")) if results else None


def search(
    query: str,
    *,
    year_from: int | None = None,
    year_to: int | None = None,
    authors: list[str] | None = None,
    venue: str | None = None,
    open_access_only: bool = False,
    sort: Sort = "relevance",
    limit: int = 8,
    cursor: str | None = None,
) -> PaperSearchResult:
    filters: list[str] = []
    if year_from:
        filters.append(f"from_publication_date:{year_from}-01-01")
    if year_to:
        filters.append(f"to_publication_date:{year_to}-12-31")
    for name in authors or []:
        author_id = _lookup("authors", name)
        if not author_id:
            return PaperSearchResult(query=query, results=[], total=0)
        filters.append(f"authorships.author.id:{author_id}")
    if venue:
        source_id = _lookup("sources", venue)
        if not source_id:
            return PaperSearchResult(query=query, results=[], total=0)
        filters.append(f"primary_location.source.id:{source_id}")
    if open_access_only:
        filters.append("open_access.is_oa:true")
    found = net.get_json(
        _url(
            "/works",
            {
                "search": query,
                "filter": ",".join(filters) or None,
                "sort": SORTS[sort],
                "per-page": limit,
                "cursor": cursor or "*",
                "select": FIELDS,
            },
        )
    )
    meta = found.get("meta") or {}
    results = [to_paper(work) for work in found.get("results") or []]
    next_cursor = meta.get("next_cursor") if len(results) == limit else None
    return PaperSearchResult(query=query, results=results, total=meta.get("count"), next_cursor=next_cursor)


def work(scheme: str, bare: str) -> dict[str, Any]:
    """The raw OpenAlex work for an openalex, doi or arxiv id."""
    if scheme == "openalex":
        key = bare
    elif scheme == "doi":
        key = f"doi:{bare}"
    else:  # arXiv papers carry arXiv's DOI in OpenAlex
        key = f"doi:10.48550/arxiv.{re.sub(r'v[0-9]+$', '', bare)}"
    return net.get_json(_url(f"/works/{urllib.parse.quote(key, safe=':/')}", {}))


# OpenAlex takes at most 100 values in one OR filter.
MAX_OR_IDS = 100


def related(work_raw: dict[str, Any], kind: Literal["cites", "cited_by", "similar"], limit: int) -> list[Paper]:
    """Papers this one cites, papers citing it, or OpenAlex's similar papers, most cited first."""
    if kind == "cited_by":
        filters = [f"cites:{short_id(work_raw.get('id'))}"]
    else:
        ids = [short_id(i) for i in work_raw.get("referenced_works" if kind == "cites" else "related_works") or []]
        ids = list(dict.fromkeys(i for i in ids if i))
        # Rank all of them, not just the first `limit`: ask for the most cited of each batch, then merge.
        filters = ["ids.openalex:" + "|".join(ids[i : i + MAX_OR_IDS]) for i in range(0, len(ids), MAX_OR_IDS)]
    works: list[dict[str, Any]] = []
    for filt in filters:
        found = net.get_json(_url("/works", {"filter": filt, "sort": "cited_by_count:desc", "per-page": limit, "select": FIELDS}))
        works.extend(found.get("results") or [])
    works.sort(key=lambda w: w.get("cited_by_count") or 0, reverse=True)
    return [to_paper(w) for w in works[:limit]]
