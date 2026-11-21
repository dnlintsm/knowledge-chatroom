import asyncio
import base64
import json
import threading
import urllib.error
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from mcp import Client
from mcp.server.mcpserver.exceptions import ToolError

from knowledge_chatroom import identity, storage
from papers_mcp import fulltext, models, net, openalex, server

FIXTURES = Path(__file__).parent / "fixtures"
RAG = json.loads((FIXTURES / "openalex_work_rag.json").read_text())
NQ = json.loads((FIXTURES / "openalex_work_nq.json").read_text())
SEARCH = json.loads((FIXTURES / "openalex_search.json").read_text())

# Signs test tokens as the chatroom's agent would (packages/contracts/src/identity-token.ts).
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
    out += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (
        len(objects) + 1,
        xref,
    )
    return out


PAPER_LINES = [
    "Retrieval-Augmented Generation",
    "Abstract",
    "We combine retrieval and generation.",
    "1 Introduction",
    "Models store knowledge.",
    "2 Methods",
    "We retrieve passages.",
    "References",
]


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
            return json.dumps(
                {
                    "results": [{"id": "https://openalex.org/A0"}]
                    if "lewis" in query["search"][0].lower()
                    else []
                }
            ).encode()
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
    monkeypatch.setattr(net, "get_public", fake.get)  # a paper's PDF link
    fulltext._cache.clear()
    return fake


@pytest.fixture
def ctx(monkeypatch):
    monkeypatch.setattr(server, "LOGIN", identity.Login(required=True, key=TEST_KEY.public_key()))
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
    assert models.parse_id("https://doi.org/10.1162/tacl_a_00276") == (
        "doi",
        "10.1162/tacl_a_00276",
    )
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
            "retrieval augmented generation",
            ctx,
            year_from=2019,
            year_to=2021,
            authors=["Patrick Lewis"],
            open_access_only=True,
            sort="citations",
            limit=2,
        )
    )
    assert [p.id for p in result.results] == ["openalex:W3027879771", "openalex:W2963403868"]
    assert result.total == 2 and result.next_cursor == "IlsxMDAuMCwgNDQ3M10i"
    works = urllib.parse.parse_qs(urllib.parse.urlparse(web.asked[-1]).query)
    assert works["search"] == ["retrieval augmented generation"]
    assert works["filter"] == [
        "from_publication_date:2019-01-01,to_publication_date:2021-12-31,authorships.author.id:A0,open_access.is_oa:true"
    ]
    assert (
        works["sort"] == ["cited_by_count:desc"]
        and works["per-page"] == ["2"]
        and works["cursor"] == ["*"]
    )
    # A last page has no cursor.
    assert run(server.search_papers("rag", ctx, limit=5)).next_cursor is None


def test_search_with_an_unknown_author_finds_nothing(web, ctx):
    result = run(server.search_papers("rag", ctx, authors=["Nobody Atall"]))
    assert result.results == [] and result.total == 0


def test_get_paper_by_any_id(web, ctx):
    for paper_id in ("openalex:W3027879771", "doi:10.48550/arxiv.2005.11401", "arxiv:2005.11401v4"):
        paper = run(server.get_paper(paper_id, ctx))
        assert (
            paper.title.startswith("Retrieval-Augmented Generation")
            and paper.references_count == 59
        )
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
    assert first.text.splitlines() == [
        "1  Retrieval-Augmented Generation",
        "2  Abstract",
        "3  We combine retrieval and generation.",
    ]
    assert first.next_offset == 4
    assert [(s.title, s.line) for s in first.sections] == [
        ("Abstract", 2),
        ("1 Introduction", 4),
        ("2 Methods", 6),
        ("References", 8),
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
    answers = iter(
        [
            {"results": [dict(NQ, id="https://openalex.org/W7", cited_by_count=10)]},
            {"results": [dict(NQ, id="https://openalex.org/W140", cited_by_count=900)]},
        ]
    )
    real = web.get_json
    monkeypatch.setattr(
        net, "get_json", lambda url: next(answers) if "ids.openalex" in url else real(url)
    )
    result = run(server.related_papers("openalex:W3027879771", ctx, kind="cites", limit=1))
    assert [p.id for p in result.results] == ["openalex:W140"]


def test_related_papers(web, ctx):
    for kind, expected in (
        ("cites", "ids.openalex:W2963403868|W2896457183"),
        ("similar", "ids.openalex:W2963403868"),
        ("cited_by", "cites:W3027879771"),
    ):
        result = run(server.related_papers("arxiv:2005.11401", ctx, kind=kind, limit=5))
        assert [p.id for p in result.results] == ["openalex:W2963403868"]
        assert urllib.parse.parse_qs(urllib.parse.urlparse(web.asked[-1]).query)["filter"] == [
            expected
        ]


# --- saving -----------------------------------------------------------------------


@pytest.fixture
def storage_api(monkeypatch):
    """A stand-in for the chatroom's storage API that records the files written."""
    written: list[dict] = []

    class Handler(BaseHTTPRequestHandler):
        def do_PUT(self):
            parsed = urllib.parse.urlparse(self.path)
            body = self.rfile.read(int(self.headers["Content-Length"]))
            if self.headers.get(storage.STORAGE_HEADER) != "alice-storage-token":
                self.send_response(401)
                self.end_headers()
                self.wfile.write(b'{"error": "Bad storage token"}')
                return
            written.append(
                {
                    "path": urllib.parse.unquote(parsed.path.removeprefix("/files/")),
                    "query": urllib.parse.parse_qs(parsed.query, keep_blank_values=True),
                    "type": self.headers["Content-Type"],
                    "body": body,
                }
            )
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
    ctx.headers[storage.STORAGE_HEADER] = "alice-storage-token"
    saved = run(server.save_paper("arxiv:2005.11401", ctx))
    assert saved.path == "papers/retrieval-augmented-generation-for-knowledge-intensive-nlp.md"
    assert not saved.proposed and saved.pdf_path is None
    [note] = storage_api
    assert note["path"] == saved.path and note["query"] == {} and note["type"] == "text/markdown"
    text = note["body"].decode()
    assert text.startswith(
        '---\npaper: "openalex:W3027879771"\ntitle: "Retrieval-Augmented Generation'
    )
    assert (
        '"et al."' in text
        and "## Abstract\n\nLarge pre-trained" in text
        and "```bibtex\n@misc{" in text
    )
    assert "[PDF](https://arxiv.org/pdf/2005.11401)" in text


def test_save_paper_in_a_node_is_a_proposal_and_in_an_experiment_is_not(web, ctx, storage_api):
    ctx.headers[storage.STORAGE_HEADER] = "alice-storage-token"
    saved = run(
        server.save_paper("openalex:W3027879771", ctx, node="n1", include_pdf=True, path="lit/rag")
    )
    assert saved.proposed and saved.path == "lit/rag.md" and saved.pdf_path == "lit/rag.pdf"
    pdf, note = storage_api
    assert pdf["type"] == "application/pdf" and pdf["body"].startswith(b"%PDF")
    assert note["query"]["node"] == ["n1"] and "propose" in note["query"]
    body = note["body"].decode()
    assert (
        "[PDF](https://arxiv.org/pdf/2005.11401)" in body
        and "PDF saved next to this note: `rag.pdf`" in body
    )
    storage_api.clear()
    saved = run(server.save_paper("openalex:W3027879771", ctx, node="n1", experiment="e1"))
    assert not saved.proposed and storage_api[0]["query"] == {"node": ["n1"], "experiment": ["e1"]}


def test_save_paper_refusals(web, ctx, storage_api):
    with pytest.raises(ToolError, match="storageAccess"):
        run(server.save_paper("openalex:W3027879771", ctx))
    ctx.headers[storage.STORAGE_HEADER] = "someone-elses-token"
    with pytest.raises(ToolError, match="401.*Bad storage token"):
        run(server.save_paper("openalex:W3027879771", ctx))
    ctx.headers[storage.STORAGE_HEADER] = "alice-storage-token"
    with pytest.raises(ToolError, match="Not a workspace path"):
        run(server.save_paper("openalex:W3027879771", ctx, path="../outside"))
    with pytest.raises(ToolError, match="no open-access PDF"):
        run(server.save_paper("doi:10.1162/tacl_a_00276", ctx, include_pdf=True))
    assert storage_api == []


# --- the contract with the chat UI ------------------------------------------------


def test_tool_list_is_the_contract():
    tools = {tool.name: tool for tool in asyncio.run(server.mcp.list_tools())}
    assert set(tools) == {
        "search_papers",
        "get_paper",
        "read_paper",
        "related_papers",
        "save_paper",
    }
    assert all(tools[name].annotations.read_only_hint for name in tools if name != "save_paper")
    assert not tools["save_paper"].annotations.read_only_hint
    paper_fields = set(tools["search_papers"].output_schema["$defs"]["Paper"]["properties"])
    assert {
        "id",
        "title",
        "authors",
        "author_count",
        "year",
        "venue",
        "abstract",
        "url",
        "pdf_url",
        "doi",
        "citation_count",
        "open_access",
        "source",
    } <= paper_fields
    assert tools["search_papers"].input_schema["properties"]["limit"]["maximum"] == 25


def test_results_go_out_as_structured_content_and_json_text(web, monkeypatch):
    """Through the MCP protocol, as the chatroom's agent calls it."""
    monkeypatch.setattr(server, "LOGIN", identity.Login(required=False))  # no login: the local user

    async def call():
        async with Client(server.mcp) as client:
            return await client.call_tool("search_papers", {"query": "rag", "limit": 2})

    result = asyncio.run(call())
    assert not result.is_error
    assert result.structured_content["results"][0]["id"] == "openalex:W3027879771"
    assert json.loads(result.content[0].text) == result.structured_content


def test_errors_leave_the_openalex_key_and_address_out(monkeypatch):
    """Error messages reach Claude and the chat, so they name the URL without them."""
    monkeypatch.setenv("OPENALEX_API_KEY", "secret-key")
    monkeypatch.setenv("OPENALEX_MAILTO", "ops@example.com")
    url = openalex._url("/works/doi:10.1/x", {"select": "id,title"})
    assert "secret-key" in url and "ops%40example.com" in url  # still sent to the source

    def refuse(code: int):
        def urlopen(request, timeout=None):
            raise urllib.error.HTTPError(request.full_url, code, "", None, None)

        return urlopen

    def unreachable(request, timeout=None):
        raise urllib.error.URLError("no route")

    for urlopen in (refuse(404), refuse(500), unreachable):
        monkeypatch.setattr(net.urllib.request, "urlopen", urlopen)
        with pytest.raises(net.SourceError) as caught:
            net.get(url)
        message = str(caught.value)
        assert "secret-key" not in message and "ops" not in message
        assert "https://api.openalex.org/works/doi:10.1/x?select=id,title" in message

    # A URL with nothing private is shown as it was asked.
    assert (
        net.shown("https://arxiv.org/pdf/2005.11401?v=1") == "https://arxiv.org/pdf/2005.11401?v=1"
    )


def addresses(*ips: str):
    """A resolver answering every name with these addresses."""

    def getaddrinfo(host, port, *args, **kwargs):
        return [(None, None, None, "", (ip, port)) for ip in ips]

    return getaddrinfo


def test_a_link_from_a_source_is_only_followed_to_public_https(monkeypatch):
    """Issue #289: a paper's pdf_url is whatever the source's answer says."""
    for bad in (
        "file:///etc/passwd",
        "ftp://example.org/a.pdf",
        "http://example.org/a.pdf",
        "https://127.0.0.1/a.pdf",
        "https://10.0.0.8/a.pdf",
        "https://169.254.169.254/latest/meta-data/",
        "https://[::1]/a.pdf",
        "https://[::ffff:192.168.1.5]/a.pdf",
        "https://localhost/a.pdf",
        "https://db.internal/a.pdf",
        "https:///a.pdf",
    ):
        with pytest.raises(net.SourceError):
            net.check_public(bad)
    assert net.check_public("https://arxiv.org/pdf/2005.11401").hostname == "arxiv.org"
    assert net.check_public("https://8.8.8.8/a.pdf").hostname == "8.8.8.8"

    # A public-looking name is refused where it resolves, if any address is inside.
    monkeypatch.setattr(net.socket, "getaddrinfo", addresses("93.184.216.34"))
    assert net.public_address("papers.example.org", 443) == ("93.184.216.34", 443)
    for inside in (("10.1.2.3",), ("93.184.216.34", "192.168.0.9"), ("100.64.0.1",), ()):
        monkeypatch.setattr(net.socket, "getaddrinfo", addresses(*inside))
        with pytest.raises(net.SourceError, match="inside the network"):
            net.public_address("papers.example.org", 443)


def test_every_redirect_of_a_fetched_link_is_checked(monkeypatch):
    class Answer:
        def __init__(self, body: bytes):
            self.body = body

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def read(self, n: int) -> bytes:
            return self.body[:n]

    def redirect(to: str) -> urllib.error.HTTPError:
        return urllib.error.HTTPError("https://x", 302, "Found", {"Location": to}, None)  # type: ignore[arg-type]

    def web_of(pages: dict):
        asked: list[str] = []

        def open_public(url: str, accept: str):
            asked.append(url)
            answer = pages[url]
            if isinstance(answer, Exception):
                raise answer
            return Answer(answer)

        monkeypatch.setattr(net, "_open_public", open_public)
        return asked

    # Followed while each hop is public https, relative ones included.
    asked = web_of(
        {
            "https://doi.example.org/10.1/x": redirect("https://publisher.example.org/a"),
            "https://publisher.example.org/a": redirect("/files/a.pdf"),
            "https://publisher.example.org/files/a.pdf": b"%PDF-1.7 ...",
        }
    )
    got = net.get_public("https://doi.example.org/10.1/x", max_bytes=1_000)
    assert got.startswith(b"%PDF") and len(asked) == 3

    # A hop that leaves https, or goes inside, ends it before anything is fetched there.
    for inside in (
        "http://publisher.example.org/a.pdf",
        "https://169.254.169.254/a",
        "file:///etc/hosts",
    ):
        asked = web_of({"https://doi.example.org/10.1/x": redirect(inside)})
        with pytest.raises(net.SourceError):
            net.get_public("https://doi.example.org/10.1/x", max_bytes=1_000)
        assert asked == ["https://doi.example.org/10.1/x"]

    # No endless chains, and no body larger than asked for.
    web_of({"https://a.example.org/": redirect("https://a.example.org/")})
    with pytest.raises(net.SourceError, match="redirects too many times"):
        net.get_public("https://a.example.org/", max_bytes=1_000)
    web_of({"https://a.example.org/big.pdf": b"x" * 2_000_001})
    with pytest.raises(net.SourceError, match="larger than 2 MB"):
        net.get_public("https://a.example.org/big.pdf", max_bytes=2_000_000)


def test_a_pdf_is_read_up_to_a_page_limit(monkeypatch):
    monkeypatch.setattr(fulltext, "MAX_PDF_PAGES", 1)
    lines = fulltext.pdf_lines(tiny_pdf(PAPER_LINES))
    assert lines and lines == fulltext.pdf_lines(tiny_pdf(PAPER_LINES))


def test_a_fetched_link_connects_to_the_address_that_was_checked(monkeypatch, tmp_path):
    """
    The real connection, against a local TLS server: the request goes to the
    address public_address() approved, and the certificate is still checked
    against the link's name.
    """
    import datetime
    import ssl

    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.x509.oid import NameOID

    key = ec.generate_private_key(ec.SECP256R1())
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "papers.test")])
    now = datetime.datetime.now(datetime.UTC)
    cert = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(minutes=5))
        .not_valid_after(now + datetime.timedelta(hours=1))
        .add_extension(x509.SubjectAlternativeName([x509.DNSName("papers.test")]), critical=False)
        .add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True)
        .sign(key, hashes.SHA256())
    )
    cert_file, key_file = tmp_path / "cert.pem", tmp_path / "key.pem"
    cert_file.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    key_file.write_bytes(
        key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        )
    )

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path == "/moved":
                self.send_response(302)
                self.send_header("Location", "/a.pdf")
                self.end_headers()
                return
            body = b"%PDF-1.7 for " + self.headers["Host"].encode()
            self.send_response(200)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args):
            pass

    httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    serving = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    serving.load_cert_chain(cert_file, key_file)
    httpd.socket = serving.wrap_socket(httpd.socket, server_side=True)
    port = httpd.server_port
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    try:
        approved: list[str] = []

        def approve(host: str, port_: int) -> tuple[str, int]:
            approved.append(host)
            return "127.0.0.1", port_

        # No proxy for this name, the name "resolves" to the local server, and its certificate is trusted.
        monkeypatch.setenv("NO_PROXY", "papers.test")
        monkeypatch.setenv("no_proxy", "papers.test")
        monkeypatch.setattr(net, "public_address", approve)
        monkeypatch.setattr(net, "_TLS", ssl.create_default_context(cafile=str(cert_file)))
        got = net.get_public(f"https://papers.test:{port}/moved", max_bytes=1_000)
        assert got == f"%PDF-1.7 for papers.test:{port}".encode()
        assert approved == ["papers.test", "papers.test"]  # once per hop

        # Another name at the same address: the certificate doesn't cover it.
        monkeypatch.setenv("NO_PROXY", "papers.test,other.test")
        monkeypatch.setenv("no_proxy", "papers.test,other.test")
        with pytest.raises(net.SourceError, match="Couldn't reach"):
            net.get_public(f"https://other.test:{port}/a.pdf", max_bytes=1_000)

        # A name that resolves inside the network is refused at the connection.
        monkeypatch.undo()
        monkeypatch.setenv("NO_PROXY", "papers.test")
        monkeypatch.setenv("no_proxy", "papers.test")
        monkeypatch.setattr(net.socket, "getaddrinfo", addresses("127.0.0.1"))
        with pytest.raises(net.SourceError, match="inside the network"):
            net.get_public(f"https://papers.test:{port}/a.pdf", max_bytes=1_000)
    finally:
        httpd.shutdown()
