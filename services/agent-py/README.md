# Python chat agent

The chatroom's chat agent in Python, on the
[AG-UI adapter for the Claude Agent SDK](https://pypi.org/project/ag-ui-claude-sdk/)
(`ag_ui_claude_sdk`) and FastAPI. The app reaches it through `AGENT_URL`, as any
remote backend ([docs/remote-agent.md](../../docs/remote-agent.md)); this repo's
TypeScript agent server (`apps/agent`) keeps serving storage, skills and memory on
`LOCAL_AGENT_URL`.

It is phase 2 of moving the backend to Python (issue #169), built in steps under
issue #176. So far it chats with the app's own tools (task board, workbench panes,
and the browser's file tools while files live only in the browser), tells the model
where the user is on every run, and works on the workspace's files on the server
through the storage API (step 2), including starting and finishing runs, with the
user's skills (step 3) and their memory (step 4). Tool chips and follow-up chips come
in the next steps; until then, use the TypeScript agent for those.

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
| `LOCAL_AGENT_URL` | The agent server with the storage API, as for the app (default `http://localhost:8000`). |
| `AGENT_RUN_TIMEOUT_SECONDS` | Stop a run after this long (default `1800`; `0` = never). |
| `AGENT_PY_WORKDIR` | Where each user's working folder goes, holding their skills (default: a new empty temp folder). Keep it out of this repository: Claude Code describes its working folder to the model. |
| `AGENT_PY_HOST`, `AGENT_PY_PORT` | Where it listens (default `127.0.0.1:9300`). Keep it on a private network: only the Next.js server calls it. |

## How it works

- `agent_py/app.py`: `POST /agent/report` and `GET /health`. It checks who the run is
  for before the model starts.
- `agent_py/adapter.py`: `ClaudeAgentAdapter` with the chatroom's per-run handling.
  The adapter keeps one Claude session per chat and builds its options once, so the
  system prompt stays fixed and each run's `context` (open file, selection, node,
  experiment) and shared state go in a `<workspace>` note in front of the user's
  message, only when they changed (`agent_py/place.py`). A run that goes on after a
  browser tool such as `openRun` has no user message, so the note follows that tool's
  result. The browser's
  `forwardedProps` don't reach the SDK options, so a browser can't pick the model or
  resume someone else's session. Claude Code's built-in tools are off.
- `agent_py/workspace.py`: the workspace tools, with the TypeScript agent's names,
  descriptions and results (`list_nodes`, `create_node`, `list_files`, `read_file`,
  `search_files`, `write_file`, `edit_file`, `list_experiments`, `create_experiment`,
  `set_experiment_results`, `update_experiment`, `propose_experiment`;
  `apps/agent/src/storage/tools.ts`). Runs start and finish through
  `POST /experiments/runs` and `POST /experiments/{id}/finish`, which record the
  chat, model, skill and tool versions in the run's report.md front matter. Each call goes to the
  storage API with the run's `X-Knowledge-Storage` token, so Claude acts for the
  signed-in user: only what they can reach, writes in a knowledge node and to skills
  as proposals, no renaming, deleting or sharing. Without login there is no token and
  the API answers as the local user, so files Claude writes show as the user's.
  `agent_py/text.py` numbers lines and applies exact edits as the TypeScript agent does.
- `agent_py/skills.py`: the run's skills, as the TypeScript agent gives them
  (`apps/agent/src/skills/run.ts`). Each run asks the agent server which skills the
  user has in this chat (`GET /skills/run`, with the run's token: built-in, hub and
  workspace skills that aren't off, with their files), writes them to the user's own
  folder under `AGENT_PY_WORKDIR` (`.claude/skills/`, only when the set changed) and
  starts there with just those skills: auto ones Claude may pick, manual ones only by
  `/name`. Only `/name` for one of them stays a command (`/clear` and the like go as
  text), and a run with `/name` gets its workspace note after the command. Each skill
  used goes to the chat as a `skill_used` event and to the usage history
  (`POST /skills/used`). `!` commands in a SKILL.md never run and there is no shell,
  so skills' scripts don't run here (on the agent server they need `SKILL_SCRIPTS=on`).
- `agent_py/memory.py`: the user's memory in the chat, as the TypeScript agent gives it
  (`apps/agent/src/memory/run.ts`). With the run's `X-Knowledge-Memory` token (the app
  sends one per run; memory needs `MEMORY=on` on the agent server), each run asks
  `/memory/agent` for the memory section of the system prompt and the `memory_*` and
  `chats_*` tools, which run there. Changes are made with Undo until the run uses any
  other tool, then wait in the user's inbox (a `PreToolUse` hook marks the run). Each
  note read or changed goes to the chat as a `memory` event. Incognito chats and memory
  turned off get none of it.
- `agent_py/prompt.py`: the system prompt, the TypeScript agent's without its demo
  backend tools.

## Tests

```bash
uv run --package agent-py pytest services/agent-py
```

They swap Claude Code for a fake (`tests/conftest.py`), so they need no key.
