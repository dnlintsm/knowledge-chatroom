import { diffLines } from "diff";

/**
 * Line diffs for reviewing proposed versions (review-panel.tsx): what
 * accepting a proposal would change in a file, as it is now.
 */

/** Unchanged lines shown around each change; longer runs fold. */
const CONTEXT_LINES = 3;

export type DiffRow =
  | { type: "same" | "added" | "removed"; text: string; old: number | null; new: number | null }
  | { type: "fold"; count: number };

/** Line rows of the change from `before` to `after`, with long unchanged runs folded. */
export function diffRows(before: string, after: string): DiffRow[] {
  const rows: DiffRow[] = [];
  let oldLine = 1;
  let newLine = 1;
  for (const part of diffLines(before, after)) {
    if (!part.value) continue;
    const lines = part.value.replace(/\n$/, "").split("\n");
    for (const line of lines) {
      if (part.added) rows.push({ type: "added", text: line, old: null, new: newLine++ });
      else if (part.removed) rows.push({ type: "removed", text: line, old: oldLine++, new: null });
      else rows.push({ type: "same", text: line, old: oldLine++, new: newLine++ });
    }
  }
  // Keep CONTEXT_LINES of unchanged lines next to each change.
  const near = rows.map((r) => r.type !== "same");
  const keep = rows.map((_, i) =>
    near.slice(Math.max(0, i - CONTEXT_LINES), i + CONTEXT_LINES + 1).some(Boolean),
  );
  const out: DiffRow[] = [];
  for (let i = 0; i < rows.length; ) {
    if (keep[i]) {
      out.push(rows[i++]);
      continue;
    }
    let j = i;
    while (j < rows.length && !keep[j]) j++;
    out.push({ type: "fold", count: j - i });
    i = j;
  }
  return out;
}
