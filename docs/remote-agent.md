# Remote agent backend

The chat pane can talk to an agent that runs in a separate backend (for example
Python with `ag_ui_claude_sdk`) instead of this repository's own Claude agent
(`agent/`). This page is the contract between the two: what the app sends, and what the
backend has to do.

## Turning it on

| Variable (Next.js server) | Meaning |
| --- | --- |
| `AGENT_URL` | The backend's base URL. Set, every chat run is posted to `${AGENT_URL}/agent/report`, and this repo's own Claude agent is off. Unset, the chat uses this repo's agent. |
| `LOCAL_AGENT_URL` | This repo's agent server (default `http://localhost:8000`). It always serves storage (`/files`, `/nodes`, `/experiments`, `/search`, `/proposals`, `/access`), skills and the skill hub, so keep running it with storage. Before this change `AGENT_URL` held this address. |

With `AGENT_URL` set:

- **Chat**: runs go to the backend (`src/lib/agent-target.ts`, `src/agent.ts`).
- **Follow-up chips**: off. This repo's `/suggest` isn't used, so the chat keeps its
  first-round chips.
- **This repo's agent server**: when it sees `AGENT_URL` too (in development both read the
  same `.env`), it turns its own chat routes off (`POST /` and `POST /suggest` answer 404) and
  serves storage and skills only.
- **Skills**: the Skills view and the `/` menu still list this repo's skills, but they
  don't reach the backend. A message such as `/tldr RF power` arrives as plain text.
- **The browser**: works the same. It still talks only to the Next.js app (`/api/copilotkit`).

The variable names come from the code (`src/lib/agent-target.ts`). The backend is called only
by the Next.js server, never by the browser. Keep it on a private network like the agent port.

## The request

```
POST ${AGENT_URL}/agent/report
Content-Type: application/json
Accept: text/event-stream
X-Knowledge-User: v1.<payload>.<signature>     (only with login)
```

The body is an AG-UI `RunAgentInput`, and the answer is an AG-UI event stream (server-sent
events), as any AG-UI agent serves it. `add_claude_fastapi_endpoint(app, adapter,
path="/agent/report")` does both. The fields of the body:

| Field | What it holds |
| --- | --- |
| `threadId` | The chat. It stays the same for every run of one conversation; **New chat** starts another. |
| `runId` | This run. |
| `messages` | The whole conversation so far, including tool calls and their results. |
| `tools` | The browser's tools (below). The model may call them, and the browser runs them. |
| `context` | What the user sees: the open file with numbered lines, the selection, the file list, the focused run and its report (below). |
| `state` | Shared state, e.g. `todos` for the task board. |
| `forwardedProps.knowledge_chatroom` | Who the user is and where they are (below). |

`forwardedProps` can also carry CopilotKit's own keys, e.g. `a2uiCatalogAvailable`.

### `forwardedProps.knowledge_chatroom`

Sent with every run, the first one of a chat included. The browser fills in the place
(`src/components/workspace/use-chatroom-props.ts`). The Next.js server then sets `user`
from the signed-in session (`src/agent.ts`), replacing anything the browser sent. Types:
`src/lib/chatroom-props.ts`.

```json
{
  "version": 2,
  "user": {
    "id": "https://login.example.com/realms/knowledge|8f2c…",
    "email": "ana@example.com",
    "name": "Ana",
    "signed_in": true
  },
  "storage": "server",
  "node": {
    "id": "6d0e…", "name": "Endpoint control", "type": "loop",
    "path": [
      { "id": "1a2b…", "name": "Etch", "type": "tech" },
      { "id": "3c4d…", "name": "Module 3", "type": "module" },
      { "id": "6d0e…", "name": "Endpoint control", "type": "loop" }
    ]
  },
  "experiment": {
    "id": "9f8e…", "node_id": "6d0e…", "title": "Lower RF power, 40 W",
    "status": "draft", "state": "done", "can_change": true, "report": "report.md"
  },
  "selected_path": "report.md"
}
```

| Key | Meaning |
| --- | --- |
| `version` | `2`. Raised when a field changes meaning or goes away; new fields may appear without it. Version 2 dropped `run_dir`: a run is now an experiment. |
| `user.id` | The login's stable id, `"<issuer>|<subject>"` from OpenID Connect. Without login (`AUTH_MODE=local`) it is `"local"` with `signed_in: false`: one built-in user who owns everything. `user` is `null` when the server couldn't tell who the run is for; refuse such runs. |
| `storage` | `"server"`: files live in the storage API on `LOCAL_AGENT_URL`. `"local"`: only in the user's browser, so only the browser's file tools can reach them. `"loading"`: the workspace hadn't loaded yet. |
| `node` | The knowledge node the user is in, with `path` from the top level down to it. `null` = the workspace root. |
| `experiment` | The experiment (run) the user is working in, a sandbox on `node` with its own copy of the node's files, or at the workspace root (`node_id` null). When set, file work belongs here, not in the node. `state` is how far the run got (`ready`, `running`, `done`, `failed`), `report` its report's path in it (`null` until it has one), and `can_change` is false when the user isn't its author or it's archived. |
| `selected_path` | The file open in the middle pane. `null` when a non-file tab is open, such as the task board. |

Paths are relative to the place: the experiment when there is one, else the node, else the
workspace root. That is how the storage API (`/files/<path>?node=` or `?experiment=`) and file
references (below) name files.

**Trust**: the browser's place values are hints for the run. Use them to choose where to
look, but enforce access with the user, as the storage API does. `user` is set by the
Next.js server. Trust it only if the backend can't be reached by anyone but that server;
otherwise verify `X-Knowledge-User` (next section) and check that it names the same user.

### `X-Knowledge-User`

Sent only with login on (`AUTH_SECRET` set). It is signed by the Next.js app with
`AUTH_SECRET` and valid for 5 minutes:

```
v1.<base64url JSON {sub, email, name, exp}>.<base64url HMAC-SHA256 of "v1.<payload>">
```

- **Verifying it**: `examples/python-agent/lab_tools/identity.py` is a Python verifier. Call
  `verify(token, secret, audience=None)`: the app's header has no `aud`. `sub` is the same
  value as `user.id`.
- **Calling this repo's storage API**: the same header works there, at `LOCAL_AGENT_URL`, on
  the private network, for its 5 minutes. A change made this way is recorded as made by the
  user, not as Claude's.

## What the backend must do

1. **Serve the route.** Accept `POST /agent/report` and stream AG-UI events: `RUN_STARTED`
   first, then `RUN_FINISHED`, or `RUN_ERROR` with a message the chat can show. On a failure
   answer with `RUN_ERROR`, not a broken stream.
2. **Check the user.** With login on, refuse runs without a valid `X-Knowledge-User`, or
   with `user` null.
3. **Pass the browser's tools through.** Offer every tool in `tools` to the model. When the
   model calls one, end the run with that tool call; the browser runs it and starts the next
   run with the result as a `tool` message. `ag_ui_claude_sdk` does this as
   `mcp__ag_ui__<name>`. The browser's tools are:
   - **Workbench**: `openWorkspaceFile`, `openTaskBoard`, `showPane`, `hidePane`, `listRuns`,
     `openRun`, `listActions`, `runAction`.
   - **Files**, only while `storage` is `"local"`: `listWorkspaceFiles`, `readWorkspaceFile`,
     `writeWorkspaceFile`.
   - **Demo UI**: the chart components, the meeting picker and `toggleTheme`.
4. **Give the model each run's context.** Its workspace entry has the open file (each line
   starts with its line number and a tab), the selection, the files where the user is, `run`
   with its report, and `currentNode`/`currentExperiment`. It changes between runs of one chat
   as the user opens files and moves around, so the model must see the current one on every
   run (see the notes on `ag_ui_claude_sdk` below).
5. **Bring file tools when `storage` is `"server"`.** The browser's file tools are off then,
   so the model needs the backend's own. Use this repo's storage API with the user's header,
   or your own access to the same Postgres and S3 store. Keep these rules:
   - **Writes in a knowledge node are proposals**: `PUT /files/<path>?node=<id>&propose`, so
     the node's editors review them.
   - **Writes in an experiment or at the root** change the file directly.
   - **Read-only files can't be written.**
   - **Experiments**: inside one, write only there, never to its node.

   `agent/src/storage/tools.ts` is this repo's version, to copy from.
6. **Cite files the way the chat can open them.** A Markdown link to the file's path in the
   place, with GitHub-style lines: `[report.md:12-18](report.md#L12-L18)`.
   The chat opens it in the middle pane (`src/components/workspace/file-refs.ts`). Teach it in
   the system prompt, as `agent/src/agent.ts` does, and number lines in file content your
   tools return, the same way. Links to working-folder copies or other places show greyed out.
7. **Optional**: report each skill a run uses as an AG-UI `CUSTOM` event named `skill_used`
   (`{skill, source, trigger}`), as this repo's agent does, to show it under the chat input.

## With `ag_ui_claude_sdk` (Python)

`ClaudeAgentAdapter` keeps one Claude session per `threadId`. It builds that session's
options once, with `build_options(input_data)`, on the thread's first run (and again only
if the session is restarted). So that first run, which already carries
`knowledge_chatroom`, is where to set the session up for the user and place:

```python
import os

from fastapi import Depends, FastAPI, HTTPException, Request
from ag_ui_claude_sdk import ClaudeAgentAdapter, add_claude_fastapi_endpoint

from identity import HEADER, verify  # examples/python-agent/lab_tools/identity.py

PROPS = "knowledge_chatroom"
AUTH_SECRET = os.environ.get("AUTH_SECRET")  # the app's; unset without login


def require_user(request: Request):
    # With login on (AUTH_SECRET set), only runs the Next.js app signed get through.
    if AUTH_SECRET and not verify(request.headers.get(HEADER, ""), AUTH_SECRET, audience=None):
        raise HTTPException(401, "Sign in first")


class ReportAdapter(ClaudeAgentAdapter):
    def build_options(self, input_data=None, thread_id=None, **kwargs):
        options = super().build_options(input_data, thread_id=thread_id, **kwargs)
        chatroom = ((input_data.forwarded_props or {}) if input_data else {}).get(PROPS) or {}
        # Your code: tools that act for this user in this place, and the prompt
        # lines saying where they are and how to cite files.
        options.mcp_servers = {**(options.mcp_servers or {}), "workspace": workspace_tools(chatroom)}
        options.system_prompt = f"{options.system_prompt or ''}\n\n{place_prompt(chatroom)}"
        return options


app = FastAPI()
add_claude_fastapi_endpoint(
    app,
    ReportAdapter(name="report", options={"model": "claude-sonnet-5"}),
    path="/agent/report",
    dependencies=[Depends(require_user)],
)
```

Notes (checked against `ag_ui_claude_sdk` 0.2.2):

- **The warning is expected.** The adapter applies only whitelisted `forwarded_props` keys
  (`ALLOWED_FORWARDED_PROPS`) as SDK options. It logs "Ignoring non-whitelisted
  forwarded_prop" for `knowledge_chatroom` (and `a2uiCatalogAvailable`) and otherwise leaves
  them alone; read them yourself as above.
- **Options, and with them `context`, are built once per thread.** The adapter appends
  `context` (and `state`) to the system prompt inside `build_options`, so later runs of the
  same chat don't show the model the file the user has open now, their new selection or a
  new place. Each run's `forwardedProps` and `context` are current, though. Bring them to the
  model per run: for example override `run()` to put a short "the user now has … open"
  note, built from this run's `context` and `knowledge_chatroom`, in front of the last user
  message (this repo's `WorkspaceAgentAdapter.run` rewrites that message in the same way for
  slash commands).
- **Tools should take the place as a parameter**, as `agent/src/storage/tools.ts` does with
  `node`/`experiment`, rather than fix it when the session starts: the user can move to
  another node, experiment or run in the middle of a chat.
- **The tool names change.** Your tools arrive as `mcp__<server>__<tool>`. The chat shows
  each call as a card with its name and arguments, through `useDefaultRenderTool` in
  `src/hooks/use-generative-ui-examples.tsx`. A tool can get its own card with
  `useRenderTool` and its full name.

## Checking a backend

`e2e/mock-agent.mjs` answers `POST /agent/report` the same way it answers `POST /`, and
`GET /last-run` returns the last run's input. To see what the app sends, start it with
`AGENT_PORT=9000 node e2e/mock-agent.mjs` and set `AGENT_URL=http://localhost:9000` for
the UI. After a message, `curl localhost:9000/last-run` shows the run input, with
`forwardedProps.knowledge_chatroom` in it.
