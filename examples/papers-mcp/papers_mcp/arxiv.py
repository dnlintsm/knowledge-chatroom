"""Look up papers in arXiv's API (https://info.arxiv.org/help/api/).

OpenAlex covers arXiv too, but a paper posted this week may not be in it yet:
for arxiv: ids that OpenAlex doesn't know, the metadata comes from here.
"""

from __future__ import annotations

import os
import re
import urllib.parse
import xml.etree.ElementTree as ET

from . import net
from .models import Author, Paper, PaperDetails, bibtex

API = os.environ.get("ARXIV_URL", "https://export.arxiv.org/api/query")
NS = {"atom": "http://www.w3.org/2005/Atom", "arxiv": "http://arxiv.org/schemas/atom"}


def _text(entry: ET.Element, path: str) -> str | None:
    found = entry.find(path, NS)
    if found is None or found.text is None:
        return None
    return re.sub(r"\s+", " ", found.text).strip() or None


def parse_entry(entry: ET.Element) -> PaperDetails:
    abs_url = _text(entry, "atom:id") or ""
    arxiv_id = re.sub(r"v\d+$", "", abs_url.split("/abs/", 1)[-1])
    names = [_text(a, "atom:name") for a in entry.findall("atom:author", NS)]
    names = [n for n in names if n]
    published = _text(entry, "atom:published")
    doi = _text(entry, "arxiv:doi")
    paper = Paper(
        id=f"arxiv:{arxiv_id}",
        title=_text(entry, "atom:title") or "(untitled)",
        authors=[Author(name=n) for n in names[:10]],
        author_count=len(names),
        year=int(published[:4]) if published else None,
        published=published[:10] if published else None,
        venue=_text(entry, "arxiv:journal_ref") or "arXiv",
        abstract=_text(entry, "atom:summary"),
        url=f"https://arxiv.org/abs/{arxiv_id}",
        pdf_url=f"https://arxiv.org/pdf/{arxiv_id}",
        doi=doi,
        arxiv_id=arxiv_id,
        open_access=True,
        source="arxiv",
    )
    return PaperDetails(**paper.model_dump(), bibtex=bibtex(paper))


def get(arxiv_id: str) -> PaperDetails:
    url = f"{API}?{urllib.parse.urlencode({'id_list': arxiv_id, 'max_results': 1})}"
    try:
        feed = ET.fromstring(net.get(url, accept="application/atom+xml"))
    except ET.ParseError as err:
        raise net.SourceError("arXiv didn't answer a feed") from err
    entry = feed.find("atom:entry", NS)
    # A bad id comes back as an entry titled "Error".
    if entry is None or _text(entry, "atom:title") == "Error":
        raise net.SourceError(f"arXiv has no paper {arxiv_id}")
    return parse_entry(entry)
