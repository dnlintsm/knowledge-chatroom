"""Skills Claude can use (issue #7), as apps/agent/src/skills/catalog.ts and scan.ts read them.

SKILL.md folders in the Claude Code / Agent Skills layout, from three sources:
built-in ones shipped with the agent (apps/agent/skills/), skills installed
from the hub (skills.py), and the workspace's own skills/<name>/ files. Each
has a mode: auto (Claude may use it on its own, and /name runs it), manual
(only /name runs it) or off.

Both servers read the same skills and the hub keeps a fingerprint of each
version's files in order, so the parsing, the limits and the sort order
(JavaScript's localeCompare, collation.py) are the
TypeScript server's.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any

from .collation import collation_key
from .paths import JS_SPACE, js_trim
from .text_index import from_units, to_units

SKILL_MODES = ("auto", "manual", "off")
SKILL_NAME = re.compile(r"[a-z0-9][a-z0-9-]{0,63}")
# Caps what a run copies to disk; bigger files and skills are left out.
MAX_SKILL_FILE_BYTES = 1024 * 1024
MAX_SKILL_BYTES = 5 * 1024 * 1024

_S = f"[{JS_SPACE}]"
# JavaScript's `.`: anything but a line terminator.
_DOT = "[^\n\r\u2028\u2029]"
_FRONT_MATTER = re.compile(r"\A\ufeff?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|\Z)")
_FIELD = re.compile(rf"([A-Za-z][A-Za-z0-9_-]*){_S}*:{_S}*({_DOT}*)\Z")
_QUOTED = re.compile(rf"([\"']){_DOT}*\1\Z")
_LINES = re.compile(r"\r?\n")
_HEADING = re.compile(rf"\A#+{_S}*")
SCRIPT_FILE = re.compile(
    r"(^|/)scripts/|\.(py|sh|bash|js|mjs|cjs|ts|rb|pl|ps1)\Z", re.IGNORECASE | re.ASCII
)
_BASH = re.compile(r"\bBash\b", re.ASCII)
_WORKSPACE_FILE = re.compile(rf"\Askills/([^/]+)/({_DOT}+)\Z")


def is_skill_name(value: Any) -> bool:
    return isinstance(value, str) and SKILL_NAME.fullmatch(value) is not None


def decode_text(data: bytes) -> str:
    """new TextDecoder().decode: UTF-8 with replacement characters, a leading byte order mark dropped."""
    return data.decode("utf-8", errors="replace").removeprefix("\ufeff")


def strict_text(data: bytes) -> str | None:
    """TextDecoder("utf-8", {fatal: true}), or None when the bytes aren't UTF-8."""
    try:
        return data.decode("utf-8").removeprefix("\ufeff")
    except UnicodeDecodeError:
        return None


def code_unit_key(text: str) -> bytes:
    """Array.prototype.sort's default order: UTF-16 code units."""
    return text.encode("utf-16-be", errors="surrogatepass")


@dataclass(frozen=True)
class SkillFile:
    # Path inside the skill's folder, e.g. "SKILL.md" or "reference/style.md".
    path: str
    data: bytes


@dataclass(frozen=True)
class Skill:
    name: str
    description: str
    argument_hint: str | None
    source: str  # builtin | workspace | hub
    # The workspace path of its SKILL.md; None for built-in and hub skills.
    path: str | None
    model_invocable: bool
    user_invocable: bool
    needs_execution: bool
    files: tuple[SkillFile, ...]
    # For a hub skill: {version, latest, verified, yanked, yankReason}.
    hub: dict[str, Any] | None = field(default=None, compare=False)

    def with_hub(self, name: str, hub: dict[str, Any]) -> Skill:
        return replace(self, name=name, hub=hub)


def parse_front_matter(text: str) -> dict[str, str]:
    """The simple `key: value` front matter of a SKILL.md."""
    match = _FRONT_MATTER.match(text)
    if not match:
        return {}
    fields: dict[str, str] = {}
    for line in _LINES.split(match.group(1)):
        found = _FIELD.match(line)
        if not found:
            continue
        value = js_trim(found.group(2))
        if _QUOTED.match(value):
            value = value[1:-1]
        fields[found.group(1).lower()] = value
    return fields


def skill_from_files(
    folder: str, files: list[SkillFile], source: str, skill_path: str | None
) -> Skill | None:
    """A skill from its folder's files, or None without a usable SKILL.md; named by its front matter, else the folder."""
    main = next((f for f in files if f.path == "SKILL.md"), None)
    if main is None:
        return None
    text = decode_text(main.data)
    meta = parse_front_matter(text)
    name = meta["name"] if is_skill_name(meta.get("name")) else folder
    if not is_skill_name(name):
        return None
    first_line = next(
        (
            clean
            for line in _LINES.split(_FRONT_MATTER.sub("", text, count=1))
            if (clean := js_trim(_HEADING.sub("", line, count=1)))
        ),
        None,
    )
    total = 0
    kept: list[SkillFile] = []
    for f in files:
        if len(f.data) > MAX_SKILL_FILE_BYTES:
            continue
        total += len(f.data)
        if total <= MAX_SKILL_BYTES or f is main:
            kept.append(f)
    return Skill(
        name=name,
        description=meta.get("description") or first_line or "",
        argument_hint=meta.get("argument-hint") or None,
        source=source,
        path=skill_path,
        model_invocable=(meta.get("disable-model-invocation") or "").lower() != "true",
        user_invocable=(meta.get("user-invocable") or "").lower() != "false",
        needs_execution=any(SCRIPT_FILE.search(f.path) for f in files)
        or _BASH.search(meta.get("allowed-tools", "")) is not None,
        files=tuple(kept),
    )


def workspace_skills(files: list[tuple[str, bytes]]) -> list[Skill]:
    """Workspace skills from the files at the workspace root: skills/<folder>/..."""
    folders: dict[str, list[SkillFile]] = {}
    for path, data in files:
        match = _WORKSPACE_FILE.match(path)
        if match:
            folders.setdefault(match.group(1), []).append(SkillFile(match.group(2), data))
    skills: list[Skill] = []
    for folder in sorted(folders, key=collation_key):
        skill = skill_from_files(folder, folders[folder], "workspace", f"skills/{folder}/SKILL.md")
        # Two folders claiming one name: the first (by folder) wins.
        if skill and not any(s.name == skill.name for s in skills):
            skills.append(skill)
    return skills


def _read_tree(directory: Path, prefix: str = "") -> list[SkillFile]:
    """A folder's files, in the order Node's readdir lists them; links and files over the limit left out."""
    found: list[SkillFile] = []
    with os.scandir(directory) as entries:
        listed = sorted(entries, key=lambda e: os.fsencode(e.name))
    for entry in listed:
        rel = f"{prefix}/{entry.name}" if prefix else entry.name
        if entry.is_dir(follow_symlinks=False):
            found.extend(_read_tree(Path(entry.path), rel))
        elif (
            entry.is_file(follow_symlinks=False)
            and os.stat(entry.path).st_size <= MAX_SKILL_FILE_BYTES
        ):
            found.append(SkillFile(rel, Path(entry.path).read_bytes()))
    return found


def builtin_skills(directory: Path) -> list[Skill]:
    """The skills shipped in apps/agent/skills/."""
    try:
        with os.scandir(directory) as entries:
            folders = sorted((e.name for e in entries if e.is_dir()), key=code_unit_key)
    except OSError:
        return []
    skills = [
        skill_from_files(folder, _read_tree(directory / folder), "builtin", None)
        for folder in folders
    ]
    return [s for s in skills if s is not None]


def merge_skills(*lists: list[Skill]) -> list[Skill]:
    """All skills by name; a later list's skill replaces an earlier one's of the same name."""
    by_name: dict[str, Skill] = {}
    for skills in lists:
        for skill in skills:
            by_name[skill.name] = skill
    return sorted(by_name.values(), key=lambda s: collation_key(s.name))


def default_mode(skill: Skill) -> str:
    """Auto, unless it can't be; hub skills start manual, so someone else's instructions run only when asked."""
    return "auto" if skill.model_invocable and skill.source != "hub" else "manual"


def effective_mode(skill: Skill, chosen: str | None) -> str:
    """The choice, else the default; never auto when Claude may not invoke it, never manual without /name."""
    mode = chosen or default_mode(skill)
    if mode == "auto" and not skill.model_invocable:
        mode = "manual"
    if mode == "manual" and not skill.user_invocable:
        mode = "off"
    return mode


def chosen_mode(layers: dict[str, str] | None) -> str | None:
    """The most specific choice: the chat's, else the user's, else the workspace's."""
    if not layers:
        return None
    return layers.get("chat") or layers.get("user") or layers.get("workspace")


def describe(skill: Skill, layers: dict[str, str] | None = None) -> dict[str, Any]:
    layers = layers or {}
    return {
        "name": skill.name,
        "description": skill.description,
        "argumentHint": skill.argument_hint,
        "source": skill.source,
        "path": skill.path,
        "modelInvocable": skill.model_invocable,
        "userInvocable": skill.user_invocable,
        "needsExecution": skill.needs_execution,
        "mode": effective_mode(skill, chosen_mode(layers)),
        "defaultMode": default_mode(skill),
        "workspaceMode": layers.get("workspace"),
        "userMode": layers.get("user"),
        "chatMode": layers.get("chat"),
        "hub": skill.hub,
    }


def manifest_of(skill: Skill) -> dict[str, Any]:
    return {
        "description": skill.description,
        "argumentHint": skill.argument_hint,
        "modelInvocable": skill.model_invocable,
        "userInvocable": skill.user_invocable,
        "needsExecution": skill.needs_execution,
    }


# The check a hub version gets when it's published (scan.ts): what a person
# should look at before installing it. Flags warn; they don't stop publishing.

# Files bigger than this are flagged (the hub takes up to 1 MB each).
LARGE_FILE_BYTES = 256 * 1024
# Flags kept per kind and file; the rest are counted in one more flag.
_PER_FILE = 3
# Flags kept for a whole version.
_MAX_FLAGS = 50

_NETWORK = [
    (
        re.compile(r"\bhttps?://[^\s)\]>\"'`]+".replace(r"\s", JS_SPACE), re.IGNORECASE | re.ASCII),
        lambda m: f"links to {_host_of(m)}",
    ),
    (
        re.compile(
            rf"\b(curl|wget|Invoke-WebRequest|Invoke-RestMethod|netcat|scp|rsync){_S}", re.ASCII
        ),
        lambda m: f"runs {js_trim(m)}",
    ),
    (
        re.compile(
            r"\b(fetch|XMLHttpRequest|requests\.(get|post|put)|urllib|http\.client|axios)\b",
            re.ASCII,
        ),
        lambda m: f"calls {m}",
    ),
]


def _js(pattern: str) -> re.Pattern[str]:
    r"""A case-insensitive JavaScript pattern of scan.ts: \s as JavaScript's spaces, \b and case as ASCII."""
    return re.compile(
        pattern.replace(r"[\s_-]", f"[{JS_SPACE}_-]").replace(r"\s", _S), re.IGNORECASE | re.ASCII
    )


_INSTRUCTIONS = [
    _js(
        r"\b(ignore|disregard|forget|override)\s+(all\s+|any\s+|the\s+|your\s+)?(previous|prior|above|earlier|other|system)"
        r"\s+(instructions|directions|rules|prompts?)"
    ),
    _js(
        r"\b(do\s+not|don't|never)\s+(tell|inform|mention|reveal|show|alert)\b[^.\n]{0,40}\b(the\s+)?(user|human|person)\b"
    ),
    _js(r"\bwithout\s+(telling|asking|informing|notifying)\s+(the\s+)?(user|human|person)\b"),
    _js(
        r"\b(reveal|print|repeat|output)\s+(your\s+|the\s+)?(system\s+prompt|hidden\s+instructions)"
    ),
    _js(r"\bexfiltrat"),
    _js(
        r"\b(api[\s_-]?keys?|passwords?|secrets?|tokens?|credentials?|\.env\b|ssh\s+keys?)\b[^\n]{0,60}"
        r"\b(send|post|upload|email|forward|paste)\b"
    ),
    _js(
        r"\b(send|post|upload|email|forward)\b[^\n]{0,60}"
        r"\b(api[\s_-]?keys?|passwords?|secrets?|credentials?|\.env\b|ssh\s+keys?)\b"
    ),
]
# Zero-width, bidirectional-override and Unicode tag characters: text a reader can't see.
_HIDDEN = re.compile(
    r"[\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff\U000e0000-\U000e007f]"
)
# A run of base64-looking text long enough to hide a payload.
_ENCODED = re.compile(r"[A-Za-z0-9+/]{200,}={0,2}")
_MARKDOWN = re.compile(r"\.(md|markdown)\Z", re.IGNORECASE | re.ASCII)


_FORBIDDEN_HOST = re.compile(r"[\x00-\x20#%/:<>?@\[\\\]^|\x7f]")


def _host_of(url: str) -> str:
    """
    new URL(url).host, nearly: the host in lower case, with a port that isn't
    the scheme's default; the first 60 characters when it isn't a URL.
    """
    scheme, _, rest = url.partition("://")
    authority = re.split(r"[/\\?#]", rest.lstrip("/\\"), maxsplit=1)[0].rpartition("@")[2]
    if authority.startswith("["):
        host, _, after = authority.partition("]")
        host, port = host + "]", after.removeprefix(":") if after.startswith(":") else None
        valid = after == "" or after.startswith(":")
    else:
        host, _, port = authority.rpartition(":") if ":" in authority else (authority, "", None)
        valid = bool(host) and not _FORBIDDEN_HOST.search(host)
    if valid and port:
        valid = port.isascii() and port.isdigit() and int(port) <= 65535
    if valid and not host.isascii():
        try:
            host = host.encode("idna").decode("ascii")
        except UnicodeError:
            valid = False
    if not valid:
        return from_units(to_units(url)[:60])
    host = host.lower()
    default = "443" if scheme.lower() == "https" else "80"
    return f"{host}:{int(port)}" if port and str(int(port)) != default else host


def _clip(text: str) -> str:
    units = to_units(text)
    return f"{from_units(units[:77])}…" if len(units) > 80 else text


def scan_skill(files: list[SkillFile] | tuple[SkillFile, ...]) -> list[dict[str, Any]]:
    """Flags for a skill's files, at most 50, in file order."""
    flags: list[dict[str, Any]] = []
    for file in sorted(files, key=lambda f: collation_key(f.path)):
        counts: dict[str, int] = {}

        def add(
            kind: str, line: int | None, detail: str, path: str = file.path, counts: dict = counts
        ) -> None:
            counts[kind] = counts.get(kind, 0) + 1
            if counts[kind] <= _PER_FILE:
                flags.append({"kind": kind, "path": path, "line": line, "detail": detail})

        if SCRIPT_FILE.search(file.path):
            add("scripts", None, "a script file; it runs only where scripts are on, in a sandbox")
        if len(file.data) > LARGE_FILE_BYTES:
            add("large", None, f"{int(len(file.data) / 1024 + 0.5)} KB")
        text = None if b"\0" in file.data else strict_text(file.data)
        if text is None:
            add("binary", None, "not text, so not checked")
        else:
            if file.path == "SKILL.md" and _BASH.search(
                parse_front_matter(text).get("allowed-tools", "")
            ):
                add("scripts", None, "asks for Bash in allowed-tools")
            markdown = _MARKDOWN.search(file.path) is not None
            for i, line in enumerate(_LINES.split(text)):
                at = i + 1
                if _HIDDEN.search(line.removeprefix("\ufeff") if i == 0 else line):
                    add("hidden-text", at, "invisible characters")
                if markdown and "<!--" in line:
                    add("hidden-text", at, "an HTML comment, hidden when the page is shown")
                if _ENCODED.search(line):
                    add("hidden-text", at, "a long run of encoded text")
                for pattern, detail in _NETWORK:
                    match = pattern.search(line)
                    if match:
                        add("network", at, detail(match.group(0)))
                for pattern in _INSTRUCTIONS:
                    match = pattern.search(line)
                    if match:
                        add("instructions", at, f"“{_clip(match.group(0))}”")
                        break
        for kind, n in counts.items():
            if n > _PER_FILE:
                flags.append(
                    {
                        "kind": kind,
                        "path": file.path,
                        "line": None,
                        "detail": f"and {n - _PER_FILE} more like this",
                    }
                )
    return flags[:_MAX_FLAGS]
