#!/usr/bin/env node
/**
 * Profiles a CSV (or TSV) file for the analysis skill: per column, how many
 * values and missing ones, and for numeric columns min, max, mean and
 * standard deviation, else the most common values. Prints JSON.
 *
 *   node profile.mjs <file.csv> [--top 5]
 *
 * Plain Node, no packages, so it runs in the skill sandbox as is.
 */

import { readFileSync } from "node:fs";

/** Rows of a CSV/TSV text, with "quoted, fields" and "" escapes. */
export function parseDelimited(text, delimiter = text.split("\n", 1)[0].includes("\t") ? "\t" : ",") {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
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
      }
    } else if (c === '"' && field === "") {
      quoted = true;
    } else if (c === delimiter) {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      if (row.some((f) => f !== "")) rows.push(row);
      row = [];
      field = "";
    } else {
      field += c;
    }
  }
  row.push(field);
  if (row.some((f) => f !== "")) rows.push(row);
  return rows;
}

const MISSING = new Set(["", "na", "n/a", "nan", "null", "none", "-"]);

export function profile(text, top = 5) {
  const [header = [], ...rows] = parseDelimited(text.replace(/^﻿/, ""));
  const columns = header.map((name, c) => {
    const values = rows.map((r) => (r[c] ?? "").trim());
    const present = values.filter((v) => !MISSING.has(v.toLowerCase()));
    const numbers = present.map(Number).filter((n) => Number.isFinite(n));
    const out = { name, count: present.length, missing: values.length - present.length };
    if (present.length && numbers.length === present.length) {
      const mean = numbers.reduce((a, b) => a + b, 0) / numbers.length;
      const variance =
        numbers.length > 1 ? numbers.reduce((a, b) => a + (b - mean) ** 2, 0) / (numbers.length - 1) : 0;
      return {
        ...out,
        type: "number",
        min: Math.min(...numbers),
        max: Math.max(...numbers),
        mean: round(mean),
        std: round(Math.sqrt(variance)),
      };
    }
    const counts = new Map();
    for (const v of present) counts.set(v, (counts.get(v) ?? 0) + 1);
    const common = [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, top);
    return { ...out, type: "text", distinct: counts.size, top: common.map(([value, n]) => ({ value, n })) };
  });
  return { rows: rows.length, columns };
}

const round = (n) => Math.round(n * 1e6) / 1e6;

if (import.meta.url === `file://${process.argv[1]}`) {
  const [file, ...rest] = process.argv.slice(2);
  if (!file) {
    console.error("usage: node profile.mjs <file.csv> [--top 5]");
    process.exit(2);
  }
  const at = rest.indexOf("--top");
  const top = at >= 0 ? Number(rest[at + 1]) || 5 : 5;
  console.log(JSON.stringify({ file, ...profile(readFileSync(file, "utf8"), top) }, null, 2));
}
