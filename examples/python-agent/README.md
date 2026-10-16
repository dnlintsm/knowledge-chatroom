# Sample Python agent

This sample shows how to bring a Python Claude agent into Knowledge Chatroom
(issue #60). The chatroom runs **one** agent, the TypeScript one in `agent/`, which
already has the workspace, storage, skills and permissions. A Python agent doesn't
run beside it. Its parts move into that agent instead:

| Python agent part | Where it goes in the chatroom | In this sample |
| --- | --- | --- |
| System prompt / instructions | A **skill** | [`skills/lab-analyst/SKILL.md`](skills/lab-analyst/SKILL.md) |
| `@tool` functions | An **MCP server** in Python, connected with `MCP_SERVERS` | [`lab_tools/server.py`](lab_tools/server.py) |
| The tools' logic | Plain Python, shared by both and unit-tested | [`lab_tools/stats.py`](lab_tools/stats.py) |
| Who is calling | The signed user forwarded by the agent | [`lab_tools/identity.py`](lab_tools/identity.py) |
| `query()` loop, model, allowed tools | Nothing: the chatroom's agent does this | — |

[`before/agent.py`](before/agent.py) is the same sample written as a standalone
Python Claude Agent SDK agent: a system prompt, two `@tool` functions and
`query()`. Its comments mark where each part went. The chatroom doesn't run that
file. It's there so you can compare it with your own agent.

The sample is a small "lab analyst": `describe_metric` summarizes one run's
values, `compare_runs` tells whether a candidate run beats a baseline (Welch's t),
and `whoami` shows the forwarded user.

## Run it

1. Start the tools server (Python 3.10+):

   ```bash
   cd examples/python-agent
   pip install -r requirements.txt
   python -m lab_tools.server          # http://127.0.0.1:9100/mcp
   ```

2. Connect the agent to it in the repository's `.env`, then restart the agent
   (`npm run dev`):

   ```bash
   MCP_SERVERS={"mcpServers":{"lab":{"url":"http://127.0.0.1:9100/mcp","forwardIdentity":true}}}
   ```

   Claude now has `mcp__lab__describe_metric`, `mcp__lab__compare_runs` and
   `mcp__lab__whoami`, with no permission prompt.

3. Add the skill. In the Skills panel, choose **Import .zip** and pick a zip of
   `skills/lab-analyst` (`cd skills && zip -r lab-analyst.zip lab-analyst`).
   Alternatively, create `skills/lab-analyst/SKILL.md` in the workspace with the
   same content. Then turn it on (Auto or Manual) like any other skill, or type
   `/lab-analyst` in the chat.

4. Ask: *"Compare baseline [0.71, 0.73, 0.72] with candidate [0.78, 0.80, 0.79]."*

With Docker, the `python-sample` profile builds and runs the server next to the
demo. The demo has no login, so the server treats every call as the local user.
Use the service name in `.env`:

```bash
MCP_SERVERS={"mcpServers":{"lab":{"url":"http://lab-tools:9100/mcp","forwardIdentity":true}}}
docker compose --profile demo --profile python-sample up --build
```

## Login and the forwarded user

Without login, nobody is forwarded and every call is the local user.

With login on, give the tools server the chatroom's `AUTH_SECRET`. Each run then
sends the signed-in user as an `X-Knowledge-User` header, signed for this server
only (`aud` is `mcp:<name in MCP_SERVERS>`, so set `LAB_TOOLS_NAME` to match).
The agent refuses that token, so a tools server can't use it to call the
chatroom. `require_user()` in `server.py` checks it on every tool. Keep that call
in your tools when they act for a person.

These tools run outside the workspace's storage and permissions. If a tool needs
a workspace file, have Claude read the file with its own file tools and pass the
content in as an argument. Don't read the store directly.

## Turning your agent into this

1. Move the tools' logic into plain functions (like `stats.py`) and test them.
2. Wrap each function as an `@mcp.tool()` in a server like `server.py`. Claude
   reads the docstring and type hints, so write them for Claude. Raise
   `ToolError` for errors Claude should see.
3. Move the system prompt into a skill: frontmatter `name` and `description`
   (when to use it), then the instructions. Split it if parts apply to
   different requests. Refer to tools by their short name (`compare_runs`).
4. Add the server to `MCP_SERVERS`. One server can hold several agents' tools,
   or each team can run its own under a different name.
5. Subagents (`agents=` in `ClaudeAgentOptions`) aren't wired into the chatroom
   yet. Mention them in issue #60 if your agents use them.

## Test

```bash
pip install -r requirements-dev.txt
python -m pytest -q
```

The identity tests use tokens signed by the TypeScript agent, so they fail if
the two sides stop agreeing on the format. CI runs them in the `python-sample`
job.
