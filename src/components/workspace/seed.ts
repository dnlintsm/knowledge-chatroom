import type { WorkspaceFile } from "./types";

/** Sample files shown on first visit, so every section has something in it. */
const t = Date.UTC(2026, 9, 6);

export const SEED_FILES: WorkspaceFile[] = [
  {
    path: "notes/welcome.md",
    kind: "note",
    mime: "text/markdown",
    author: "user",
    updatedAt: t,
    content: `# Welcome to Knowledge Chatroom

This is your personal knowledge container.

- **Left:** your notes, skills, uploads and anything Claude generates.
- **Middle:** preview or edit the open file. Markdown has a *Preview / Edit* toggle.
- **Right:** chat with Claude. It can see the file you have open (and any text
  you select), and it can read, create and edit files here.

## Try it

1. Select a paragraph and ask Claude to rewrite it.
2. Ask Claude to *"summarize all my notes into artifacts/summary.md"*.
3. Drop a file onto the left pane to upload it.
`,
  },
  {
    path: "notes/reading-list.md",
    kind: "note",
    mime: "text/markdown",
    author: "user",
    updatedAt: t,
    content: `# Reading list

| Title | Topic | Status |
| --- | --- | --- |
| Designing Data-Intensive Applications | Systems | Reading |
| How to Take Smart Notes | Knowledge work | Done |
| The Pragmatic Programmer | Craft | Next |

> Ask Claude: "Which of these should I read next, and why?"
`,
  },
  {
    path: "skills/summarize/SKILL.md",
    kind: "skill",
    mime: "text/markdown",
    author: "user",
    updatedAt: t,
    content: `---
name: summarize
description: Summarize one or more workspace files into a short brief.
---

# Summarize

1. Read every file the user names (or the open file).
2. Write a brief with a one-line TL;DR, then up to five bullets.
3. Save it under \`artifacts/\` and open it.
`,
  },
  {
    path: "uploads/sales.csv",
    kind: "upload",
    mime: "text/csv",
    author: "user",
    updatedAt: t,
    content: `month,revenue,new_customers
2026-07,42000,118
2026-08,45500,131
2026-09,51200,149
`,
  },
];

export const DEFAULT_OPEN = "notes/welcome.md";
