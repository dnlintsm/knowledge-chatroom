"""The run's working folder (issue #264, step 3).

The Python twin of apps/agent/src/storage/workdir.ts. Claude Code's built-in
Read, Glob and Grep (and Bash, for skills' scripts) work on real files under
the run's folder, but the workspace lives behind the storage API. So each
user's run folder (skills.py) gets `workspace/`, a copy of every file that user
can read in the run's workspace:

  workspace/root/...                         the workspace root
  workspace/nodes/<Tech>/<Module>/...        each knowledge node's files,
                                             child nodes as subfolders
  workspace/experiments/<title> (<id>)/...   each experiment they can see
  workspace/.places.json                     folder -> node / experiment id

It is filled through the storage API with the run's token (the same checks as
the file tools), so it never holds a file they can't open. Synced at the start
of each run: only files whose content changed are downloaded, files that went
away are removed. It is a snapshot; changes made during a run show up on the
next one. Its files are read-only: changes go through write_file, edit_file and
save_file, which check access and keep versions.

Claude reads it with Read/Glob/Grep, confined to the run folder (confine_hook).
A run started during the turn gets its linked inputs copied to
`run-inputs/<run id>/` (write_run_inputs), since the snapshot may hold an older
version than the one the run linked.
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import json
import logging
import os
import re
import shutil
from collections.abc import Awaitable, Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, cast

import httpx
from claude_agent_sdk import HookContext, HookInput, HookJSONOutput, HookMatcher

from .workspace import Storage, file_route

logger = logging.getLogger("agent_py")

WORKSPACE_DIR = "workspace"
# Kept in the run folder, outside workspace/: path -> sha256 of what was written.
MANIFEST = ".workspace-manifest.json"
PLACES = ".places.json"
# Inputs of runs started this turn: run-inputs/<run id>/<name>.
RUN_INPUTS_DIR = "run-inputs"
# Places (root, nodes, experiments) listed at once, and files downloaded at once.
LIST_CONCURRENCY = 8
DOWNLOAD_CONCURRENCY = 8
MB = 1024 * 1024
# Read, Glob and Grep run outside the sandbox: they may only look inside the run folder.
CONFINED_TOOLS = ("Read", "Glob", "Grep")
_UNSAFE = re.compile(r"[/\\\x00-\x1f]")


def workdir_enabled(env: Mapping[str, str]) -> bool:
    """On by default; AGENT_WORKDIR=off turns it off."""
    return env.get("AGENT_WORKDIR") != "off"


@dataclass(frozen=True)
class Limits:
    max_bytes: int = 500 * MB  # most bytes the copy holds; files past it are left out
    max_file_bytes: int = 25 * MB  # larger files are left out


def limits_from_env(env: Mapping[str, str]) -> Limits:
    def mb(name: str, fallback: int) -> int:
        try:
            value = float(env.get(name) or "")
        except ValueError:
            return fallback * MB
        return int(value * MB) if value > 0 else fallback * MB

    return Limits(mb("AGENT_WORKDIR_MAX_MB", 500), mb("AGENT_WORKDIR_MAX_FILE_MB", 25))


@dataclass
class Place:
    folder: str
    role: str  # what the user may do there; editor/owner/writer change files (through the tools)
    root: bool = False
    node: str | None = None
    experiment: str | None = None

    def as_json(self) -> dict[str, Any]:
        out: dict[str, Any] = {"folder": self.folder}
        if self.root:
            out["root"] = True
        if self.node:
            out["node"] = self.node
        if self.experiment:
            out["experiment"] = self.experiment
        out["role"] = self.role
        return out


@dataclass
class Summary:
    dir: Path  # workspace/
    places: list[Place] = field(default_factory=list)
    files: int = 0
    bytes: int = 0
    # Files left out (too large, over the total, a name taken by a child node, ...).
    skipped: list[dict[str, str]] = field(default_factory=list)


@dataclass
class _Wanted:
    rel: str
    sha256: str
    size: int
    path: str
    params: dict[str, str]  # the place, as the storage API takes it


def folder_name(name: str) -> str:
    """A folder name for a node or experiment: no slashes, no leading dot, not empty."""
    clean = _UNSAFE.sub("-", name).lstrip(".").strip()[:120]
    return clean or "untitled"


def is_inside(root: Path, target: str | Path) -> bool:
    """Whether `target` (relative to `root`, after following links) is `root` or inside it."""
    real_root = root.resolve()
    try:
        real = (root / target).resolve()
    except (OSError, RuntimeError):
        return False
    return real == real_root or real.is_relative_to(real_root)


# One sync per folder at a time, so two runs starting together don't race.
_locks: dict[Path, asyncio.Lock] = {}


def _lock(cwd: Path) -> asyncio.Lock:
    return _locks.setdefault(cwd.resolve(), asyncio.Lock())


async def _pool[T](items: Sequence[T], size: int, fn: Callable[[T], Awaitable[None]]) -> None:
    """Runs `fn` over `items`, at most `size` at a time; the first failure is raised once all finish."""
    gate = asyncio.Semaphore(size)

    async def one(item: T) -> None:
        async with gate:
            await fn(item)

    results = await asyncio.gather(*(one(item) for item in items), return_exceptions=True)
    for result in results:
        if isinstance(result, BaseException):
            raise result


async def download(storage: Storage, path: str, params: Mapping[str, str]) -> bytes:
    """A file's bytes. A binary file can come as a signed link to the object store
    (S3_PUBLIC_URL): that link is fetched without the run's token."""
    response = await storage.call("GET", file_route(path), params=params)
    if not response.is_redirect:
        return response.content
    link = response.headers.get("location", "")
    async with httpx.AsyncClient(timeout=120, transport=storage.transport) as client:
        stored = await client.get(link)
    stored.raise_for_status()
    return stored.content


async def sync_workdir(storage: Storage, cwd: Path, limits: Limits | None = None) -> Summary:
    """Brings `<cwd>/workspace/` up to date with what the run's user can read."""
    async with _lock(cwd):
        return await _sync(storage, cwd, limits or Limits())


async def _sync(storage: Storage, cwd: Path, limits: Limits) -> Summary:
    root = cwd / WORKSPACE_DIR
    # Last turn's run inputs: this snapshot has them, under the runs' folders.
    # A fresh, real folder, which scripts can't write to (scripts.py).
    _fresh_run_inputs(cwd)
    summary = Summary(root)

    tree, experiments = await asyncio.gather(
        storage.json("GET", "/nodes"), storage.json("GET", "/experiments")
    )
    nodes: list[dict[str, Any]] = tree.get("nodes", [])

    # Folder of each node: its ancestors' names, with siblings of the same name told apart by id.
    by_parent: dict[str | None, list[dict[str, Any]]] = {}
    for node in nodes:
        by_parent.setdefault(node.get("parentId"), []).append(node)
    folders: dict[str, str] = {}
    child_names: dict[str, set[str]] = {}

    def walk(parent: str | None, parent_folder: str) -> None:
        siblings = by_parent.get(parent, [])
        counts: dict[str, int] = {}
        for node in siblings:
            key = folder_name(node["name"]).lower()
            counts[key] = counts.get(key, 0) + 1
        names: set[str] = set()
        for node in siblings:
            name = folder_name(node["name"])
            if counts[name.lower()] > 1:
                name = f"{name} ({node['id'][:8]})"
            names.add(name)
            folders[node["id"]] = f"{parent_folder}/{name}"
            walk(node["id"], folders[node["id"]])
        if parent:
            child_names[parent] = names

    walk(None, "nodes")

    # Every place the user can read, in a fixed order: root, nodes, experiments.
    sources: list[tuple[Place, str, dict[str, str], set[str]]] = []
    if tree.get("rootRole"):
        sources.append(
            (Place(f"{WORKSPACE_DIR}/root", tree["rootRole"], root=True), "root", {}, set())
        )
    for node in nodes:
        if not node.get("role"):
            continue
        folder = folders[node["id"]]
        sources.append(
            (
                Place(f"{WORKSPACE_DIR}/{folder}", node["role"], node=node["id"]),
                folder,
                {"node": node["id"]},
                child_names.get(node["id"], set()),
            )
        )
    for experiment in experiments.get("experiments", []):
        folder = f"experiments/{folder_name(experiment['title'])} ({experiment['id'][:8]})"
        sources.append(
            (
                Place(
                    f"{WORKSPACE_DIR}/{folder}",
                    experiment["access"],
                    experiment=experiment["id"],
                ),
                folder,
                {"experiment": experiment["id"]},
                set(),
            )
        )

    # Each place costs an access check and a listing: a few at a time.
    listed: dict[int, list[dict[str, Any]]] = {}

    async def list_place(i: int) -> None:
        listed[i] = (await storage.json("GET", "/files", params=sources[i][2]))["files"]

    await _pool(range(len(sources)), LIST_CONCURRENCY, list_place)

    wanted: dict[str, _Wanted] = {}
    for i, (place, folder, params, children) in enumerate(sources):
        summary.places.append(place)
        for info in listed[i]:
            rel = f"{folder}/{info['path']}"
            if info["path"].split("/")[0] in children:
                summary.skipped.append({"path": rel, "reason": "a child node has this name"})
                continue
            wanted[rel] = _Wanted(rel, info["sha256"], info["size"], info["path"], params)

    # Smallest first keeps the most files under the cap.
    keep: dict[str, _Wanted] = {}
    for file in sorted(wanted.values(), key=lambda f: (f.size, f.rel)):
        if file.size > limits.max_file_bytes:
            reason = f"larger than {limits.max_file_bytes / MB:g} MB"
        elif summary.bytes + file.size > limits.max_bytes:
            reason = f"the folder is full ({limits.max_bytes / MB:g} MB)"
        else:
            keep[file.rel] = file
            summary.bytes += file.size
            continue
        summary.skipped.append({"path": file.rel, "reason": reason})

    manifest_path = cwd / MANIFEST
    try:
        manifest: dict[str, str] = json.loads(manifest_path.read_text())
    except (OSError, ValueError):
        manifest = {}
    root.mkdir(parents=True, exist_ok=True)

    # Remove what is no longer wanted (or wasn't written here), then empty folders.
    present: set[str] = set()

    def remove_stale(folder: Path, rel_folder: str) -> bool:
        try:
            with os.scandir(folder) as scan:
                entries = list(scan)
        except OSError:
            return True
        empty = True
        for entry in entries:
            rel = f"{rel_folder}/{entry.name}" if rel_folder else entry.name
            if entry.is_dir(follow_symlinks=False):
                if remove_stale(Path(entry.path), rel):
                    with contextlib.suppress(OSError):
                        os.rmdir(entry.path)
                else:
                    empty = False
            elif rel != PLACES and (rel not in keep or keep[rel].sha256 != manifest.get(rel)):
                Path(entry.path).unlink(missing_ok=True)
                manifest.pop(rel, None)
            else:
                present.add(rel)
                empty = False
        return empty

    remove_stale(root, "")

    missing = [f for f in keep.values() if f.rel not in present or manifest.get(f.rel) != f.sha256]
    failed = 0

    async def fetch(file: _Wanted) -> None:
        nonlocal failed
        target = root.joinpath(*file.rel.split("/"))
        try:
            if not is_inside(root, target):
                raise ValueError("outside the folder")
            data = await download(storage, file.path, file.params)
            target.parent.mkdir(parents=True, exist_ok=True)
            tmp = target.with_name(f"{target.name}.{os.getpid()}.tmp")
            tmp.write_bytes(data)
            tmp.chmod(0o444)
            tmp.replace(target)
            manifest[file.rel] = file.sha256 or hashlib.sha256(data).hexdigest()
        except Exception as err:  # one file never fails the copy
            failed += 1
            summary.skipped.append({"path": file.rel, "reason": "couldn't be copied"})
            if failed <= 3:
                logger.warning("[workdir] couldn't copy %s: %s", file.rel, err)

    await _pool(missing, DOWNLOAD_CONCURRENCY, fetch)

    manifest_path.write_text(json.dumps(manifest))
    places = root / PLACES
    places.unlink(missing_ok=True)
    places.write_text(
        json.dumps(
            {"places": [p.as_json() for p in summary.places], "skipped": summary.skipped},
            indent=1,
        )
    )
    places.chmod(0o444)
    summary.files = len(keep) - failed
    return summary


async def clear_workdir(cwd: Path) -> None:
    """Removes a run folder's copy, for a run without one (turned off, or the sync
    failed): scripts can read the whole run folder, and an old copy may hold files
    the user can no longer read."""
    async with _lock(cwd):
        shutil.rmtree(cwd / WORKSPACE_DIR, ignore_errors=True)
        shutil.rmtree(cwd / RUN_INPUTS_DIR, ignore_errors=True)
        (cwd / MANIFEST).unlink(missing_ok=True)


def _fresh_run_inputs(cwd: Path) -> None:
    folder = cwd / RUN_INPUTS_DIR
    if folder.is_symlink():
        folder.unlink()
    shutil.rmtree(folder, ignore_errors=True)
    folder.mkdir(parents=True, exist_ok=True)


async def write_run_inputs(
    storage: Storage,
    cwd: Path,
    run_id: str,
    paths: Iterable[str],
    limits: Limits | None = None,
) -> dict[str, str]:
    """Copies a new run's inputs (the versions it linked) into `run-inputs/<run id>/`,
    read-only, for scripts this turn: each input's path in the run -> its path here.
    Files over the size limit, or that can't be read, are left out."""
    limits = limits or Limits()
    folder = cwd / RUN_INPUTS_DIR
    out: dict[str, str] = {}
    for path in paths:
        try:
            data = await download(storage, path, {"experiment": run_id})
        except Exception:  # an input left out is missing from what's returned
            continue
        if len(data) > limits.max_file_bytes:
            continue
        rel = f"{RUN_INPUTS_DIR}/{run_id}/{path.removeprefix('inputs/')}"
        target = cwd.joinpath(*rel.split("/"))
        # Checked against the run folder too: a script may have pointed a
        # folder in here somewhere else, and this server writes outside the sandbox.
        if folder.is_symlink() or not (is_inside(folder, target) and is_inside(cwd, target)):
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        target.unlink(missing_ok=True)
        target.write_bytes(data)
        target.chmod(0o444)
        out[path] = rel
    return out


def _deny(reason: str) -> HookJSONOutput:
    return {
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": reason,
        }
    }


def confine_hook(cwd: Path) -> HookMatcher:
    """Read, Glob and Grep may only look inside the run folder."""

    async def check(
        input_data: HookInput, _tool_use_id: str | None, _context: HookContext
    ) -> HookJSONOutput:
        data = cast(dict[str, Any], input_data)
        name = data.get("tool_name")
        args = data.get("tool_input") or {}
        paths: list[str] = []
        if name == "Read":
            paths.append(str(args.get("file_path") or ""))
        else:
            if isinstance(args.get("path"), str) and args["path"]:
                paths.append(args["path"])
            # Glob patterns can name folders too ("/etc/*", "../**"); Grep's pattern is a regex.
            for key in ("pattern", "glob"):
                value = args.get(key)
                if not isinstance(value, str) or (name == "Grep" and key == "pattern"):
                    continue
                if ".." in re.split(r"[/\\]", value):
                    return _deny("Patterns can't leave the working folder.")
                if os.path.isabs(value):
                    paths.append(re.sub(r"[*?\[{].*$", "", value) or "/")
        for path in paths:
            if not path or not is_inside(cwd, path):
                return _deny(
                    f"Only files in the working folder ({cwd}) can be read; "
                    "use the workspace file tools for anything else."
                )
        return {}

    return HookMatcher(matcher="|".join(CONFINED_TOOLS), hooks=[check])


def workdir_prompt(summary: Summary, scripts: bool) -> str:
    """What Claude is told about the folder in a run that has one."""
    lines = [
        "",
        "Working folder: the current directory holds workspace/, a read-only copy of every workspace",
        "file the user can read, taken when this message started: workspace/root/ (the workspace root),",
        "workspace/nodes/<node>/<child>/ (knowledge nodes by name) and workspace/experiments/<title> (<id>)/.",
        "workspace/.places.json maps each folder to its node or experiment id and the user's role there.",
        f'It has {summary.files} files; files too large to copy are listed under "skipped" there.',
        "Use Glob and Grep to find things in it and Read to read them (paths relative to the current",
        "directory, e.g. workspace/root/notes/welcome.md). To change a file, use edit_file (or write_file",
        "for a new file) with that place's node or experiment id; never assume a change to the copy is saved.",
    ]
    if scripts:
        lines += [
            "Skill scripts run in Bash in this folder and can read workspace/ but not change it. Files a",
            "script makes elsewhere in this folder (e.g. out/plot.png) are not saved until you call save_file.",
        ]
    return "\n".join(lines)
