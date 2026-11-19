# Python chat agent

The chatroom's chat agent in Python, on the
[AG-UI adapter for the Claude Agent SDK](https://pypi.org/project/ag-ui-claude-sdk/)
(`ag_ui_claude_sdk`) and FastAPI. The app reaches it through `AGENT_URL`, as any
remote backend ([docs/remote-agent.md](../../docs/remote-agent.md)); this repo's
Python API server (`services/api-py`) serves storage, skills and memory on
`LOCAL_AGENT_URL`.

It was phase 2 of moving the backend to Python (issue #169), built in steps under
issue #176, and replaced the TypeScript agent in phase 4 (issue #264). It chats with
the app's own tools (task board, workbench panes, and the browser's file tools while
files live only in the browser), tells the model where the user is on every run, and
works on the workspace's files on the server through the storage API, including
starting and finishing runs, with the user's skills, their memory, the outside MCP
servers and tool chips, a working folder and, when allowed, skills' scripts. The
follow-up chips after each reply come from the API server's `/suggest`, so this agent
doesn't write them.

## Run it

Python 3.12+ and [uv](https://docs.astral.sh/uv/). With the app, from the repository root:

```bash
uv sync --all-packages
pnpm dev:python                      # UI :3000, Python API :8000, this agent :9300
```

`pnpm dev:python` reads the repository's `.env` for this agent too and sets the app's
`AGENT_URL` to it. To run it on its own (`pnpm dev:agent-py` does the same with the
`.env`):

```bash
cd services/agent-py
uv run python -m agent_py.app        # http://127.0.0.1:9300
```

and point the app at it in `.env` (`AGENT_URL=http://127.0.0.1:9300`) before `pnpm dev`.

With Docker, the `python-agent` profile builds `services/agent-py/Dockerfile` and runs it
beside the demo (the Claude Agent SDK brings its own Claude Code, so no Node.js):

```bash
docker compose --profile demo up --build
```

Claude Code needs credentials as usual (`ANTHROPIC_API_KEY`, or `ANTHROPIC_BASE_URL`
for a gateway) in this server's environment.

| Variable | Meaning |
| --- | --- |
| `CLAUDE_MODEL`, `ANTHROPIC_MODEL` | The model: `CLAUDE_MODEL`, else `ANTHROPIC_MODEL` (default `claude-sonnet-5`). |
| `KNOWLEDGE_PUBLIC_KEY` | With login on: the API server's `GET /identity/public-key`. Runs then need the app's signed `X-Knowledge-User`, and are refused when it names another user than the run's. Without login, leave it unset. |
| `LOCAL_AGENT_URL` | The API server, as for the app (default `http://localhost:8000`). |
| `MCP_SERVERS` | Outside MCP servers and tool chips: give it the API server's value, so the chat's "+" menu (from the API server) names the servers this agent connects to. |
| `AGENT_RUN_TIMEOUT_SECONDS` | Stop a run after this long (default `1800`; `0` = never). |
| `AGENT_PY_WORKDIR` | Where each user's working folder goes (one per user and workspace), holding their skills and the workspace copy (default: a new empty temp folder). Keep it out of this repository: Claude Code describes its working folder to the model. |
| `AGENT_WORKDIR` | `off`: no workspace copy in the working folder, and no Read/Glob/Grep or `save_file`. |
| `AGENT_WORKDIR_MAX_MB`, `AGENT_WORKDIR_MAX_FILE_MB` | The copy's size caps (default 500 and 25): smallest files first, larger ones left out. |
| `SKILL_SCRIPTS` | `on`: skills' scripts run, in Claude Code's sandbox (needs bubblewrap and socat). Set it on api-py too. |
| `SKILL_SCRIPTS_DENY_READ` | More absolute paths scripts can't read, comma-separated. |
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
- `agent_py/workspace.py`: the workspace tools (`list_nodes`, `create_node`, `list_files`, `read_file`,
  `search_files`, `write_file`, `edit_file`, `list_experiments`, `create_experiment`,
  `set_experiment_results`, `update_experiment`, `propose_experiment`). Runs start and finish through
  `POST /experiments/runs` and `POST /experiments/{id}/finish`, which record the
  chat, model, skill and tool versions in the run's report.md front matter. Each call goes to the
  storage API with the run's `X-Knowledge-Storage` token, so Claude acts for the
  signed-in user: only what they can reach, writes in a knowledge node and to skills
  as proposals, no renaming, deleting or sharing. Without login there is no token and
  the API answers as the local user, so files Claude writes show as the user's.
  `agent_py/text.py` numbers lines and applies exact edits.
- `agent_py/skills.py`: the run's skills. Each run asks the API server which skills the
  user has in this chat (`GET /skills/run`, with the run's token: built-in, hub and
  workspace skills that aren't off, with their files), writes them to the user's own
  folder under `AGENT_PY_WORKDIR` (`.claude/skills/`, only when the set changed) and
  starts there with just those skills: auto ones Claude may pick, manual ones only by
  `/name`. Only `/name` for one of them stays a command (`/clear` and the like go as
  text), and a run with `/name` gets its workspace note after the command. Each skill
  used goes to the chat as a `skill_used` event and to the usage history
  (`POST /skills/used`). `!` commands in a SKILL.md never run, and there is no shell
  unless skills' scripts are on (below).
- `agent_py/workdir.py`: the working folder. At the start of each run the user's folder gets
  `workspace/`, a read-only copy of every file they can read in the run's workspace
  (`root/`, `nodes/<tech>/<module>/...`, `experiments/<title> (<id>)/`, and `.places.json`
  mapping folders to ids and roles), fetched through the storage API with the run's
  token; only changed files are downloaded. Claude gets Read, Glob and Grep, which a
  hook confines to the folder, a prompt section about it, and `save_file` for files a
  script made there. An experiment Claude starts gets its inputs copied to
  `run-inputs/<id>/`. When the copy can't be made (or `AGENT_WORKDIR=off`), any old one
  is removed and the run has none of this.
- `agent_py/scripts.py` and `agent_py/keyproxy.py`: skills' scripts. With `SKILL_SCRIPTS=on`, a run whose skills include one with scripts
  (`needsExecution`) gets Bash in Claude Code's sandbox: no network, writes only in the
  user's run folder (not its skills or the files Claude Code reads as instructions),
  this checkout or `/app`, its home, `AGENT_PY_WORKDIR`'s other folders, the usual secret
  mounts and `SKILL_SCRIPTS_DENY_READ` (comma-separated absolute paths) unreadable. The
  Python SDK only adds to the environment Claude Code inherits, so every variable but
  the basics (`PATH` without the virtualenv, `HOME`, the locale, the model settings) is
  passed empty, and the run gets a stand-in API key that only a proxy inside agent-py
  accepts, on 127.0.0.1, which sends requests on to Anthropic with the real key. The host
  needs bubblewrap and socat (and, in a container, permission to create user
  namespaces) plus the interpreters the skills use; a run with scripts fails when the
  sandbox can't start.
- `agent_py/memory.py`: the user's memory in the chat. With the run's `X-Knowledge-Memory` token (the app
  sends one per run; memory needs `MEMORY=on` on the API server), each run asks
  `/memory/agent` for the memory section of the system prompt and the `memory_*` and
  `chats_*` tools, which run there. Changes are made with Undo until the run uses any
  other tool, then wait in the user's inbox (a `PreToolUse` hook marks the run). Each
  note read or changed goes to the chat as a `memory` event. Incognito chats and memory
  turned off get none of it.
- `agent_py/mcp.py`: the servers in `MCP_SERVERS`, read as the API server
  reads them. Each run connects to them with every tool allowed,
  leaves out a `"mode": "manual"` server unless its chip is on, and tells Claude to use
  the servers whose chips are on. For `forwardIdentity`, `storageAccess` and
  `memoryAccess` it trades the run's storage and memory tokens for the server's own at
  the API server (`POST /identity/mcp-tokens`), since it holds no `AUTH_SECRET`.
- `agent_py/prompt.py`: the system prompt.

## Tests

```bash
uv run --package agent-py pytest services/agent-py
```

They swap Claude Code for a fake (`tests/conftest.py`), so they need no key.

`pnpm test:e2e:python`, from the repository root, runs the chat in the browser against
this agent with the real Claude Code and a scripted model (`e2e/mock-anthropic.mjs`):
a reply, a browser tool and its result, a `/tldr` skill and the follow-up chips
(`e2e/python-agent.spec.ts`, [Testing](../../docs/testing.md)). CI runs it too.
