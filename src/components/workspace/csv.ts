import type { LineRange } from "./file-refs";

export interface CsvRow {
  cells: string[];
  /** Source lines the row spans; more than one when a quoted field holds a newline. */
  lines: LineRange;
}

/**
 * RFC 4180 CSV: quoted fields may hold commas, newlines and doubled quotes
 * (`""`). Blank lines are skipped.
 */
export function parseCsv(text: string): CsvRow[] {
  const rows: CsvRow[] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let line = 1;
  let start = 1;
  const endRow = () => {
    row.push(field);
    if (row.length > 1 || row[0] !== "") rows.push({ cells: row, lines: { start, end: line } });
    row = [];
    field = "";
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') {
        quoted = false;
      } else {
        field += c;
        if (c === "\n" || (c === "\r" && text[i + 1] !== "\n")) line++;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      endRow();
      start = ++line;
    } else {
      field += c;
    }
  }
  if (field !== "" || row.length) endRow();
  return rows;
}
