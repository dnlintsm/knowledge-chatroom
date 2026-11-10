# Python chat agent

The chatroom's chat agent in Python, on the
[AG-UI adapter for the Claude Agent SDK](https://pypi.org/project/ag-ui-claude-sdk/)
(`ag_ui_claude_sdk`) and FastAPI. The app reaches it through `AGENT_URL`, as any
remote backend ([docs/remote-agent.md](../../docs/remote-agent.md)); this repo's
TypeScript agent server (`apps/agent`) keeps serving storage, skills and memory on
`LOCAL_AGENT_URL`.

It is phase 2 of moving the backend to Python (issue #169), built in steps under
issue #176. So far (step 1) it chats: the app's own tools (task board, workbench
panes, and the browser's file tools while files live only in the browser) work, and
each run tells the model where the user is. Workspace file tools over the storage API,
skills, memory, tool chips and follow-up chips come in the next steps; until then,
use the TypeScript agent for those.

## Run it

Python 3.11+ and [uv](https://docs.astral.sh/uv/), from the repository root:

```bash
uv sync --package agent-py
cd services/agent-py
uv run python -m agent_py.app        # http://127.0.0.1:9300
```

Then, in the repository's `.env`, point the app at it and restart `pnpm dev`:

```bash
AGENT_URL=http://127.0.0.1:9300
```

Claude Code needs credentials as usual (`ANTHROPIC_API_KEY`, or `ANTHROPIC_BASE_URL`
for a gateway) in this server's environment.

| Variable | Meaning |
| --- | --- |
| `CLAUDE_MODEL`, `ANTHROPIC_MODEL` | The model, chosen as the TypeScript agent does (default `claude-sonnet-5`). |
| `KNOWLEDGE_PUBLIC_KEY` | With login on: the agent server's `GET /identity/public-key`. Runs then need the app's signed `X-Knowledge-User`, and are refused when it names another user than the run's. Without login, leave it unset. |
| `AGENT_RUN_TIMEOUT_SECONDS` | Stop a run after this long (default `1800`; `0` = never). |
| `AGENT_PY_WORKDIR` | Claude Code's working folder (default: a new empty temp folder). |
| `AGENT_PY_HOST`, `AGENT_PY_PORT` | Where it listens (default `127.0.0.1:9300`). Keep it on a private network: only the Next.js server calls it. |

## How it works

- `agent_py/app.py`: `POST /agent/report` and `GET /health`. It checks who the run is
  for before the model starts.
- `agent_py/adapter.py`: `ClaudeAgentAdapter` with the chatroom's per-run handling.
  The adapter keeps one Claude session per chat and builds its options once, so the
  system prompt stays fixed and each run's `context` (open file, selection, node,
  experiment) and shared state go in a `<workspace>` note in front of the user's
  message, only when they changed (`agent_py/place.py`). The browser's
  `forwardedProps` don't reach the SDK options, so a browser can't pick the model or
  resume someone else's session. Claude Code's built-in tools are off.
- `agent_py/prompt.py`: the system prompt, the TypeScript agent's without its demo
  backend tools.

## Tests

```bash
uv run --package agent-py pytest services/agent-py
```

They swap Claude Code for a fake (`tests/conftest.py`), so they need no key.
