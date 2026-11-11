"""Text helpers shared with the TypeScript agent: numbered reads and exact edits.

Ports of apps/agent/src/storage/tools.ts readLines()/numberLines() and
packages/contracts/src/text-edit.ts applyEdit(), with the same output, so the
model reads and edits files the same way whichever agent serves the chat.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

# About 15k tokens: well under the SDK's limit for one MCP tool result, and
# small enough for models with smaller windows (issue #126).
MAX_READ_CHARS = 50_000

_LINE_BREAK = re.compile(r"\r\n|\r|\n")
_LINE_NUMBER = re.compile(r"^\s*\d+\t")


def split_lines(content: str) -> list[str]:
    return _LINE_BREAK.split(content)


def read_lines(
    path: str,
    content: str,
    offset: int = 1,
    column: int = 1,
    limit: int | None = None,
    max_chars: int = MAX_READ_CHARS,
) -> str:
    """Lines `offset`.. (1-based), numbered, with a header saying where to go on from."""
    lines = split_lines(content)
    total = len(lines)
    if offset > total:
        return f"{path} ({total} lines; offset {offset} is past the end)"
    if column > 1 and column > len(lines[offset - 1]):
        return f"{path} (line {offset} has {len(lines[offset - 1])} characters; column {column} is past its end)"
    width = len(str(total))
    out: list[str] = []
    chars = 0
    resume_at: int | None = None
    end = total if limit is None else min(total, offset - 1 + limit)
    for i in range(offset - 1, end):
        start = column - 1 if i == offset - 1 else 0
        line = lines[i][start:]
        if chars + len(line) > max_chars:
            if out:
                break
            line = line[:max_chars]
            resume_at = start + max_chars + 1
        out.append(f"{str(i + 1).rjust(width)}\t{line}")
        chars += len(line) + 1
        if resume_at is not None:
            break
    last = offset - 1 + len(out)
    whole = offset == 1 and column == 1 and last == total and resume_at is None
    header = path
    if not whole:
        header += f" (lines {offset}-{last} of {total}"
        if column > 1:
            header += f"; line {offset} from column {column}"
        if resume_at is not None:
            header += f"; line {last} cut before column {resume_at}; continue with offset {last} column {resume_at}"
        elif last < total:
            header += f"; continue with offset {last + 1}"
        header += ")"
    return header + "\n" + "\n".join(out)


@dataclass
class Edit:
    content: str
    replacements: int
    lines: tuple[int, int]
    """First and last line (1-based) of the first replacement in the new content."""


class EditError(ValueError):
    pass


def apply_edit(content: str, old_text: str, new_text: str, replace_all: bool = False) -> Edit:
    if not old_text:
        raise EditError(
            "oldText is empty. To create a file or replace all of it, write the whole file instead."
        )
    if old_text == new_text:
        raise EditError("oldText and newText are the same; nothing to change.")
    # Reads split lines on any line ending: match a CRLF file too, keeping its endings.
    crlf = "\r\n" in content
    find = old_text
    put = re.sub(r"\r?\n", "\r\n", new_text) if crlf else new_text
    if crlf and find not in content and "\r\n" not in find:
        find = find.replace("\n", "\r\n")
    first = content.find(find)
    if first == -1:
        numbered = any(_LINE_NUMBER.match(line) for line in old_text.split("\n"))
        raise EditError(
            "oldText was not found in the file. "
            + (
                "Leave out the line numbers and the tab after them: they are not part of the file. "
                if numbered
                else ""
            )
            + "Copy it exactly (spaces and indentation too) from a fresh read of the lines you want to change; "
            "the file may have changed since you read it."
        )
    count = content.count(find)
    if count > 1 and not replace_all:
        raise EditError(
            f"oldText occurs {count} times. Include more of the surrounding lines so it matches only "
            "the place you mean, or set replaceAll to change every occurrence."
        )
    updated = (
        content.replace(find, put)
        if replace_all
        else content[:first] + put + content[first + len(find) :]
    )
    start = _line_at(updated, first)
    end = _line_at(updated, first + max(len(put) - 1, 0))
    return Edit(updated, count if replace_all else 1, (start, end))


def _line_at(text: str, index: int) -> int:
    return len(split_lines(text[:index]))
