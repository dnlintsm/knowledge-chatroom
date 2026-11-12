"""The skills API and the skill hub (#190, step 7), as apps/agent/src/skills/http.ts serves them.

    GET    /skills              {skills, canSetDefaults, canPublish, hub, scripts}:
                                every skill you can use, with its modes; ?thread=<id>
                                includes that chat's
    PUT    /skills/<name>       {mode, scope?, thread?} -> that skill as you now see
                                it; scope user (default), workspace (editors) or chat
    DELETE /skills/<name>       deletes that workspace skill's folder (editors)
    GET    /skills/<name>/export  the skill as a .zip
    GET    /skills/run          {skills}: what a run gets (?thread=), files in base64;
                                storage tokens too
    POST   /skills/used         {thread, run?, skill, trigger: slash | model}; storage
                                tokens too
    POST   /skills/import       a .zip as the body (?filename=, ?replace=1) -> added
                                as skills/<name>/ (editors; 409 when it exists)

    GET    /hub?q=              {skills, canInstall, canPublish, isAdmin}
    GET    /hub/<name>          its versions and one version's SKILL.md (?version=)
    POST   /hub                 {skill} publishes that workspace skill (owners)
    PUT    /hub/<name>/install  {version?} installs or moves the pin (editors)
    DELETE /hub/<name>/install  uninstalls
    POST   /hub/<name>/fork     copies it into the workspace's skills/
    GET    /hub/<name>/diff?from=&to=   what changed between two versions
    POST   /hub/<name>/verify   {version, verified} (hub admins)
    POST   /hub/<name>/yank     {version, yanked, reason?} (publisher, hub admins)
    POST   /hub/<name>/reports  {reason, version?} (anyone who reads the workspace)
    DELETE /hub/<name>/reports?id=   dismisses a report (hub admins)

Until storage is ready here (or without a blob store), these pass through to
the TypeScript server, which also serves /skills without storage: the built-in
skills for the local user.
"""

from __future__ import annotations

import base64
import logging
import math
import re
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, Response

from .identity import identify
from .paths import js_trim, utf16_len
from .proxy import forward
from .run_report import js_number
from .skills import (
    MAX_ZIP_BYTES,
    HubConflictError,
    HubError,
    HubNotFoundError,
    InvalidModeError,
    SkillForbiddenError,
    SkillHub,
    SkillService,
    UnknownSkillError,
    parse_admins,
)
from .storage_routes import (
    ALL_METHODS,
    MAX_JSON_BYTES,
    _MalformedPath,
    decode_component,
    first_param,
    parse_json,
    raw_path,
    read_body,
)

logger = logging.getLogger("api_py")
router = APIRouter()
_OWN_PATH = re.compile(r"^/(skills|hub)(/|$)")
_NO_STORE = {"Cache-Control": "no-store"}
_ABSENT = object()


def send(status: int, body: Any) -> JSONResponse:
    return JSONResponse(body, status_code=status, headers=_NO_STORE)


def services(request: Request) -> tuple[SkillService, SkillHub]:
    """This server's skill service and hub, made with storage (the blob cache lives as long as they do)."""
    state = request.app.state
    made = getattr(state, "skills", None)
    if made is None or made[0].storage is not state.storage:
        settings = state.settings
        service = SkillService(state.storage, settings.builtin_skills_dir, settings.skill_scripts)
        made = state.skills = (
            service,
            SkillHub(state.storage, service, parse_admins(settings.hub_admins)),
        )
    return made


async def read_json(request: Request) -> Any:
    """
    The JSON body, as json() in http.ts: an empty body is {}, an array counts as
    an object, and anything else (too big, not JSON, a byte order mark) is None.
    """
    body = await read_body(request, MAX_JSON_BYTES)
    if body is None:
        return None
    try:
        value = parse_json(body.decode("utf-8", errors="replace") or "{}")
    except ValueError:
        return None
    if isinstance(value, list):
        return {}  # no properties to read
    return value if isinstance(value, dict) else None


_DECIMAL = re.compile(r"[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?")
_PREFIXED = re.compile(r"0([xX][0-9a-fA-F]+|[oO][0-7]+|[bB][01]+)")


def js_to_number(value: Any) -> float:
    """Number(value), for what JSON and query strings hold."""
    if isinstance(value, bool):
        return 1.0 if value else 0.0
    if isinstance(value, int | float):
        return float(value)
    if isinstance(value, list):
        return js_to_number(",".join(_js_string(v) for v in value))
    if not isinstance(value, str):
        return math.nan
    text = js_trim(value)
    if text == "":
        return 0.0
    if text in ("Infinity", "+Infinity", "-Infinity"):
        return -math.inf if text[0] == "-" else math.inf
    if _PREFIXED.fullmatch(text):
        return float(int(text, 0))
    if _DECIMAL.fullmatch(text):
        return float(text)
    return math.nan


def _js_string(value: Any) -> str:
    """String(value) of an array element, as Array.prototype.join writes it."""
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int | float):
        return js_number(value)
    if isinstance(value, list):
        return ",".join(_js_string(v) for v in value)
    if isinstance(value, dict):
        return "[object Object]"
    return str(value)


def version(value: Any) -> int | None:
    """A version given, or None when there is none; HubError when it isn't a whole number from 1."""
    if value is None or value is _ABSENT or value == "":
        return None
    n = js_to_number(value)
    if not math.isfinite(n) or n != int(n) or n < 1:
        raise HubError("version must be a positive whole number")
    return int(n)


def required(value: Any, what: str = "version") -> int:
    n = version(value)
    if n is None:
        raise HubError(f"Say which {what}")
    return n


@router.api_route("/skills", methods=ALL_METHODS, include_in_schema=False)
@router.api_route("/skills/{rest:path}", methods=ALL_METHODS, include_in_schema=False)
@router.api_route("/hub", methods=ALL_METHODS, include_in_schema=False)
@router.api_route("/hub/{rest:path}", methods=ALL_METHODS, include_in_schema=False)
async def skills_route(request: Request) -> Response:
    path = raw_path(request)
    if (
        not _OWN_PATH.match(path)
        or not await request.app.state.storage_ready()
        or request.app.state.storage.blobs is None
    ):
        return await forward(request, request.app.state.http)
    is_hub = path == "/hub" or path.startswith("/hub/")
    try:
        storage = request.app.state.storage
        # Only what a run needs takes the run's storage token (outside agents):
        # reading its skills and noting a use. Never another method on those paths
        # (PUT or DELETE /skills/run would change or delete a skill named "run").
        bare = path.removesuffix("/")
        for_run = (request.method == "GET" and bare == "/skills/run") or (
            request.method == "POST" and bare == "/skills/used"
        )
        principal = await identify(
            request, storage.access, request.app.state.settings.auth_secret, storage_tokens=for_run
        )
        if principal is None:
            return send(401, {"error": "Sign in first"})
        try:
            parts = [
                decode_component(p)
                for p in path[len("/hub" if is_hub else "/skills") :].split("/")
                if p
            ]
        except _MalformedPath:
            return send(400, {"error": "Invalid skill name"})
        if len(parts) > 2:
            return send(404, {"error": "Not found"})
        skills, hub = services(request)
        route = route_hub if is_hub else route_skills
        return await route(request, skills, hub, principal.user_id, parts)
    except (InvalidModeError, HubError) as err:
        return send(400, {"error": str(err)})
    except (UnknownSkillError, HubNotFoundError) as err:
        return send(404, {"error": str(err)})
    except SkillForbiddenError as err:
        return send(403, {"error": str(err)})
    except HubConflictError as err:
        return send(409, {"error": str(err)})
    except Exception:
        logger.exception("[skills] request failed")
        return send(500, {"error": "Skills request failed"})


def _thread(request: Request) -> str | None:
    return first_param(request, "thread") or None


def _short_string(value: Any) -> bool:
    return isinstance(value, str) and utf16_len(value) <= 200


async def route_skills(
    request: Request, skills: SkillService, hub: SkillHub, user_id: str, parts: list[str]
) -> Response:
    method = request.method
    name, action = (parts + [None, None])[:2]
    if method == "GET" and name == "run" and not action:
        run = await skills.for_run(user_id, _thread(request))
        return send(
            200,
            {
                "skills": [
                    {
                        "name": skill.name,
                        "mode": mode,
                        "source": skill.source,
                        "userInvocable": skill.user_invocable,
                        "needsExecution": skill.needs_execution,
                        "files": [
                            {"path": f.path, "content": base64.b64encode(f.data).decode("ascii")}
                            for f in skill.files
                        ],
                    }
                    for skill, mode in run
                ]
            },
        )
    if method == "POST" and name == "used" and not action:
        given = await read_json(request) or {}
        thread, run_id, skill, trigger = (
            given.get(k, _ABSENT) for k in ("thread", "run", "skill", "trigger")
        )
        if (
            not _short_string(thread)
            or not thread
            or (run_id is not _ABSENT and not _short_string(run_id))
            or not isinstance(skill, str)
            or not skill
            or trigger not in ("slash", "model")
        ):
            return send(400, {"error": "Say {thread, run?, skill, trigger: slash | model}"})
        found = await skills.find(user_id, skill)
        if found is None:
            return send(404, {"error": f"No skill named {skill}"})
        use = {"skill": found.name, "source": found.source, "trigger": trigger}
        await skills.record(
            user_id, thread, "" if run_id is _ABSENT else run_id, found.name, found.source, trigger
        )
        return send(200, use)
    if method == "GET" and not name:
        return send(200, await skills.list(user_id, _thread(request)))
    if method == "POST" and name == "import" and not action:
        data = await read_body(request, MAX_ZIP_BYTES)
        if data is None:
            return send(
                413, {"error": f"The .zip may be at most {MAX_ZIP_BYTES // 1024 // 1024} MB"}
            )
        replace = (first_param(request, "replace") or "") in ("1", "true")
        imported = await hub.import_zip(
            user_id, data, replace=replace, filename=first_param(request, "filename")
        )
        return send(201, imported)
    if method == "GET" and name and action == "export" and len(parts) == 2:
        zipped = await hub.export_zip(user_id, name)
        headers = {**_NO_STORE, "Content-Disposition": f'attachment; filename="{name}.zip"'}
        return Response(zipped, media_type="application/zip", headers=headers)
    if method == "PUT" and name and not action:
        given = await read_json(request)
        if given is None:
            return send(400, {"error": "Invalid JSON body"})
        thread = given.get("thread")
        scope = given.get("scope")
        return send(
            200,
            await skills.set_mode(
                user_id,
                name,
                given.get("mode", _ABSENT),
                "user" if scope is None else scope,
                thread if isinstance(thread, str) else None,
            ),
        )
    if method == "DELETE" and name and not action:
        return send(200, await hub.delete_skill(user_id, name))
    return send(405, {"error": "Method not allowed"})


async def route_hub(
    request: Request, skills: SkillService, hub: SkillHub, user_id: str, parts: list[str]
) -> Response:
    method = request.method
    name, action = (parts + [None, None])[:2]
    if method == "GET" and not name:
        return send(200, await hub.list(user_id, first_param(request, "q") or ""))
    if method == "POST" and not name:
        given = await read_json(request)
        if given is None or not isinstance(given.get("skill"), str):
            return send(400, {"error": "Say which skill: {skill}"})
        return send(201, await hub.publish(user_id, given["skill"]))
    if method == "GET" and name and not action:
        return send(200, await hub.detail(user_id, name, version(first_param(request, "version"))))
    if name and action == "install" and len(parts) == 2:
        if method == "PUT":
            given = await read_json(request)
            if given is None:
                return send(400, {"error": "Invalid JSON body"})
            return send(200, await hub.install(user_id, name, version(given.get("version"))))
        if method == "DELETE":
            if not await hub.uninstall(user_id, name):
                return send(404, {"error": f"{name} isn't installed"})
            return send(200, {"name": name, "installed": None})
    if method == "POST" and name and action == "fork" and len(parts) == 2:
        return send(201, await hub.fork(user_id, name))
    if method == "GET" and name and action == "diff":
        before = required(first_param(request, "from"), "version to compare from")
        after = required(first_param(request, "to"), "version to compare to")
        return send(200, await hub.diff(user_id, name, before, after))
    if method == "POST" and name and action in ("verify", "yank"):
        given = await read_json(request)
        if given is None:
            return send(400, {"error": "Invalid JSON body"})
        v = required(given.get("version"))
        if action == "verify":
            return send(200, await hub.verify(user_id, name, v, given.get("verified") is not False))
        reason = given.get("reason")
        return send(
            200,
            await hub.yank(
                user_id,
                name,
                v,
                given.get("yanked") is not False,
                reason if isinstance(reason, str) else None,
            ),
        )
    if name and action == "reports":
        if method == "POST":
            given = await read_json(request)
            if given is None:
                return send(400, {"error": "Invalid JSON body"})
            return send(
                201,
                await hub.report(user_id, name, given.get("reason"), version(given.get("version"))),
            )
        if method == "DELETE":
            return send(
                200, await hub.dismiss_report(user_id, name, first_param(request, "id") or "")
            )
    return send(405, {"error": "Method not allowed"})
