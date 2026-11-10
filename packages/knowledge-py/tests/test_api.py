"""knowledge_chatroom.api against the OpenAPI spec it was generated from.

The spec (packages/contracts/openapi/storage.yaml) is checked against the
running agent by the conformance suite. These tests check that the models
cover the spec, and, with API_SAMPLES set to the file the suite writes
(CONFORMANCE_SAMPLES), that the agent's real requests and answers parse into
them without losing a field.
"""

from __future__ import annotations

import json
import os
import re
from datetime import datetime
from pathlib import Path
from typing import Any

import pytest
import yaml
from pydantic import TypeAdapter

from knowledge_chatroom import api

SPEC = yaml.safe_load(
    (Path(__file__).parents[2] / "contracts" / "openapi" / "storage.yaml").read_text()
)
METHODS = ("get", "put", "post", "patch", "delete")
OPERATIONS = {
    op["operationId"]: op
    for path in SPEC["paths"].values()
    for method, op in path.items()
    if method in METHODS
}


def _ref_name(schema: dict[str, Any]) -> str | None:
    ref = schema.get("$ref", "")
    return ref.rsplit("/", 1)[-1] if ref.startswith("#/components/schemas/") else None


def _json_schema(part: dict[str, Any] | None) -> dict[str, Any] | None:
    if part and "$ref" in part:  # a shared response in components/responses
        part = SPEC["components"]["responses"][part["$ref"].rsplit("/", 1)[-1]]
    return ((part or {}).get("content") or {}).get("application/json", {}).get("schema")


def model_name(operation_id: str, status: int | None = None) -> str | None:
    """The api name for an operation's JSON request (no status) or answer."""
    op = OPERATIONS[operation_id]
    if status is None:
        schema, suffix = _json_schema(op.get("requestBody")), "Request"
    else:
        schema, suffix = _json_schema(op["responses"].get(str(status))), "Response"
    if schema is None:
        return None
    # A named schema keeps its name; an inline one is named after the operation.
    return _ref_name(schema) or operation_id[0].upper() + operation_id[1:] + suffix


def test_every_schema_has_a_model():
    missing = [name for name in SPEC["components"]["schemas"] if not hasattr(api, name)]
    assert not missing


def test_every_json_request_and_answer_has_a_model():
    names = []
    for operation_id, op in OPERATIONS.items():
        names.append(model_name(operation_id))
        names += [model_name(operation_id, int(status)) for status in op["responses"]]
    missing = sorted({name for name in names if name and not hasattr(api, name)})
    assert not missing


def test_models_parse_and_keep_fields():
    info = {
        "path": "notes/a.md",
        "kind": "note",
        "mime": "text/markdown",
        "size": 3,
        "sha256": "a" * 64,
        "updatedAt": "2026-11-10T08:00:00.000Z",
        "author": "user",
        "readOnly": False,
    }
    files = api.FileList.model_validate({"files": [info]})
    assert files.files[0].updatedAt.tzinfo is not None
    assert _same(files.model_dump(mode="json", by_alias=True, exclude_unset=True), {"files": [info]})
    with pytest.raises(ValueError):
        api.FileInfo.model_validate({**info, "kind": "spreadsheet"})


SAMPLES = os.environ.get("API_SAMPLES")


@pytest.mark.skipif(not SAMPLES, reason="API_SAMPLES (the conformance suite's CONFORMANCE_SAMPLES file) not set")
def test_real_traffic_parses():
    lines = [json.loads(line) for line in Path(SAMPLES).read_text().splitlines() if line]
    assert lines, f"{SAMPLES} is empty: did the conformance suite run with CONFORMANCE_SAMPLES?"
    problems = []
    for line in lines:
        operation_id = line["operationId"]
        is_request = "request" in line
        data = line["request"] if is_request else line["response"]
        name = model_name(operation_id, None if is_request else line["status"])
        label = f"{operation_id} {'request' if is_request else line['status']} ({name})"
        adapter = TypeAdapter(getattr(api, name))
        try:
            value = adapter.validate_json(json.dumps(data))
        except ValueError as err:
            problems.append(f"{label}: {err}")
            continue
        dumped = adapter.dump_python(value, mode="json", by_alias=True, exclude_unset=True)
        if not _same(dumped, data):
            problems.append(f"{label}: lost or changed fields\n  sent {data}\n  kept {dumped}")
    assert not problems, "\n".join(problems[:20])


_DATETIME = re.compile(r"^\d{4}-\d\d-\d\dT\d\d:\d\d")


def _same(a: Any, b: Any) -> bool:
    """Equal JSON, with timestamps compared as instants rather than as text."""
    if isinstance(a, dict) and isinstance(b, dict):
        return a.keys() == b.keys() and all(_same(a[k], b[k]) for k in a)
    if isinstance(a, list) and isinstance(b, list):
        return len(a) == len(b) and all(_same(x, y) for x, y in zip(a, b))
    if isinstance(a, str) and isinstance(b, str) and _DATETIME.match(a) and _DATETIME.match(b):
        return _instant(a) == _instant(b)
    return a == b


def _instant(text: str) -> datetime:
    return datetime.fromisoformat(text.replace("Z", "+00:00"))
