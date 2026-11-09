# knowledge-chatroom (Python)

What every Python service next to the chatroom needs, written once (issue #164):

| Module | What it does |
| --- | --- |
| `knowledge_chatroom.identity` | Checks the agent's signed `X-Knowledge-User` header with the public key (`KNOWLEDGE_PUBLIC_KEY`); Python twin of `packages/contracts/src/identity-token.ts` |
| `knowledge_chatroom.storage` | Reads and writes workspace files through the agent's storage API with the run's `X-Knowledge-Storage` token |
| `knowledge_chatroom.memory` | Runs the `memory_*` tools for the calling chat with its `X-Knowledge-Memory` token |

A service in `services/` depends on it as a uv workspace member:

```toml
[project]
dependencies = ["knowledge-chatroom"]

[tool.uv.sources]
knowledge-chatroom = { workspace = true }
```

Tests: `cd packages/knowledge-py && uv run pytest -q`. The services'
tests (`services/lab-tools`, `services/papers-mcp`) exercise it end to end.
