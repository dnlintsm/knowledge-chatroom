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
  {
    path: "runs/etch-2026-10-01/xdoe-report/report.md",
    kind: "note",
    mime: "text/markdown",
    author: "user",
    updatedAt: t,
    content: `# xDOE report: etch rate vs. RF power and pressure

Run \`etch-2026-10-01\`, 2-factor full factorial with a center point, 3 replicates.

## Factors

| Factor | Low | Center | High |
| --- | --- | --- | --- |
| RF power (W) | 300 | 400 | 500 |
| Chamber pressure (mTorr) | 20 | 30 | 40 |

## Results

| Power (W) | Pressure (mTorr) | Etch rate (nm/min) | Uniformity (%) |
| --- | --- | --- | --- |
| 300 | 20 | 118 | 3.1 |
| 500 | 20 | 171 | 4.4 |
| 300 | 40 | 104 | 2.6 |
| 500 | 40 | 149 | 3.8 |
| 400 | 30 | 139 | 3.2 |

## Findings

- RF power dominates etch rate (+26 nm/min per 100 W).
- Higher pressure lowers the rate but improves uniformity.
- No significant interaction at the 95% level.
`,
  },
  {
    path: "runs/etch-2026-10-01/xdoe-report/effects.csv",
    kind: "note",
    mime: "text/csv",
    author: "user",
    updatedAt: t,
    content: `term,effect,p_value
power,49.0,0.001
pressure,-18.0,0.012
power:pressure,-4.0,0.41
`,
  },
  {
    path: "runs/litho-2026-10-03/xdoe-report/report.md",
    kind: "note",
    mime: "text/markdown",
    author: "user",
    updatedAt: t,
    content: `# xDOE report: CD vs. dose and focus

Run \`litho-2026-10-03\`, 3×3 dose/focus matrix.

| Dose (mJ/cm²) | Focus (µm) | CD (nm) |
| --- | --- | --- |
| 28 | -0.1 | 47.2 |
| 30 | 0.0 | 45.0 |
| 32 | +0.1 | 43.1 |

Best focus is 0.0 µm; CD falls about 1 nm per mJ/cm² of dose.
`,
  },
];

export const DEFAULT_OPEN = "notes/welcome.md";
