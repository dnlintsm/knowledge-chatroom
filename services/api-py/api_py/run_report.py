"""A run's report.md front matter, as apps/agent/src/storage/run-report.ts writes it.

A run's report.md carries the run's record in its front matter: state,
results and provenance (issue #82), so the report says where its numbers came
from even when it is copied or downloaded on its own. One key per line, values
as JSON (which YAML reads too). Both servers write these reports, so values
are written exactly as JSON.stringify writes them, numbers included.
"""

from __future__ import annotations

import json
import math
import re
from decimal import Decimal
from typing import Any

REPORT_PATH = "report.md"

_FRONT_MATTER = re.compile(r"^---\r?\n[\s\S]*?\r?\n---\r?\n?")
# Integers past this lose precision in JavaScript, so they are written as its doubles are.
_SAFE_INTEGER = 2**53


def js_number(value: float) -> str:
    """Number.prototype.toString, as JSON.stringify writes a number (null for NaN and infinities)."""
    if isinstance(value, int):
        if abs(value) < _SAFE_INTEGER:
            return str(value)
        value = float(value)
    if math.isnan(value) or math.isinf(value):
        return "null"
    if value == 0:
        return "0"
    sign = "-" if value < 0 else ""
    # repr() gives the shortest digits that read back as this double, as JavaScript picks them.
    digits_tuple, exponent = Decimal(repr(abs(value))).as_tuple()[1:]
    digits = "".join(map(str, digits_tuple)).rstrip("0")
    exponent += len(digits_tuple) - len(digits)  # pyrefly: ignore[unsupported-operation]
    k = len(digits)
    n = exponent + k
    if k <= n <= 21:
        text = digits + "0" * (n - k)
    elif 0 < n <= 21:
        text = f"{digits[:n]}.{digits[n:]}"
    elif -6 < n <= 0:
        text = "0." + "0" * -n + digits
    else:
        e = n - 1
        mantissa = digits if k == 1 else f"{digits[0]}.{digits[1:]}"
        text = f"{mantissa}e{'+' if e >= 0 else '-'}{abs(e)}"
    return sign + text


def js_json(value: Any) -> str:
    """JSON.stringify for JSON values: no spaces, keys in their order, numbers as JavaScript writes them."""
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, int | float):
        return js_number(value)
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, dict):
        return "{" + ",".join(f"{js_json(str(k))}:{js_json(v)}" for k, v in value.items()) + "}"
    if isinstance(value, list | tuple):
        return "[" + ",".join(js_json(v) for v in value) + "]"
    raise TypeError(f"Not a JSON value: {type(value).__name__}")


_INDEX_KEY = re.compile(r"0|[1-9][0-9]*")


def js_order(value: Any) -> Any:
    """
    The value with each object's keys in JavaScript's order: array-index keys
    ("0", "1", ...) first, ascending, then the rest as given. What JSON.parse
    then JSON.stringify gives back.
    """
    if isinstance(value, list):
        return [js_order(v) for v in value]
    if not isinstance(value, dict):
        return value
    index = sorted((k for k in value if _INDEX_KEY.fullmatch(k) and int(k) < 2**32 - 1), key=int)
    first = set(index)
    rest = [k for k in value if k not in first]
    return {k: js_order(value[k]) for k in [*index, *rest]}


def _started_by(who: Any) -> Any:
    if not isinstance(who, dict):
        return None
    name = who.get("name")
    return name if name is not None else who.get("id")


def _inputs(found: Any) -> list[dict[str, Any]] | None:
    """Each input's path in the run, where it came from and its hash; the full record is on the run."""
    if not isinstance(found, list) or not found:
        return None
    out = []
    for item in found:
        entry: dict[str, Any] = {}
        if item is None:
            raise TypeError("An input in the run's record is null")
        if not isinstance(item, dict):
            out.append(entry)  # a string or number has none of these
            continue
        # JSON.stringify leaves out a key whose value is undefined.
        if "path" in item:
            entry["path"] = item["path"]
        source = item.get("from")
        if isinstance(source, dict) and "path" in source:
            entry["from"] = source["path"]
        if "sha256" in item:
            entry["sha256"] = item["sha256"]
        out.append(entry)
    return out


def report_front_matter(run: dict[str, Any]) -> str:
    p = run["provenance"]
    rerun_of = p.get("rerunOf")
    lines: list[tuple[str, Any]] = [
        ("run", run["id"]),
        ("title", run["title"]),
        ("state", run["state"]),
        ("started_by", _started_by(p.get("startedBy"))),
        ("started_at", p.get("startedAt")),
        ("finished_at", p.get("finishedAt")),
        ("chat", p.get("chat")),
        ("model", p.get("model")),
        ("rerun_of", rerun_of.get("id") if isinstance(rerun_of, dict) else None),
        ("skill", p.get("skill")),
        ("tools", p.get("tools")),
        ("inputs", _inputs(p.get("inputs"))),
        ("params", run["params"] or None),
        ("results", run["results"] or None),
    ]
    body = "\n".join(f"{key}: {js_json(value)}" for key, value in lines if value is not None)
    return f"---\n{body}\n---\n"


def with_front_matter(markdown: str, front_matter: str) -> str:
    """`markdown` with its front matter (if any) replaced by `front_matter`."""
    rest = _FRONT_MATTER.sub("", markdown, count=1)
    return front_matter + (rest if rest.startswith("\n") or not rest else f"\n{rest}")


def new_report(run: dict[str, Any]) -> str:
    """A first report for a new run: its record and a title for Claude to write under."""
    return with_front_matter(f"# {run['title']}\n", report_front_matter(run))
