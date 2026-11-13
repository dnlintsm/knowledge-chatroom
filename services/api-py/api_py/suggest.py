"""Follow-up suggestions for the chat, as apps/agent/src/suggest.ts makes them (issue #190, step 9).

CopilotKit's dynamic suggestions run a provider agent with a forced
`copilotkitSuggest` tool call. `POST /suggest` answers it with one plain
Messages API call on a small model: it reads the conversation and the
workspace context the browser sends and streams back just that tool call as
AG-UI events. Nothing is stored and no tools run.

The events are written as @ag-ui/encoder writes them: `data: <JSON>` lines,
with the Content-Type it picks from the Accept header (the AG-UI protobuf type
when Accept prefers it, though the body is the same text either way).
"""

from __future__ import annotations

import logging
import math
import re
import uuid
from typing import Any

from .llm import CreateMessage, suggestions_model
from .paths import JS_SPACE, js_trim
from .run_report import js_json, js_number, js_order
from .text_index import from_units, to_units

logger = logging.getLogger("api_py")

SUGGEST_TOOL = "copilotkitSuggest"
AGUI_MEDIA_TYPE = "application/vnd.ag-ui.event+proto"

# Enough of the conversation and workspace to suggest from, without paying for all of it.
MAX_TRANSCRIPT_CHARS = 12_000
MAX_MESSAGE_CHARS = 2_000
MAX_CONTEXT_CHARS = 6_000

SYSTEM = f"""You suggest what the user might ask Claude next in Knowledge Chatroom. It is a workspace where Claude reads and writes the user's files, works on experiment runs and their xDOE reports, keeps a knowledge tree (technology, module, loop, process) with experiments on its nodes, searches the workspace by words and by meaning, and runs skills. Your suggestions appear as chips under the chat; clicking one sends its message as the user.

- Base them on the conversation and the workspace context: name the actual files, runs, experiments and findings.
- Offer natural next steps from what Claude just did (go deeper, check it, compare, save it as a file, propose it for review), never a repeat of it.
- Only things Claude can do here: no email, calendar, web browsing or outside services.
- title: at most 5 words. message: the complete request in the user's own voice, one or two sentences.
- Call the {SUGGEST_TOOL} tool once."""

_MISSING = object()


def js_string(value: Any = _MISSING) -> str:
    """String(value) for JSON values (and a missing one, `undefined`)."""
    if value is _MISSING:
        return "undefined"
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int | float):
        return js_number(value)
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        return ",".join("" if v is None else js_string(v) for v in value)
    return "[object Object]"


def clip(text: str, most: int) -> str:
    """
    clip in suggest.ts: at most `most` UTF-16 units, then "…". A character cut
    in two ends as U+FFFD, where JavaScript sends the API its lone half.
    """
    units = to_units(text)
    return from_units(units[:most]) + "…" if len(units) > most else text


def text_of(content: Any) -> str:
    """A string, or the text parts' text."""
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    texts = (
        part["text"] if isinstance(part, dict) and isinstance(part.get("text"), str) else ""
        for part in content
    )
    return "\n".join(t for t in texts if t)


def _tool_name(call: Any) -> str:
    """call.function.name as Array.join writes it (null and undefined as "")."""
    function = call.get("function") if isinstance(call, dict) else None
    name = function.get("name", _MISSING) if isinstance(function, dict) else _MISSING
    return "" if name is _MISSING or name is None else js_string(name)


def _line(message: Any) -> str | None:
    if not isinstance(message, dict):
        return None
    role = message.get("role")
    if role == "user":
        return f"User: {clip(text_of(message.get('content')), MAX_MESSAGE_CHARS)}"
    if role == "assistant":
        said = text_of(message.get("content"))
        calls = message.get("toolCalls")
        used = [_tool_name(c) for c in calls] if isinstance(calls, list) else []
        parts = [
            f"Claude: {clip(said, MAX_MESSAGE_CHARS)}" if said else "",
            f"(Claude used {', '.join(used)})" if used else "",
        ]
        return "\n".join(p for p in parts if p) or None
    # Tool results, system and other messages: the calls above say enough.
    return None


def transcript(messages: list[Any]) -> str:
    """The newest lines of the conversation that fit."""
    lines: list[str] = []
    size = 0
    for message in reversed(messages):
        text = _line(message)
        if not text:
            continue
        length = len(to_units(text))
        if size + length > MAX_TRANSCRIPT_CHARS and lines:
            break
        lines.insert(0, text)
        size += length
    return "\n\n".join(lines)


def _request(message: Any) -> str:
    """
    CopilotKit's request is the last user message. Its list of the browser's
    tools (Claude's, not the user's) is long and the system prompt covers what
    Claude can do, so it is dropped.
    """
    content = message.get("content") if isinstance(message, dict) else None
    kept = [
        line
        for line in text_of(content).split("\n")
        if not line.startswith("The user has the following tools available:")
    ]
    return js_trim("\n".join(kept))


def _clip_any(value: Any, most: int) -> Any:
    return clip(value, most) if isinstance(value, str) else value


def _context(item: Any) -> str:
    item = item if isinstance(item, dict) else {}
    description = _clip_any(item.get("description", _MISSING), 300)
    value = _clip_any(item.get("value", _MISSING), MAX_CONTEXT_CHARS)
    # JSON.stringify(undefined) is undefined, which the template writes as such.
    quoted = "undefined" if description is _MISSING else js_json(description)
    return f"<context description={quoted}>\n{js_string(value)}\n</context>"


def suggest_prompt(given: dict[str, Any]) -> dict[str, Any] | None:
    """The Messages API request's system, user text and tool, or None when `given` doesn't ask for suggestions."""
    tools = given.get("tools")
    tool = next(
        (
            t
            for t in (tools if isinstance(tools, list) else [])
            if isinstance(t, dict) and t.get("name") == SUGGEST_TOOL
        ),
        None,
    )
    messages = given.get("messages")
    messages = messages if isinstance(messages, list) else []
    last = messages[-1] if messages else None
    if tool is None or not isinstance(last, dict) or last.get("role") != "user":
        return None
    contexts = given.get("context")
    context = "\n".join(_context(c) for c in (contexts if isinstance(contexts, list) else []))
    parts = [
        f"<conversation>\n{transcript(messages[:-1]) or '(empty)'}\n</conversation>",
        f"<workspace>\n{context}\n</workspace>" if context else "",
        _request(last),
    ]
    spec: dict[str, Any] = {"name": SUGGEST_TOOL}
    # Undefined fields are left out of the request, as JSON.stringify leaves them out.
    if "description" in tool:
        spec["description"] = tool["description"]
    if "parameters" in tool:
        spec["input_schema"] = tool["parameters"]
    return {"system": SYSTEM, "user": "\n\n".join(p for p in parts if p), "tool": spec}


def _truthy(value: Any) -> bool:
    """JavaScript's truthiness, for JSON values."""
    if value is None or value is False:
        return False
    if isinstance(value, int | float):
        return value != 0 and not (isinstance(value, float) and math.isnan(value))
    if isinstance(value, str):
        return value != ""
    return True


def _started(given: dict[str, Any]) -> dict[str, Any]:
    event: dict[str, Any] = {"type": "RUN_STARTED"}
    for key in ("threadId", "runId"):
        if key in given:
            event[key] = given[key]
    return event


async def suggest(given: dict[str, Any], create: CreateMessage) -> list[dict[str, Any]]:
    """The AG-UI events answering `given`: one copilotkitSuggest tool call, or a RUN_ERROR."""
    started = _started(given)
    prompt = suggest_prompt(given)
    if prompt is None:
        return [started, {"type": "RUN_ERROR", "message": f"Expected a {SUGGEST_TOOL} request"}]
    try:
        response = await create(
            {
                "model": suggestions_model(),
                "max_tokens": 800,
                "system": prompt["system"],
                "messages": [{"role": "user", "content": prompt["user"]}],
                "tools": [prompt["tool"]],
                "tool_choice": {"type": "tool", "name": SUGGEST_TOOL},
            }
        )
        content = response.get("content") if isinstance(response, dict) else None
        call = next(
            (
                b
                for b in (content if isinstance(content, list) else [])
                if isinstance(b, dict)
                and b.get("type") == "tool_use"
                and b.get("name") == SUGGEST_TOOL
            ),
            None,
        )
        args = js_order(call.get("input")) if call else None
        if not _truthy(args):
            raise ValueError("the model didn't call the suggestion tool")
    except Exception as err:  # every failure is the chips' RUN_ERROR
        message = str(err)
        logger.error("[suggest] no suggestions: %s", message)
        return [started, {"type": "RUN_ERROR", "message": message}]

    tool_call_id = str(uuid.uuid4())
    finished: dict[str, Any] = {**started, "type": "RUN_FINISHED"}
    return [
        started,
        {
            "type": "TOOL_CALL_START",
            "toolCallId": tool_call_id,
            "toolCallName": SUGGEST_TOOL,
            "parentMessageId": str(uuid.uuid4()),
        },
        {"type": "TOOL_CALL_ARGS", "toolCallId": tool_call_id, "delta": well_formed(js_json(args))},
        {"type": "TOOL_CALL_END", "toolCallId": tool_call_id},
        finished,
    ]


_LONE_SURROGATE = re.compile("[\ud800-\udfff]")


def well_formed(text: str) -> str:
    """JSON.stringify's output for lone surrogates: escaped, so the text encodes as UTF-8."""
    return _LONE_SURROGATE.sub(lambda m: f"\\u{ord(m.group(0)):04x}", text)


def encode_sse(event: dict[str, Any]) -> str:
    """encodeSSE in @ag-ui/encoder (these events have no optional nulls to leave out)."""
    return f"data: {well_formed(js_json(event))}\n\n"


# The Accept negotiation @ag-ui/encoder does (preferredMediaTypes, from the negotiator package).
_MEDIA_TYPE = re.compile(
    rf"^[{JS_SPACE}]*([^{JS_SPACE}/;]+)/([^;{JS_SPACE}]+)[{JS_SPACE}]*(?:;(.*))?\Z"
)
_JS_FLOAT = re.compile(rf"^[{JS_SPACE}]*([+-]?(?:Infinity|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?))")


def _parse_float(text: str) -> float:
    """parseFloat: the longest number at the start, else NaN."""
    match = _JS_FLOAT.match(text)
    return float(match.group(1).replace("Infinity", "inf")) if match else math.nan


def _split(text: str, sep: str) -> list[str]:
    """Split on `sep` outside double quotes, as splitMediaTypes and splitParameters do."""
    pieces = text.split(sep)
    result = [pieces[0]]
    for piece in pieces[1:]:
        if result[-1].count('"') % 2 == 0:
            result.append(piece)
        else:
            result[-1] += sep + piece
    return result


def _media_type(text: str, index: int) -> dict[str, Any] | None:
    match = _MEDIA_TYPE.match(text)
    if not match:
        return None
    params: dict[str, str] = {}
    q = 1.0
    if match.group(3):
        for raw in _split(match.group(3), ";"):
            pair = js_trim(raw)
            key, _, val = pair.partition("=")
            key = key.lower()
            if len(val) >= 1 and val[0] == '"' and val[-1] == '"':
                val = val[1:-1]
            if key == "q":
                q = _parse_float(val)
                break
            params[key] = val
    return {"type": match.group(1), "subtype": match.group(2), "params": params, "q": q, "i": index}


def _or(*values: float) -> float:
    """`a || b || c` for numbers: the first that isn't 0 or NaN, else the last."""
    for value in values[:-1]:
        if value != 0 and not math.isnan(value):
            return value
    return values[-1]


def accepts_protobuf(accept: str | None) -> bool:
    """Whether the encoder picks AG-UI protobuf for this Accept header (None: the header is missing)."""
    given = "text/event-stream" if accept is None else accept
    if not given:
        return False
    accepted = [
        m for i, raw in enumerate(_split(given, ",")) if (m := _media_type(js_trim(raw), i))
    ]
    kind, subtype = AGUI_MEDIA_TYPE.split("/")
    best = {"o": -1.0, "q": 0.0, "s": 0.0}
    for spec in accepted:
        s = 0
        if spec["type"].lower() == kind:
            s |= 4
        elif spec["type"] != "*":
            continue
        if spec["subtype"].lower() == subtype:
            s |= 2
        elif spec["subtype"] != "*":
            continue
        params = spec["params"]
        if params:
            if not all(v == "*" or v.lower() == "" for v in params.values()):
                continue
            s |= 1
        found = {"o": float(spec["i"]), "q": spec["q"], "s": float(s)}
        if _or(best["s"] - found["s"], best["q"] - found["q"], best["o"] - found["o"]) < 0:
            best = found
    return best["q"] > 0
