"""The chat agent: Claude, through the Claude Agent SDK, served over AG-UI.

The app reaches it through AGENT_URL at POST /agent/report, as any remote
backend (docs/remote-agent.md). Storage, skills and memory are api-py's
(LOCAL_AGENT_URL); this agent only talks to them over HTTP with the run's
tokens.
"""
