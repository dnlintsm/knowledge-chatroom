"""Workspace file tools over the storage API (issue #176, step 2).

The Python twin of apps/agent/src/storage/tools.ts: the same tool names,
descriptions and results, so the chat, its tool cards and the system prompt work
the same whichever agent serves it. Instead of opening the database, each call
goes to the storage API on LOCAL_AGENT_URL with the run's X-Knowledge-Storage
token, which acts as Claude for the signed-in user: only what they can reach,
writes in a knowledge node (and to skills) as proposals, no renaming, deleting
or sharing (docs/remote-agent.md). Without login there is no token and the API
answers as the local user.

The tools take the place (node / experiment) as parameters rather than fixing
it when the chat starts: the user moves around during a chat.
"""

from __future__ import annotations

import json
import urllib.parse
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from typing import Any

import httpx
from claude_agent_sdk import SdkMcpTool, create_sdk_mcp_server, tool

from .text import MAX_READ_CHARS, EditError, apply_edit, read_lines

# The TypeScript agent's server name, so tools have the same full names
# (mcp__copilotkit__read_file, ...) with either agent.
SERVER_NAME = "copilotkit"
STORAGE_HEADER = "X-Knowledge-Storage"
DEFAULT_STORAGE_URL = "http://localhost:8000"
EDIT_CONTEXT_LINES = 2
MAX_EDIT_PREVIEW_CHARS = 4_000

# packages/contracts/src/files.ts
KIND_FOLDERS = {"note": "notes", "skill": "skills", "upload": "uploads", "artifact": "artifacts"}
TEXT_EXTENSIONS = set(
    "md markdown txt json csv ts tsx js jsx py yaml yml html css sql sh toml xml htm tsv log ini cfg conf env "
    "jsonl ipynb mjs cjs mts cts scss less vue svelte graphql go rs java kt c h cpp hpp cc cs rb php swift scala "
    "r lua pl bash zsh ps1 bat tex rst".split()
)


def storage_url(env: Mapping[str, str]) -> str:
    """The agent server that serves storage, as the app finds it (apps/web/src/lib/agent-target.ts)."""
    return (env.get("LOCAL_AGENT_URL") or DEFAULT_STORAGE_URL).rstrip("/")


def is_text_file(path: str, mime: str) -> bool:
    extension = path.rsplit(".", 1)[-1].lower() if "." in path.rsplit("/", 1)[-1] else ""
    return mime.startswith("text/") or mime in ("application/json", "image/svg+xml") or extension in TEXT_EXTENSIONS


def is_skill_path(path: str) -> bool:
    return path.strip().lstrip("/").split("/")[0] == KIND_FOLDERS["skill"]


class WorkspaceError(Exception):
    """The storage API refused or failed; the message is for Claude."""

    def __init__(self, message: str, status: int | None = None) -> None:
        super().__init__(message)
        self.status = status


@dataclass
class Storage:
    """The storage API for one run: its base URL and the run's token."""

    base_url: str
    token: str | None
    transport: httpx.AsyncBaseTransport | None = None

    async def call(
        self,
        method: str,
        route: str,
        params: Mapping[str, str | None] | None = None,
        json_body: Any = None,
        content: bytes | None = None,
    ) -> httpx.Response:
        headers = {STORAGE_HEADER: self.token} if self.token else {}
        if content is not None:
            headers["Content-Type"] = "application/octet-stream"
        query = {k: v for k, v in (params or {}).items() if v is not None}
        try:
            async with httpx.AsyncClient(base_url=self.base_url, timeout=60, transport=self.transport) as client:
                response = await client.request(
                    method, route, params=query, json=json_body, content=content, headers=headers
                )
        except httpx.HTTPError as err:
            raise WorkspaceError(f"Workspace storage is unavailable right now ({err}).") from err
        if response.status_code >= 400:
            raise WorkspaceError(_refusal(response), response.status_code)
        return response

    async def json(self, method: str, route: str, **kwargs: Any) -> Any:
        return (await self.call(method, route, **kwargs)).json()


def _refusal(response: httpx.Response) -> str:
    try:
        message = response.json().get("error")
    except (ValueError, AttributeError):
        message = None
    if response.status_code == 401:
        return "The user is not signed in, so the workspace is unavailable."
    if response.status_code == 404 and not message:
        return "Not found (or the user can't see it)."
    if response.status_code == 413:
        return "The file is larger than the workspace accepts."
    return message or f"Workspace storage error ({response.status_code})."


def file_route(path: str) -> str:
    """/files/<path>, each segment encoded and slashes kept."""
    return "/files/" + "/".join(urllib.parse.quote(s, safe="") for s in path.strip().lstrip("/").split("/"))


def _place(args: Mapping[str, Any]) -> dict[str, str | None]:
    """?experiment= wins over ?node= (an experiment's files, not its node's)."""
    experiment = args.get("experiment") or None
    return {"experiment": experiment} if experiment else {"node": args.get("node") or None}


ToolResult = dict[str, Any]


def text(value: Any) -> ToolResult:
    return {"content": [{"type": "text", "text": value if isinstance(value, str) else json.dumps(value)}]}


def error(message: str) -> ToolResult:
    return {**text(message), "is_error": True}


def format_tree(nodes: list[dict[str, Any]]) -> str:
    """The tree as indented lines, e.g. `- Etch [tech] id=… (3 files, editor)`."""
    children: dict[str | None, list[dict[str, Any]]] = {}
    for node in nodes:
        children.setdefault(node.get("parentId"), []).append(node)
    lines: list[str] = []

    def walk(parent: str | None, depth: int) -> None:
        for node in children.get(parent, []):
            count = node.get("fileCount", 0)
            files = "1 file" if count == 1 else f"{count} files"
            role = node.get("role", "")
            about = "no access, shown as a path" if role is None else f"{files}, {role}" if role else files
            lines.append(f"{'  ' * depth}- {node['name']} [{node['type']}] id={node['id']} ({about})")
            walk(node["id"], depth + 1)

    walk(None, 0)
    return "\n".join(lines)


NODE = {
    "type": "string",
    "description": "Knowledge node id (from list_nodes or the context's currentNode). Omit for the workspace root.",
}
EXPERIMENT = {
    "type": "string",
    "description": "Experiment id (from list_experiments or the context's currentExperiment); the experiment's "
    "files instead of a node's. Takes precedence over `node`.",
}
SUMMARY = {"type": "string", "description": "One line on what changed and why; shown to whoever reviews a proposal."}


def schema(properties: dict[str, Any], *required: str) -> dict[str, Any]:
    return {"type": "object", "properties": properties, "required": list(required)}


def file_tools(storage: Callable[[], Storage]) -> list[SdkMcpTool[Any]]:
    """The workspace tools; `storage` gives the current run's storage API."""

    def guarded(fn: Callable[[Storage, dict[str, Any]], Awaitable[ToolResult]]):
        async def handler(args: dict[str, Any]) -> ToolResult:
            try:
                return await fn(storage(), args)
            except WorkspaceError as err:
                return error(str(err))

        return handler

    async def store(s: Storage, path: str, data: bytes, args: Mapping[str, Any]) -> ToolResult:
        """Writes, or in a node or for skills proposes, as write_file describes."""
        place = _place(args)
        skill = not place.get("experiment") and not place.get("node") and is_skill_path(path)
        if not place.get("experiment") and (place.get("node") or skill):
            proposal = await s.json(
                "PUT",
                file_route(path),
                params={**place, "propose": "", "note": args.get("summary")},
                content=data,
            )
            return text(
                {
                    "ok": True,
                    "proposed": True,
                    "path": proposal["path"],
                    "node": proposal["node"],
                    "newFile": proposal["isNew"],
                    "note": "Proposed for review, not written yet: someone who can edit "
                    + ("the workspace" if skill else "this node")
                    + " accepts or rejects it in the editor. Tell the user.",
                }
            )
        info = await s.json("PUT", file_route(path), params=place, content=data)
        return text({"ok": True, "path": info["path"], "node": None, "experiment": place.get("experiment")})

    async def read(s: Storage, path: str, place: Mapping[str, str | None]) -> httpx.Response | None:
        """The file's bytes; None for a binary file the API redirects to the object store."""
        response = await s.call("GET", file_route(path), params=place)
        return None if response.is_redirect else response

    async def current_text(s: Storage, path: str, args: Mapping[str, Any]) -> tuple[str, str]:
        """What edit_file changes: the user's own open proposal for the file where writes are
        proposed (so edits in a row build on each other), else the file as it is."""
        place = _place(args)
        wanted = path.strip().lstrip("/")
        if not place.get("experiment") and (place.get("node") or is_skill_path(wanted)):
            me = ((await s.json("GET", "/access")).get("me") or {}).get("id")
            # With a storage token Claude's writes are the agent's; without
            # login there is none, and the API records them as the user's.
            author = "agent" if s.token else "user"
            proposals = (await s.json("GET", "/proposals", params={"node": place.get("node"), "status": "open"}))[
                "proposals"
            ]
            mine = next(
                (
                    p
                    for p in proposals
                    if me and p["path"] == wanted and p["author"] == author and p["authorId"] == me
                ),
                None,
            )
            if mine:
                content = await s.call("GET", f"/proposals/{urllib.parse.quote(mine['id'], safe='')}/content")
                return mine["path"], content.content.decode("utf-8", errors="replace")
        try:
            response = await read(s, wanted, place)
        except WorkspaceError as err:
            if err.status != 404:
                raise
            raise WorkspaceError(f"No file at {wanted}. Use write_file to create it.") from err
        if response is None or not is_text_file(wanted, response.headers.get("content-type", "")):
            raise WorkspaceError(f"{wanted} is not a text file.")
        return wanted, response.content.decode("utf-8", errors="replace")

    @tool(
        "list_nodes",
        "Show the knowledge tree: its levels (e.g. tech › module › loop › process) and the nodes the user can "
        "see, with id, number of files and the user's role (viewer can read, editor can also write files and add "
        "nodes, owner can also delete nodes). Files live at the workspace root or in a node.",
        schema({}),
    )
    @guarded
    async def list_nodes(s: Storage, args: dict[str, Any]) -> ToolResult:
        tree = await s.json("GET", "/nodes")
        levels = " › ".join(t["name"] for t in tree["types"])
        return text(f"Levels: {levels}\n" + (format_tree(tree["nodes"]) if tree["nodes"] else "(no nodes yet)"))

    @tool(
        "create_node",
        "Add a node to the knowledge tree under a parent (omit parentId for the top level). Its level is the one "
        "below the parent's.",
        schema(
            {
                "parentId": {"type": "string", "description": "Parent node id; omit for the top level."},
                "name": {"type": "string", "description": "e.g. Etch, Module 3, Endpoint control"},
            },
            "name",
        ),
    )
    @guarded
    async def create_node(s: Storage, args: dict[str, Any]) -> ToolResult:
        node = await s.json("POST", "/nodes", json_body={"parentId": args.get("parentId") or None, "name": args["name"]})
        return text({"ok": True, "id": node["id"], "name": node["name"], "type": node["type"]})

    @tool(
        "list_files",
        "List the files at the workspace root, in one knowledge node or in one experiment, with kind (note, "
        "skill, upload, artifact), size in bytes and who last wrote it.",
        schema({"node": NODE, "experiment": EXPERIMENT}),
    )
    @guarded
    async def list_files(s: Storage, args: dict[str, Any]) -> ToolResult:
        files = (await s.json("GET", "/files", params=_place(args)))["files"]
        return text(
            [
                {
                    "path": f["path"],
                    "kind": f["kind"],
                    "mime": f["mime"],
                    "size": f["size"],
                    "lastWrittenBy": f["author"],
                    "updatedAt": f["updatedAt"],
                    **({"readOnly": True} if f.get("readOnly") else {}),
                }
                for f in files
            ]
        )

    @tool(
        "read_file",
        "Read a workspace file by path (in a knowledge node or experiment when given). Each line starts with its "
        "line number and a tab, for citing lines; the numbers are not part of the file. A read returns at most "
        f"{MAX_READ_CHARS} characters; when a file is longer, the first line says which lines you got and the "
        "offset to continue from. Use offset and limit to read part of a file, e.g. the lines around a passage "
        "search_files found.",
        schema(
            {
                "path": {"type": "string", "description": "Workspace path, e.g. notes/welcome.md"},
                "offset": {
                    "type": "integer",
                    "minimum": 1,
                    "description": "Line number to start reading from (1-based). Defaults to 1.",
                },
                "column": {
                    "type": "integer",
                    "minimum": 1,
                    "description": "Character in the offset line to start from (1-based), for continuing a line "
                    "too long for one read. Defaults to 1.",
                },
                "limit": {
                    "type": "integer",
                    "minimum": 1,
                    "description": "Most lines to return. Defaults to as many as fit in one read.",
                },
                "node": NODE,
                "experiment": EXPERIMENT,
            },
            "path",
        ),
    )
    @guarded
    async def read_file(s: Storage, args: dict[str, Any]) -> ToolResult:
        path = args["path"].strip().lstrip("/")
        try:
            response = await read(s, path, _place(args))
        except WorkspaceError as err:
            return error(f"No file at {path}" if err.status == 404 else str(err))
        mime = (response.headers.get("content-type", "") if response else "").split(";")[0].strip()
        if response is None or not is_text_file(path, mime):
            return text({"path": path, "mime": mime or None, "note": "Binary file; content not readable as text."})
        content = response.content.decode("utf-8", errors="replace")
        return text(
            read_lines(path, content, offset=args.get("offset") or 1, column=args.get("column") or 1, limit=args.get("limit"))
        )

    @tool(
        "search_files",
        "Search the text and paths of every workspace file the user can read: the root, all knowledge nodes and "
        "the experiments they can see. Matches whole words (and their forms: etch finds etching), exact text "
        '(part numbers) and, when available, passages close in meaning (match: "meaning"), so describe what '
        'you\'re after in plain words. "Quotes" or -word ask for exact words only. Each result has the place to '
        "pass to read_file (node or experiment) and the passage that matched. Use it to find what the workspace "
        "already knows before answering or writing.",
        schema(
            {
                "query": {
                    "type": "string",
                    "description": 'Words to find, e.g. etch rate drift; "quotes" for a phrase, -word to exclude.',
                },
                "scope": {
                    "type": "string",
                    "description": "Knowledge node id: search only it, the nodes below it and their experiments.",
                },
                "node": {
                    "type": "string",
                    "description": "Where the user is (the context's currentNode), so nearby files rank first.",
                },
                "experiment": {
                    "type": "string",
                    "description": "The context's currentExperiment, if any, so its node's neighborhood ranks first.",
                },
                "limit": {"type": "integer", "minimum": 1, "maximum": 50, "description": "Most results (default 20)."},
            },
            "query",
        ),
    )
    @guarded
    async def search_files(s: Storage, args: dict[str, Any]) -> ToolResult:
        params = {
            "q": args["query"],
            "scope": args.get("scope") or None,
            "near": args.get("node") or None,
            "experiment": args.get("experiment") or None,
            "limit": str(args["limit"]) if args.get("limit") else None,
        }
        hits = (await s.json("GET", "/search", params=params))["results"]
        if not hits:
            return text(f"No files match {json.dumps(args['query'])}.")
        return text(
            [
                {
                    "path": h["path"],
                    "node": h["node"],
                    "experiment": h["experiment"],
                    "where": " › ".join(
                        [*(h["where"] or ["(workspace root)"])]
                        + ([f"experiment: {h['experimentTitle']}"] if h.get("experimentTitle") else [])
                    ),
                    "match": h["match"],
                    "snippet": h["snippet"] or "(matched by path)",
                    "updatedAt": h["updatedAt"],
                }
                for h in hits
            ]
        )

    @tool(
        "write_file",
        "Create or overwrite a workspace file with the COMPLETE new content (no line numbers), at the workspace "
        "root, in a knowledge node or in an experiment. Write where the user is working (the context's "
        "currentExperiment, else currentNode) unless they say otherwise; inside an experiment, never write to its "
        "node. At the root and in an experiment the file changes at once and opens for the user. In a knowledge "
        "node, and for skills (skills/<name>/... at the root), it is PROPOSED instead: the file stays as it was "
        "until someone who can edit there accepts the change (writing the same file again revises your "
        "proposal). Put new generated documents under artifacts/ (in the run, when the user is in one), unless "
        "the user asks to change an existing file. Paths starting with notes/, skills/<name>/SKILL.md, uploads/ "
        "or artifacts/ decide where the file is listed. Every write is kept as a version. Read-only files "
        "(readOnly in list_files) can't be written.",
        schema(
            {
                "path": {"type": "string", "description": "e.g. artifacts/summary.md"},
                "content": {"type": "string", "description": "The full file content (markdown for .md files)."},
                "node": NODE,
                "experiment": EXPERIMENT,
                "summary": SUMMARY,
            },
            "path",
            "content",
        ),
    )
    @guarded
    async def write_file(s: Storage, args: dict[str, Any]) -> ToolResult:
        return await store(s, args["path"], args["content"].encode("utf-8"), args)

    @tool(
        "edit_file",
        "Change part of an existing text file: replaces oldText, copied exactly from the file (without the line "
        "numbers read_file shows), with newText. Prefer this to write_file for any change to a file that already "
        "exists, even several edits in a row: it keeps the chat small. oldText must match exactly one place "
        "unless replaceAll is set, so include a few surrounding lines when a snippet repeats. Same rules as "
        "write_file: PROPOSED in a knowledge node or for skills (editing again revises your proposal), kept as a "
        "version, never on a read-only file. The result shows the changed lines.",
        schema(
            {
                "path": {"type": "string", "description": "Workspace path of the file, e.g. artifacts/page.html"},
                "oldText": {"type": "string", "description": "The exact text to replace, without line numbers."},
                "newText": {"type": "string", "description": "The replacement text (empty to delete oldText)."},
                "replaceAll": {
                    "type": "boolean",
                    "description": "Replace every occurrence of oldText instead of exactly one. Default false.",
                },
                "node": NODE,
                "experiment": EXPERIMENT,
                "summary": SUMMARY,
            },
            "path",
            "oldText",
            "newText",
        ),
    )
    @guarded
    async def edit_file(s: Storage, args: dict[str, Any]) -> ToolResult:
        path, content = await current_text(s, args["path"], args)
        try:
            edit = apply_edit(content, args["oldText"], args["newText"], bool(args.get("replaceAll")))
        except EditError as err:
            return error(str(err))
        result = await store(s, path, edit.content.encode("utf-8"), args)
        start, end = edit.lines
        changed = read_lines(
            path,
            edit.content,
            offset=max(1, start - EDIT_CONTEXT_LINES),
            limit=end - start + 1 + 2 * EDIT_CONTEXT_LINES,
            max_chars=MAX_EDIT_PREVIEW_CHARS,
        )
        plural = "" if edit.replacements == 1 else "s"
        summary = f"{edit.replacements} replacement{plural}; the first, with {EDIT_CONTEXT_LINES} lines around it:"
        return {"content": [*result["content"], {"type": "text", "text": f"{summary}\n{changed}"}]}

    @tool(
        "list_experiments",
        "List the experiments (runs) the user can see, on one knowledge node or (without node) anywhere: id, "
        "title, node (null = at the workspace root), status (draft = only its author sees it, shared, archived), "
        "state (ready, running, done, failed), author, hypothesis, params and results. Use it to compare "
        "experiments on a node.",
        schema({"node": NODE}),
    )
    @guarded
    async def list_experiments(s: Storage, args: dict[str, Any]) -> ToolResult:
        found = (await s.json("GET", "/experiments", params={"node": args.get("node") or None}))["experiments"]
        if not found:
            return text("(no experiments)")
        return text(
            [
                {
                    "id": e["id"],
                    "node": e["nodeId"],
                    "title": e["title"],
                    "status": e["status"],
                    "state": e["state"],
                    "author": e["authorName"],
                    "canChange": e["access"] == "writer",
                    "hypothesis": e["hypothesis"],
                    "params": e["params"],
                    "results": e["results"],
                    "files": e["fileCount"],
                    "forkedAt": e["forkedAt"],
                }
                for e in found
            ]
        )

    @tool(
        "update_experiment",
        "Change an experiment the user authored: title, hypothesis or params (each replaces the old value whole, "
        "so send the complete object). Sharing and archiving are the user's to do in the app.",
        schema(
            {
                "id": {"type": "string", "description": "Experiment id"},
                "title": {"type": "string"},
                "hypothesis": {"type": "string"},
                "params": {"type": "object"},
            },
            "id",
        ),
    )
    @guarded
    async def update_experiment(s: Storage, args: dict[str, Any]) -> ToolResult:
        body = {k: args[k] for k in ("title", "hypothesis", "params") if k in args}
        updated = await s.json("PATCH", f"/experiments/{urllib.parse.quote(args['id'], safe='')}", json_body=body)
        return text({"ok": True, "id": updated["id"], "status": updated["status"], "state": updated["state"]})

    @tool(
        "propose_experiment",
        "Propose an experiment's work to its knowledge node: each file the experiment changed or added (or only "
        "those in `paths`) becomes a proposed version on the node, for someone who can edit the node to accept or "
        "reject. Only when the user asks to bring an experiment's results back to its node; only its author can.",
        schema(
            {
                "experiment": {"type": "string", "description": "Experiment id"},
                "paths": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Only these files; omit for every changed file.",
                },
                "note": {"type": "string", "description": "Why these changes belong in the node, in a line or two."},
            },
            "experiment",
        ),
    )
    @guarded
    async def propose_experiment(s: Storage, args: dict[str, Any]) -> ToolResult:
        body = {"experimentId": args["experiment"]}
        body.update({k: args[k] for k in ("paths", "note") if args.get(k) is not None})
        proposals = (await s.json("POST", "/proposals", json_body=body))["proposals"]
        return text(
            {
                "ok": True,
                "proposed": [{"path": p["path"], "newFile": p["isNew"]} for p in proposals],
                "node": proposals[0]["node"] if proposals else None,
                "note": "Waiting for someone who can edit the node to accept or reject them.",
            }
        )

    return [
        list_nodes,
        create_node,
        list_files,
        read_file,
        search_files,
        write_file,
        edit_file,
        list_experiments,
        update_experiment,
        propose_experiment,
    ]


def tool_names(tools: list[SdkMcpTool[Any]]) -> list[str]:
    return [f"mcp__{SERVER_NAME}__{t.name}" for t in tools]


def server(tools: list[SdkMcpTool[Any]]):
    return create_sdk_mcp_server(SERVER_NAME, "1.0.0", tools=tools)


