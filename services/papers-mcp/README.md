# Paper search MCP server

An MCP server that lets Claude in the chatroom search academic papers, read
them and save them into the workspace (issue #151). It searches
[OpenAlex](https://openalex.org) (about 250 million works, arXiv included) and
falls back to the [arXiv API](https://info.arxiv.org/help/api/) for preprints
too new for OpenAlex. Neither needs a key.

This server is the demo source. For real use, put your own paper search behind
the same five tools (below) and point `MCP_SERVERS` at it instead: the chat's
paper cards and buttons only depend on the tool names and result shapes. A
Python chat backend (`AGENT_URL`) connects to the same server as `papers`; see
docs/remote-agent.md, step 8.

## Run it

1. Start the server (Python 3.10+ and [uv](https://docs.astral.sh/uv/)), from the
   repository root:

   ```bash
   uv sync --package papers-mcp
   cd services/papers-mcp
   uv run python -m papers_mcp.server   # http://127.0.0.1:9200/mcp
   ```

2. Connect the agent to it in the repository's `.env`, then restart the agent:

   ```bash
   MCP_SERVERS={"mcpServers":{"papers":{"url":"http://127.0.0.1:9200/mcp","forwardIdentity":true,"storageAccess":true,"ui":{"label":"Search papers","chip":"Papers","icon":"book-open","tools":["search_papers","get_paper","save_paper"]}}}}
   ```

   Claude sees the tools as `mcp__papers__<tool>`. The `ui` block puts **Search papers**
   in the chat's "+" menu, and lets the paper cards' Save button call `save_paper`
   (docs/development.md, "Outside MCP servers"). If you already have servers in
   `MCP_SERVERS`, add `papers` next to them.

3. In the chat, pick "+" → **Search papers** (a "Papers" chip appears), then ask:
   *"Find recent papers on retrieval-augmented generation."* The results show as cards
   with *Save to workspace*, *Ask about this*, *PDF* and *Page*. The built-in
   `paper-search` skill (`/paper-search`) gives Claude the same steps without the chip.

With Docker, the `papers` profile runs the server next to the demo. Use the
service name in `.env`:

```bash
MCP_SERVERS={"mcpServers":{"papers":{"url":"http://papers:9200/mcp","forwardIdentity":true,"storageAccess":true,"ui":{"label":"Search papers","chip":"Papers","icon":"book-open","tools":["search_papers","get_paper","save_paper"]}}}}
docker compose --profile demo --profile papers up --build
```

| Variable | Meaning |
| --- | --- |
| `PAPERS_HOST`, `PAPERS_PORT` | Where it listens (default `127.0.0.1:9200`). |
| `PAPERS_NAME` | Its name in `MCP_SERVERS` (default `papers`). Forwarded users are signed for that name. |
| `KNOWLEDGE_PUBLIC_KEY` | The chatroom's public key, from the agent's `GET /identity/public-key`, when login is on. Never give this server `AUTH_SECRET`. Unset = no login: every call is the local user. |
| `KNOWLEDGE_STORAGE_URL` | The chatroom's agent server, where `save_paper` writes (default `http://127.0.0.1:8000`). |
| `OPENALEX_API_KEY`, `OPENALEX_MAILTO` | Optional. A key raises OpenAlex's daily budget; an email joins its "polite pool". |
| `PAPERS_MAX_PDF_BYTES` | Largest PDF `read_paper` and `save_paper` download (default 30 MB). |

## The tools

These are the contract. The shapes are in [`papers_mcp/models.py`](papers_mcp/models.py),
and each tool returns them as MCP structured content and as the same JSON in a text block.

| Tool | Arguments | Returns |
| --- | --- | --- |
| `search_papers` | `query`; optional `year_from`, `year_to`, `authors` (names, all must match), `venue`, `open_access_only`, `sort` (`relevance` \| `recent` \| `citations`), `limit` (1–25, default 8), `cursor` | `{query, results: Paper[], total, next_cursor}`, abstracts cut to 600 characters |
| `get_paper` | `id` | `Paper` with the whole abstract, `references_count` and `bibtex` |
| `read_paper` | `id`; `offset` (default 1), `limit` (lines, default 300, max 1000) | `{id, title, text, offset, next_offset, total_lines, sections: [{title, line}]}` from the open-access PDF, lines numbered |
| `related_papers` | `id`; `kind` (`cites` \| `cited_by` \| `similar`, default `similar`); `limit` | like `search_papers` |
| `save_paper` | `id`; optional `path` (default `papers/<title>.md`), `node`, `experiment`, `include_pdf` | `{path, node, experiment, pdf_path, proposed, note}` |

A `Paper` is `{id, title, authors: [{name, id}], author_count, year, published, venue,
abstract, url, pdf_url, doi, arxiv_id, citation_count, open_access, source}`.
Paper ids look like `openalex:W3027879771`, `doi:10.1162/tacl_a_00276` or
`arxiv:2005.11401`, and every tool takes any of the three.

`save_paper` writes a markdown note: front matter (`paper`, `title`, `authors`, `year`,
`venue`, `doi`, `arxiv`, `url`, `pdf`, `citations`, `saved`), then the abstract,
BibTeX and an empty Notes section. The chatroom's search then finds it like any
other file. In a knowledge node the note is a proposal that an editor of the
node accepts, as with all of Claude's writes there. Saving the same paper again
updates its note, which keeps the earlier version in the file's history.

## Login and the forwarded user

As in [`../python-agent`](../python-agent/README.md#login-and-the-forwarded-user):
with login on, the agent sends each run's user as an `X-Knowledge-User` token
signed for `mcp:papers`, and `require_user()` refuses calls without one. With
`"storageAccess": true` it also sends an `X-Knowledge-Storage` token, which
`save_paper` passes on to the storage API unchanged, so it can only save where
the user can. Both checks come from `knowledge_chatroom` (`packages/knowledge-py`), which
every Python service in `services/` shares.

## Tests

```bash
uv sync --all-packages        # from the repository root
cd services/papers-mcp
uv run pytest -q
```

The tests answer OpenAlex and arXiv from recorded responses in `tests/fixtures`, so
they run offline.
