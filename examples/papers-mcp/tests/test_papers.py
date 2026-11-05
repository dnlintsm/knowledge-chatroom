import asyncio
import base64
import json
import threading
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from mcp import Client
from mcp.server.mcpserver.exceptions import ToolError

from papers_mcp import fulltext, identity, models, net, openalex, server, workspace

FIXTURES = Path(__file__).parent / "fixtures"
RAG = json.loads((FIXTURES / "openalex_work_rag.json").read_text())
NQ = json.loads((FIXTURES / "openalex_work_nq.json").read_text())
SEARCH = json.loads((FIXTURES / "openalex_search.json").read_text())

# Signs test tokens as the chatroom's agent would (shared/identity-token.ts).
TEST_KEY = Ed25519PrivateKey.generate()


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode().rstrip("=")


def sign(payload: dict) -> str:
    body = "v2." + _b64(json.dumps(payload).encode())
    return body + "." + _b64(TEST_KEY.sign(body.encode()))


FOR_PAPERS = sign({"sub": "test|alice", "name": "Alice", "exp": 4102444800, "aud": "mcp:papers"})
FOR_LAB = sign({"sub": "test|alice", "name": "Alice", "exp": 4102444800, "aud": "mcp:lab"})


def tiny_pdf(lines: list[str]) -> bytes:
    """A one-page PDF with a text layer, enough for pypdf to read back."""
    text = "BT /F1 10 Tf 50 750 Td 12 TL " + " ".join(f"({line}) Tj T*" for line in lines) + " ET"
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
        b"<< /Length %d >>\nstream\n%s\nendstream" % (len(text), text.encode()),
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    out = b"%PDF-1.4\n"
    offsets = []
    for number, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += b"%d 0 obj\n%s\nendobj\n" % (number, body)
    xref = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objects) + 1)
    out += b"".join(b"%010d 00000 n \n" % o for o in offsets)
    out += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objects) + 1, xref)
    return out


PAPER_LINES = ["Retrieval-Augmented Generation", "Abstract", "We combine retrieval and generation.",
               "1 Introduction", "Models store knowledge.", "2 Methods", "We retrieve passages.", "References"]


class FakeWeb:
    """Stands in for net.get / net.get_json: answers by URL and remembers what was asked."""

    def __init__(self):
        self.asked: list[str] = []
        self.pdf = tiny_pdf(PAPER_LINES)

    def get(self, url: str, *, accept: str = "application/json", max_bytes=None) -> bytes:
        self.asked.append(url)
        parsed = urllib.parse.urlparse(url)
        query = urllib.parse.parse_qs(parsed.query)
        if parsed.netloc == "arxiv.org" and parsed.path.startswith("/pdf/"):
            return self.pdf
        if "export.arxiv.org" in parsed.netloc:
            name = "arxiv_entry.xml" if query["id_list"] == ["2611.00001"] else "arxiv_error.xml"
            return (FIXTURES / name).read_bytes()
        if parsed.path == "/authors":
            return json.dumps({"results": [{"id": "https://openalex.org/A0"}] if "lewis" in query["search"][0].lower() else []}).encode()
        if parsed.path == "/sources":
            return json.dumps({"results": []}).encode()
        if parsed.path == "/works":
            if "filter" in query and query["filter"][0].startswith(("ids.openalex", "cites")):
                return json.dumps({"meta": {"count": 1}, "results": [NQ]}).encode()
            return json.dumps(SEARCH).encode()
        key = urllib.parse.unquote(parsed.path.removeprefix("/works/"))
        if key in ("W3027879771", "doi:10.48550/arxiv.2005.11401"):
            return json.dumps(RAG).encode()
        if key in ("W2963403868", "doi:10.1162/tacl_a_00276"):
            return json.dumps(NQ).encode()
        raise net.SourceError(f"Not found: {url}")

    def get_json(self, url: str):
        return json.loads(self.get(url))


@pytest.fixture
def web(monkeypatch):
    fake = FakeWeb()
    monkeypatch.setattr(net, "get", fake.get)
    monkeypatch.setattr(net, "get_json", fake.get_json)
    fulltext._cache.clear()
    return fake


@pytest.fixture
def ctx(monkeypatch):
    monkeypatch.setattr(server, "PUBLIC_KEY", TEST_KEY.public_key())
    monkeypatch.setattr(server, "SERVER_NAME", "papers")
    return SimpleNamespace(headers={identity.HEADER: FOR_PAPERS})


def run(coro):
    return asyncio.run(coro)


# --- ids and helpers ----------------------------------------------------------


def test_ids_in_every_form():
    assert models.parse_id("openalex:W3027879771") == ("openalex", "W3027879771")
    assert models.parse_id("https://openalex.org/w3027879771") == ("openalex", "W3027879771")
    assert models.parse_id("W3027879771") == ("openalex", "W3027879771")
    assert models.parse_id("doi:10.1162/tacl_a_00276") == ("doi", "10.1162/tacl_a_00276")
    assert models.parse_id("https://doi.org/10.1162/tacl_a_00276") == ("doi", "10.1162/tacl_a_00276")
    assert models.parse_id("10.1162/tacl_a_00276") == ("doi", "10.1162/tacl_a_00276")
    assert models.parse_id("arxiv:2005.11401v4") == ("arxiv", "2005.11401v4")
    assert models.parse_id("https://arxiv.org/pdf/2005.11401.pdf") == ("arxiv", "2005.11401")
    assert models.parse_id("hep-th/9901001") == ("arxiv", "hep-th/9901001")
    for bad in ("", "paper about cats", "doi:nonsense", "openalex:A123"):
        with pytest.raises(ValueError):
            models.parse_id(bad)


def test_slug_and_bibtex():
    assert models.slug("Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks") == (
        "retrieval-augmented-generation-for-knowledge-intensive-nlp"
    )
    assert models.slug("Über Ç!") == "uber-c"
    assert models.slug("???") == "paper"
    details = openalex.details(RAG)
    assert details.bibtex.startswith("@misc{lewis2020retrieval,")
    assert "and others" in details.bibtex and "eprint = {2005.11401}" in details.bibtex


def test_openalex_work_becomes_a_paper():
    paper = openalex.to_paper(RAG)
    assert paper.id == "openalex:W3027879771"
    assert paper.arxiv_id == "2005.11401"
    assert paper.url == "https://arxiv.org/abs/2005.11401"
    assert paper.pdf_url == "https://arxiv.org/pdf/2005.11401"
    assert paper.doi == "10.48550/arxiv.2005.11401"
    assert len(paper.authors) == 10 and paper.author_count == 12
    assert paper.abstract.startswith("Large pre-trained language models have been shown")
    assert paper.open_access and paper.citation_count == 4473
    closed = openalex.to_paper(NQ)
    assert closed.url == "https://doi.org/10.1162/tacl_a_00276"
    assert closed.pdf_url is None and closed.abstract is None and not closed.open_access


def test_search_abstracts_are_shortened():
    long = dict(RAG, abstract_inverted_index={f"w{i}": [i] for i in range(400)})
    assert len(openalex.to_paper(long).abstract) <= openalex.SEARCH_ABSTRACT_CHARS + 1
    assert len(openalex.details(long).abstract) > openalex.SEARCH_ABSTRACT_CHARS


# --- tools ----------------------------------------------------------------------


def test_tools_need_a_caller_signed_for_this_server(web, ctx):
    for headers in ({}, {identity.HEADER: FOR_LAB}):
        with pytest.raises(ToolError, match="Unknown caller"):
            run(server.search_papers("rag", SimpleNamespace(headers=headers)))


def test_search_papers_sends_filters_and_pages(web, ctx):
    result = run(
        server.search_papers(
            "retrieval augmented generation", ctx, year_from=2019, year_to=2021, authors=["Patrick Lewis"],
            open_access_only=True, sort="citations", limit=2,
        )
    )
    assert [p.id for p in result.results] == ["openalex:W3027879771", "openalex:W2963403868"]
    assert result.total == 2 and result.next_cursor == "IlsxMDAuMCwgNDQ3M10i"
    works = urllib.parse.parse_qs(urllib.parse.urlparse(web.asked[-1]).query)
    assert works["search"] == ["retrieval augmented generation"]
    assert works["filter"] == [
        "from_publication_date:2019-01-01,to_publication_date:2021-12-31,authorships.author.id:A0,open_access.is_oa:true"
    ]
    assert works["sort"] == ["cited_by_count:desc"] and works["per-page"] == ["2"] and works["cursor"] == ["*"]
    # A last page has no cursor.
    assert run(server.search_papers("rag", ctx, limit=5)).next_cursor is None


def test_search_with_an_unknown_author_finds_nothing(web, ctx):
    result = run(server.search_papers("rag", ctx, authors=["Nobody Atall"]))
    assert result.results == [] and result.total == 0


def test_get_paper_by_any_id(web, ctx):
    for paper_id in ("openalex:W3027879771", "doi:10.48550/arxiv.2005.11401", "arxiv:2005.11401v4"):
        paper = run(server.get_paper(paper_id, ctx))
        assert paper.title.startswith("Retrieval-Augmented Generation") and paper.references_count == 59
    with pytest.raises(ToolError, match="Not a paper id"):
        run(server.get_paper("cats", ctx))


def test_new_arxiv_papers_come_from_arxiv(web, ctx):
    paper = run(server.get_paper("arxiv:2611.00001", ctx))
    assert paper.source == "arxiv" and paper.id == "arxiv:2611.00001"
    assert paper.title == "A Very New Paper on Paper Search"
    assert paper.abstract == "We search papers. It works."
    assert [a.name for a in paper.authors] == ["Ada Example", "Bo Sample"]
    assert paper.pdf_url == "https://arxiv.org/pdf/2611.00001" and paper.year == 2026
    with pytest.raises(ToolError, match="arXiv has no paper"):
        run(server.get_paper("arxiv:2611.99999", ctx))


def test_read_paper_pages_with_line_numbers_and_sections(web, ctx):
    first = run(server.read_paper("openalex:W3027879771", ctx, offset=1, limit=3))
    assert first.total_lines == len(PAPER_LINES)
    assert first.text.splitlines() == ["1  Retrieval-Augmented Generation", "2  Abstract", "3  We combine retrieval and generation."]
    assert first.next_offset == 4
    assert [(s.title, s.line) for s in first.sections] == [
        ("Abstract", 2), ("1 Introduction", 4), ("2 Methods", 6), ("References", 8),
    ]
    last = run(server.read_paper("openalex:W3027879771", ctx, offset=6, limit=50))
    assert last.next_offset is None and last.text.splitlines()[0] == "6  2 Methods"
    # Paging reads the PDF once.
    assert sum("arxiv.org/pdf" in url for url in web.asked) == 1
    with pytest.raises(ToolError, match="past the end"):
        run(server.read_paper("openalex:W3027879771", ctx, offset=99))


def test_read_paper_without_open_text(web, ctx):
    with pytest.raises(ToolError, match="no open-access full text"):
        run(server.read_paper("doi:10.1162/tacl_a_00276", ctx))
    web.pdf = b"<html>sign in</html>"
    with pytest.raises(ToolError, match="isn't a PDF"):
        run(server.read_paper("openalex:W3027879771", ctx))


def test_related_papers_rank_every_reference_not_just_the_first(web, ctx, monkeypatch):
    refs = [f"https://openalex.org/W{i}" for i in range(1, 151)]
    monkeypatch.setitem(RAG, "referenced_works", refs)
    answers = iter([
        {"results": [dict(NQ, id="https://openalex.org/W7", cited_by_count=10)]},
        {"results": [dict(NQ, id="https://openalex.org/W140", cited_by_count=900)]},
    ])
    real = web.get_json
    monkeypatch.setattr(net, "get_json", lambda url: next(answers) if "ids.openalex" in url else real(url))
    result = run(server.related_papers("openalex:W3027879771", ctx, kind="cites", limit=1))
    assert [p.id for p in result.results] == ["openalex:W140"]


def test_related_papers(web, ctx):
    for kind, expected in (("cites", "ids.openalex:W2963403868|W2896457183"), ("similar", "ids.openalex:W2963403868"),
                           ("cited_by", "cites:W3027879771")):
        result = run(server.related_papers("arxiv:2005.11401", ctx, kind=kind, limit=5))
        assert [p.id for p in result.results] == ["openalex:W2963403868"]
        assert urllib.parse.parse_qs(urllib.parse.urlparse(web.asked[-1]).query)["filter"] == [expected]


# --- saving -----------------------------------------------------------------------


@pytest.fixture
def storage_api(monkeypatch):
    """A stand-in for the chatroom's storage API that records the files written."""
    written: list[dict] = []

    class Handler(BaseHTTPRequestHandler):
        def do_PUT(self):
            parsed = urllib.parse.urlparse(self.path)
            body = self.rfile.read(int(self.headers["Content-Length"]))
            if self.headers.get(workspace.STORAGE_HEADER) != "alice-storage-token":
                self.send_response(401)
                self.end_headers()
                self.wfile.write(b'{"error": "Bad storage token"}')
                return
            written.append({
                "path": urllib.parse.unquote(parsed.path.removeprefix("/files/")),
                "query": urllib.parse.parse_qs(parsed.query, keep_blank_values=True),
                "type": self.headers["Content-Type"],
                "body": body,
            })
            self.send_response(201)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b"{}")

        def log_message(self, *args):
            pass

    httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    monkeypatch.setattr(server, "STORAGE_URL", f"http://127.0.0.1:{httpd.server_port}")
    yield written
    httpd.shutdown()


def test_save_paper_writes_a_note_at_the_root(web, ctx, storage_api):
    ctx.headers[workspace.STORAGE_HEADER] = "alice-storage-token"
    saved = run(server.save_paper("arxiv:2005.11401", ctx))
    assert saved.path == "papers/retrieval-augmented-generation-for-knowledge-intensive-nlp.md"
    assert not saved.proposed and saved.pdf_path is None
    [note] = storage_api
    assert note["path"] == saved.path and note["query"] == {} and note["type"] == "text/markdown"
    text = note["body"].decode()
    assert text.startswith('---\npaper: "openalex:W3027879771"\ntitle: "Retrieval-Augmented Generation')
    assert '"et al."' in text and "## Abstract\n\nLarge pre-trained" in text and "```bibtex\n@misc{" in text
    assert "[PDF](https://arxiv.org/pdf/2005.11401)" in text


def test_save_paper_in_a_node_is_a_proposal_and_in_an_experiment_is_not(web, ctx, storage_api):
    ctx.headers[workspace.STORAGE_HEADER] = "alice-storage-token"
    saved = run(server.save_paper("openalex:W3027879771", ctx, node="n1", include_pdf=True, path="lit/rag"))
    assert saved.proposed and saved.path == "lit/rag.md" and saved.pdf_path == "lit/rag.pdf"
    pdf, note = storage_api
    assert pdf["type"] == "application/pdf" and pdf["body"].startswith(b"%PDF")
    assert note["query"]["node"] == ["n1"] and "propose" in note["query"]
    body = note["body"].decode()
    assert "[PDF](https://arxiv.org/pdf/2005.11401)" in body and "PDF saved next to this note: `rag.pdf`" in body
    storage_api.clear()
    saved = run(server.save_paper("openalex:W3027879771", ctx, node="n1", experiment="e1"))
    assert not saved.proposed and storage_api[0]["query"] == {"node": ["n1"], "experiment": ["e1"]}


def test_save_paper_refusals(web, ctx, storage_api):
    with pytest.raises(ToolError, match="storageAccess"):
        run(server.save_paper("openalex:W3027879771", ctx))
    ctx.headers[workspace.STORAGE_HEADER] = "someone-elses-token"
    with pytest.raises(ToolError, match="401.*Bad storage token"):
        run(server.save_paper("openalex:W3027879771", ctx))
    ctx.headers[workspace.STORAGE_HEADER] = "alice-storage-token"
    with pytest.raises(ToolError, match="Not a workspace path"):
        run(server.save_paper("openalex:W3027879771", ctx, path="../outside"))
    with pytest.raises(ToolError, match="no open-access PDF"):
        run(server.save_paper("doi:10.1162/tacl_a_00276", ctx, include_pdf=True))
    assert storage_api == []


# --- the contract with the chat UI ------------------------------------------------


def test_tool_list_is_the_contract():
    tools = {tool.name: tool for tool in asyncio.run(server.mcp.list_tools())}
    assert set(tools) == {"search_papers", "get_paper", "read_paper", "related_papers", "save_paper"}
    assert all(tools[name].annotations.read_only_hint for name in tools if name != "save_paper")
    assert not tools["save_paper"].annotations.read_only_hint
    paper_fields = set(tools["search_papers"].output_schema["$defs"]["Paper"]["properties"])
    assert {"id", "title", "authors", "author_count", "year", "venue", "abstract", "url", "pdf_url", "doi",
            "citation_count", "open_access", "source"} <= paper_fields
    assert tools["search_papers"].input_schema["properties"]["limit"]["maximum"] == 25


def test_results_go_out_as_structured_content_and_json_text(web, monkeypatch):
    """Through the MCP protocol, as the chatroom's agent calls it."""
    monkeypatch.setattr(server, "PUBLIC_KEY", None)  # no login: the local user

    async def call():
        async with Client(server.mcp) as client:
            return await client.call_tool("search_papers", {"query": "rag", "limit": 2})

    result = asyncio.run(call())
    assert not result.is_error
    assert result.structured_content["results"][0]["id"] == "openalex:W3027879771"
    assert json.loads(result.content[0].text) == result.structured_content
