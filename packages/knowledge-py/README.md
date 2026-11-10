# knowledge-chatroom (Python)

What every Python service next to the chatroom needs, written once (issue #164):

| Module | What it does |
| --- | --- |
| `knowledge_chatroom.identity` | Checks the agent's signed `X-Knowledge-User` header with the public key (`KNOWLEDGE_PUBLIC_KEY`); Python twin of `packages/contracts/src/identity-token.ts` |
| `knowledge_chatroom.storage` | Reads and writes workspace files through the agent's storage API with the run's `X-Knowledge-Storage` token |
| `knowledge_chatroom.memory` | Runs the `memory_*` tools for the calling chat with its `X-Knowledge-Memory` token |
| `knowledge_chatroom.api` | Pydantic models of every request and answer of the agent server's API, generated from `packages/contracts/openapi/storage.yaml` (needs the `api` extra) |

A service in `services/` depends on it as a uv workspace member:

```toml
[project]
dependencies = ["knowledge-chatroom"]

[tool.uv.sources]
knowledge-chatroom = { workspace = true }
```

For the models, depend on `knowledge-chatroom[api]`, which adds pydantic:

```python
from knowledge_chatroom.api import FileList, SetSkillModeRequest

files = FileList.model_validate_json(response.text)
```

Each schema in the spec is a model or type alias of the same name. A request or answer
the spec writes inline is named after its operation: `ListChatsResponse`,
`SetSkillModeRequest`. A field named like a Python keyword ends in `_` and keeps its JSON
name as an alias (`HubDiff.from_`), so dump with `by_alias=True`.

`src/knowledge_chatroom/api.py` is generated: don't edit it. After changing the spec, run
`uv run datamodel-codegen` here (settings in `pyproject.toml`); CI runs it with `--check`.

Tests: `cd packages/knowledge-py && uv run pytest -q`. The services'
tests (`services/lab-tools`, `services/papers-mcp`) exercise it end to end.
