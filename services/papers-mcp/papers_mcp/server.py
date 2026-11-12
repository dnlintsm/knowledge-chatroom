"""Paper search as an MCP server for the chatroom's agent (issue #151).

Run it:

    python -m papers_mcp.server           # http://127.0.0.1:9200/mcp

and point the chatroom at it (see ../README.md):

    MCP_SERVERS={"mcpServers":{"papers":{"url":"http://127.0.0.1:9200/mcp","forwardIdentity":true,"storageAccess":true}}}

Claude sees the tools as mcp__papers__<tool>. The chat's paper cards look for
that name, so keep the server called "papers". Each tool returns its result as
structured content and as the same JSON in a text block; the cards read the
text, Claude reads either.

The tool names, arguments and result shapes (./models.py) are the contract: an
internal paper search server that keeps them works with the chatroom as is.
"""

from __future__ import annotations

import datetime
import json
import os
import posixpath
from typing import Annotated, Literal

import anyio
from mcp.server.mcpserver import Context, MCPServer
from mcp.server.mcpserver.exceptions import ToolError
from mcp.types import ToolAnnotations
from pydantic import Field

from knowledge_chatroom import identity, storage

from . import arxiv, fulltext, net, openalex
from .models import PaperDetails, PaperSearchResult, PaperText, SavedPaper, parse_id, slug

# Must match the server's name in MCP_SERVERS: forwarded users are signed for it.
SERVER_NAME = os.environ.get("PAPERS_NAME", "papers")
# The chatroom's public key (agent GET /identity/public-key) when login is on;
# unset = no login. Never give this server AUTH_SECRET.
PUBLIC_KEY = (
    identity.public_key(os.environ["KNOWLEDGE_PUBLIC_KEY"])
    if os.environ.get("KNOWLEDGE_PUBLIC_KEY")
    else None
)
# The chatroom's agent server (LOCAL_AGENT_URL), whose storage API save_paper writes through.
STORAGE_URL = os.environ.get("KNOWLEDGE_STORAGE_URL", "http://127.0.0.1:8000")

INSTRUCTIONS = """Search academic papers (OpenAlex, with arXiv for new preprints).
Use search_papers to find papers, get_paper for one paper's whole abstract and BibTeX,
read_paper to read its full text a page of lines at a time (look at `sections` first and
jump to the part you need), and related_papers for what it cites, what cites it, or similar work.
Cite papers as markdown links to their `url`. Never invent a paper, an author or a number:
only cite what a tool returned. save_paper saves a paper as a note in the user's workspace;
save when the user asks, and ask before saving more than 5 papers at once."""

mcp = MCPServer(SERVER_NAME, instructions=INSTRUCTIONS)

READ_ONLY = ToolAnnotations(readOnlyHint=True, openWorldHint=True)
WRITES = ToolAnnotations(
    readOnlyHint=False, destructiveHint=False, idempotentHint=True, openWorldHint=True
)

PaperId = Annotated[
    str,
    Field(
        description='A paper id from search_papers: "openalex:W…", "doi:10.…" or "arxiv:2401.01234".'
    ),
]


def require_user(ctx: Context) -> identity.User:
    """The signed-in user calling this tool; refuses calls that can't prove one."""
    user = identity.caller(ctx.headers, PUBLIC_KEY, f"mcp:{SERVER_NAME}")
    if user is None:
        raise ToolError(
            "Unknown caller: the chatroom must forward the user (forwardIdentity), "
            "and this server needs the chatroom's KNOWLEDGE_PUBLIC_KEY."
        )
    return user


async def _run(fn, *args, **kwargs):
    """Runs a blocking lookup off the event loop; source failures become tool errors for Claude."""
    try:
        return await anyio.to_thread.run_sync(lambda: fn(*args, **kwargs))
    except (net.SourceError, storage.WorkspaceError, ValueError) as err:
        raise ToolError(str(err)) from err


def lookup(paper_id: str) -> PaperDetails:
    """A paper's details from OpenAlex, or from arXiv for arXiv papers OpenAlex doesn't have yet."""
    scheme, bare = parse_id(paper_id)
    try:
        return openalex.details(openalex.work(scheme, bare))
    except net.SourceError as err:
        arxiv_id = bare if scheme == "arxiv" else None
        if scheme == "doi" and bare.lower().startswith("10.48550/arxiv."):
            arxiv_id = bare[len("10.48550/arxiv.") :]
        if arxiv_id and str(err).startswith("Not found"):
            return arxiv.get(arxiv_id)
        raise


@mcp.tool(annotations=READ_ONLY)
async def search_papers(
    query: Annotated[
        str, Field(description="What to look for, in words: a topic, a method, a title.")
    ],
    ctx: Context,
    year_from: Annotated[int | None, Field(description="Only papers from this year on.")] = None,
    year_to: Annotated[int | None, Field(description="Only papers up to this year.")] = None,
    authors: Annotated[
        list[str] | None, Field(description="Only papers by all of these authors (names).")
    ] = None,
    venue: Annotated[
        str | None, Field(description="Only papers in this journal or conference (name).")
    ] = None,
    open_access_only: Annotated[
        bool, Field(description="Only papers with free full text.")
    ] = False,
    sort: Annotated[
        Literal["relevance", "recent", "citations"], Field(description="Result order.")
    ] = "relevance",
    limit: Annotated[int, Field(ge=1, le=25, description="How many papers to return.")] = 8,
    cursor: Annotated[
        str | None, Field(description="next_cursor from the previous call, for more results.")
    ] = None,
) -> PaperSearchResult:
    """Search academic papers. Returns titles, authors, year, venue, citation counts, links and
    shortened abstracts. Use get_paper for a paper's whole abstract and read_paper for its text."""
    require_user(ctx)
    if not query.strip():
        raise ToolError("Give a query.")
    return await _run(
        openalex.search,
        query.strip(),
        year_from=year_from,
        year_to=year_to,
        authors=authors,
        venue=venue,
        open_access_only=open_access_only,
        sort=sort,
        limit=limit,
        cursor=cursor,
    )


@mcp.tool(annotations=READ_ONLY)
async def get_paper(id: PaperId, ctx: Context) -> PaperDetails:
    """One paper's details: the whole abstract, links, citation count, number of references and BibTeX."""
    require_user(ctx)
    return await _run(lookup, id)


def _read(paper_id: str, offset: int, limit: int) -> PaperText:
    paper = lookup(paper_id)
    if not paper.pdf_url:
        raise ToolError(
            f"{paper.title} has no open-access full text; use its abstract (get_paper) instead."
        )
    lines = fulltext.lines_for(paper.pdf_url)
    if offset > len(lines):
        raise ToolError(f"The paper has {len(lines)} lines; offset {offset} is past the end.")
    text, next_offset = fulltext.page(lines, offset, limit)
    return PaperText(
        id=paper.id,
        title=paper.title,
        text=text,
        offset=offset,
        next_offset=next_offset,
        total_lines=len(lines),
        sections=fulltext.sections(lines),
    )


@mcp.tool(annotations=READ_ONLY)
async def read_paper(
    id: PaperId,
    ctx: Context,
    offset: Annotated[int, Field(ge=1, description="First line to read.")] = 1,
    limit: Annotated[int, Field(ge=1, le=1000, description="How many lines to read.")] = 300,
) -> PaperText:
    """Read a paper's full text from its open-access PDF, `limit` lines from `offset`. The result lists
    the paper's sections with their line numbers: read those first and jump to the part you need,
    rather than reading the whole paper."""
    require_user(ctx)
    return await _run(_read, id, offset, limit)


def _related(paper_id: str, kind: str, limit: int) -> PaperSearchResult:
    scheme, bare = parse_id(paper_id)
    raw = openalex.work(scheme, bare)
    results = openalex.related(raw, kind, limit)  # type: ignore[arg-type]
    return PaperSearchResult(query=f"{kind}: {paper_id}", results=results, total=len(results))


@mcp.tool(annotations=READ_ONLY)
async def related_papers(
    id: PaperId,
    ctx: Context,
    kind: Annotated[
        Literal["cites", "cited_by", "similar"],
        Field(
            description="cites: the papers it references; cited_by: papers that cite it; similar: related work."
        ),
    ] = "similar",
    limit: Annotated[int, Field(ge=1, le=25, description="How many papers to return.")] = 8,
) -> PaperSearchResult:
    """Papers connected to one paper: its references, the papers citing it, or similar papers, most cited first."""
    require_user(ctx)
    return await _run(_related, id, kind, limit)


def note_markdown(paper: PaperDetails, pdf_path: str | None = None) -> str:
    """The saved note: front matter for search and tools, then what a person reads."""
    meta = {
        "paper": paper.id,
        "title": paper.title,
        "authors": [a.name for a in paper.authors]
        + (["et al."] if paper.author_count > len(paper.authors) else []),
        "year": paper.year,
        "venue": paper.venue,
        "doi": paper.doi,
        "arxiv": paper.arxiv_id,
        "url": paper.url,
        "pdf": paper.pdf_url,
        "citations": paper.citation_count,
        "saved": datetime.date.today().isoformat(),
    }
    front = "\n".join(
        f"{key}: {json.dumps(value, ensure_ascii=False)}"
        for key, value in meta.items()
        if value is not None
    )
    byline = " · ".join(
        str(part)
        for part in (
            ", ".join(meta["authors"]),  # type: ignore[arg-type]
            paper.venue,
            paper.year,
        )
        if part
    )
    links = [f"[Paper page]({paper.url})"]
    if paper.pdf_url:
        links.append(f"[PDF]({paper.pdf_url})")
    # The workspace preview drops bare relative links, so the saved copy is named, not linked.
    if pdf_path:
        links.append(f"PDF saved next to this note: `{posixpath.basename(pdf_path)}`")
    return (
        f"---\n{front}\n---\n\n# {paper.title}\n\n{byline}\n\n{' · '.join(links)}\n\n"
        f"## Abstract\n\n{paper.abstract or '_No abstract available._'}\n\n"
        f"## BibTeX\n\n```bibtex\n{paper.bibtex}\n```\n\n## Notes\n\n"
    )


def _clean_path(path: str) -> str:
    clean = posixpath.normpath(path.strip().lstrip("/"))
    if clean in ("", ".") or clean.startswith(".."):
        raise ValueError(f"Not a workspace path: {path!r}")
    return clean if clean.endswith(".md") else f"{clean}.md"


def _save(
    paper_id: str,
    path: str | None,
    node: str | None,
    experiment: str | None,
    include_pdf: bool,
    token: str | None,
) -> SavedPaper:
    paper = lookup(paper_id)
    target = _clean_path(path) if path else f"papers/{slug(paper.title)}.md"
    pdf_path = None
    note = f"Saved from paper search: {paper.title}"
    proposed = False
    if include_pdf:
        if not paper.pdf_url:
            raise ToolError(f"{paper.title} has no open-access PDF; save it without include_pdf.")
        data = net.get(paper.pdf_url, accept="application/pdf", max_bytes=fulltext.MAX_PDF_BYTES)
        if not data.startswith(b"%PDF"):
            raise ToolError(f"{paper.pdf_url} isn't a PDF; save it without include_pdf.")
        pdf_path = target.removesuffix(".md") + ".pdf"
        proposed = storage.write(
            STORAGE_URL,
            pdf_path,
            data,
            "application/pdf",
            token,
            node=node,
            experiment=experiment,
            note=note,
        )
    proposed = (
        storage.write(
            STORAGE_URL,
            target,
            note_markdown(paper, pdf_path).encode("utf-8"),
            "text/markdown",
            token,
            node=node,
            experiment=experiment,
            note=note,
        )
        or proposed
    )
    return SavedPaper(
        path=target,
        node=node,
        experiment=experiment,
        pdf_path=pdf_path,
        proposed=proposed,
        note="An editor of the node has to accept it before it shows in the node's files."
        if proposed
        else None,
    )


@mcp.tool(annotations=WRITES)
async def save_paper(
    id: PaperId,
    ctx: Context,
    path: Annotated[
        str | None,
        Field(description="Where to save the note; default papers/<title>.md in the place."),
    ] = None,
    node: Annotated[
        str | None, Field(description="Knowledge node id to save in (the user's currentNode).")
    ] = None,
    experiment: Annotated[
        str | None, Field(description="Experiment id to save in (the user's currentExperiment).")
    ] = None,
    include_pdf: Annotated[
        bool, Field(description="Also save the open-access PDF next to the note.")
    ] = False,
) -> SavedPaper:
    """Save a paper into the user's workspace as a markdown note (details, abstract, BibTeX and room for notes),
    at the workspace root, in a knowledge node (as a proposal an editor accepts) or in an experiment.
    Saving the same paper again updates its note."""
    require_user(ctx)
    token = (ctx.headers or {}).get(storage.STORAGE_HEADER)
    if PUBLIC_KEY and not token:
        raise ToolError(
            'Saving needs "storageAccess": true for this server in the chatroom\'s MCP_SERVERS.'
        )
    return await _run(_save, id, path, node, experiment, include_pdf, token)


def main() -> None:
    mcp.run(
        transport="streamable-http",
        host=os.environ.get("PAPERS_HOST", "127.0.0.1"),
        port=int(os.environ.get("PAPERS_PORT", "9200")),
    )


if __name__ == "__main__":
    main()
