# Lab tools MCP server

The tools of the sample Python agent as an MCP server: `describe_metric`,
`compare_runs`, `describe_column` (reads a workspace CSV), `recall_user_notes`
(the user's memory) and `whoami`. The guide that explains it, the skill that goes
with it and the agent it came from are in
[`examples/python-agent`](../../examples/python-agent/README.md).

```bash
uv sync --package lab-tools          # from the repository root
cd services/lab-tools
uv run python -m lab_tools.server    # http://127.0.0.1:9100/mcp
uv run pytest -q
```

Docker: `docker compose --profile python-sample` (see `docker-compose.yml`).
