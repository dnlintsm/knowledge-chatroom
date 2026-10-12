---
name: tldr
description: Summarize the open file (or the user's selection) as a TL;DR line plus a few bullets. Use when the user asks for a summary, gist or recap of a document.
argument-hint: "[what to focus on]"
---

# TL;DR

1. Work on the user's selection if there is one, otherwise the open file
   (both arrive as context). If neither is there, ask which file they mean.
2. Reply with:
   - one bold **TL;DR:** line of at most 25 words;
   - 3 to 5 bullets with the points a reader needs, most important first;
   - if the user gave a focus after the command, lead with that.
3. Cite lines you rely on as file references, e.g. [notes.md:12](notes/notes.md#L12).
4. Don't write a file unless the user asks; then put it under artifacts/.
