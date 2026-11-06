---
name: paper-search
description: Find, read and cite academic papers with the paper search tools (mcp__papers__*). Use when the user asks for papers, prior work, related work, a literature review, or evidence from published research.
argument-hint: "[topic or question]"
---

# Paper search

You have paper search when tools named `mcp__papers__…` (or another server's
`search_papers`) are available. Without them, say that paper search isn't set
up here (an administrator adds the papers server to `MCP_SERVERS`) and stop;
never answer from memory as if you had searched.

1. **Search.** Call `search_papers` with the user's topic in a few plain words.
   Narrow with `year_from`, `authors`, `venue` or `open_access_only` when the
   user asks for it; use `sort: "recent"` for "latest" and `"citations"` for
   "key" or "most cited". Keep `limit` small (5 to 10). The results show in
   the chat as cards, so don't list every paper again.
2. **Answer.** In a few sentences, say which papers answer the question and
   why, citing each as a markdown link to its `url`: [Title (Year)](url).
   Only cite papers a tool returned. Give no numbers, claims or quotes a
   tool's text doesn't show.
3. **Go deeper only when needed.** For one paper's details or BibTeX, call
   `get_paper`. To check a method or a result, call `read_paper`: look at
   `sections` first, then read just that part with `offset` and `limit`.
   For more of the same kind, use `related_papers` (`similar`, `cites`,
   `cited_by`) or `search_papers` with `next_cursor`.
4. **Save on request.** When the user asks to keep papers, call `save_paper`
   with the user's place (`node` = currentNode id, `experiment` =
   currentExperiment id). Saved notes land under `papers/`; link the saved
   file, e.g. [rag.md](papers/rag.md). In a knowledge node the save is a
   proposal an editor accepts; say so. Ask before saving more than 5 papers.
