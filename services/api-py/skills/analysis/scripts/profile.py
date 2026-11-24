#!/usr/bin/env python3
"""Profiles a CSV (or TSV) file for the analysis skill.

Per column: how many values and missing ones, and for numeric columns min,
max, mean and standard deviation, else the most common values. Prints JSON.

    python3 profile.py <file.csv> [--top 5]

Plain Python 3, standard library only, so it runs in the skill sandbox as is.
"""

from __future__ import annotations

import json
import math
import re
import sys
from collections import Counter
from typing import Any

MISSING = {"", "na", "n/a", "nan", "null", "none", "-"}
# What counts as a number: decimals with an optional exponent, and 0x/0o/0b
# integers. Not Python's own extras such as "1_000", "inf" or "nan".
_DECIMAL = re.compile(r"[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?")
_BASED = re.compile(r"0([xX][0-9a-fA-F]+|[oO][0-7]+|[bB][01]+)")


def parse_delimited(text: str, delimiter: str | None = None) -> list[list[str]]:
    """Rows of a CSV/TSV text, with "quoted, fields" and "" escapes; blank rows left out."""
    if delimiter is None:
        delimiter = "\t" if "\t" in text.split("\n", 1)[0] else ","
    rows: list[list[str]] = []
    row: list[str] = []
    field: list[str] = []
    quoted = False
    i, n = 0, len(text)
    while i < n:
        c = text[i]
        if quoted:
            if c == '"' and i + 1 < n and text[i + 1] == '"':
                field.append('"')
                i += 1
            elif c == '"':
                quoted = False
            else:
                field.append(c)
        elif c == '"' and not field:
            quoted = True
        elif c == delimiter:
            row.append("".join(field))
            field = []
        elif c in "\r\n":
            if c == "\r" and i + 1 < n and text[i + 1] == "\n":
                i += 1
            row.append("".join(field))
            if any(row):
                rows.append(row)
            row, field = [], []
        else:
            field.append(c)
        i += 1
    row.append("".join(field))
    if any(row):
        rows.append(row)
    return rows


def number(value: str) -> float | None:
    """The value as a finite number, or None."""
    if _DECIMAL.fullmatch(value):
        parsed = float(value)
    elif _BASED.fullmatch(value):
        parsed = float(int(value, 0))
    else:
        return None
    return parsed if math.isfinite(parsed) else None


def _round(x: float) -> float:
    # Half up, to six places.
    return math.floor(x * 1e6 + 0.5) / 1e6


def _plain(x: float) -> float | int:
    # 30, not 30.0, in the JSON.
    return int(x) if x.is_integer() else x


def profile(text: str, top: int = 5) -> dict[str, Any]:
    rows = parse_delimited(text.removeprefix("﻿"))
    header, rows = (rows[0], rows[1:]) if rows else ([], [])
    columns: list[dict[str, Any]] = []
    for c, name in enumerate(header):
        values = [(r[c] if c < len(r) else "").strip() for r in rows]
        present = [v for v in values if v.lower() not in MISSING]
        out: dict[str, Any] = {
            "name": name,
            "count": len(present),
            "missing": len(values) - len(present),
        }
        numbers = [x for x in map(number, present) if x is not None]
        if present and len(numbers) == len(present):
            mean = math.fsum(numbers) / len(numbers)
            variance = (
                math.fsum((x - mean) ** 2 for x in numbers) / (len(numbers) - 1)
                if len(numbers) > 1
                else 0.0
            )
            out.update(
                type="number",
                min=_plain(min(numbers)),
                max=_plain(max(numbers)),
                mean=_plain(_round(mean)),
                std=_plain(_round(math.sqrt(variance))),
            )
        else:
            counts = Counter(present)
            common = sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))[:top]
            out.update(
                type="text",
                distinct=len(counts),
                top=[{"value": value, "n": count} for value, count in common],
            )
        columns.append(out)
    return {"rows": len(rows), "columns": columns}


def main(argv: list[str]) -> int:
    if not argv:
        print("usage: python3 profile.py <file.csv> [--top 5]", file=sys.stderr)
        return 2
    file, rest = argv[0], argv[1:]
    top = 5
    if "--top" in rest:
        at = rest.index("--top")
        try:
            top = int(rest[at + 1]) or 5
        except (IndexError, ValueError):
            top = 5
    with open(file, encoding="utf-8") as f:
        result = {"file": file, **profile(f.read(), top)}
    print(json.dumps(result, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
