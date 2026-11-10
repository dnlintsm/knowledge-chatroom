"""The chatroom's chat agent in Python (issue #176, phase 2 of #169).

The app reaches it through AGENT_URL at POST /agent/report, as any remote
backend (docs/remote-agent.md). Storage, skills and memory stay on the
TypeScript agent server (LOCAL_AGENT_URL); this agent only talks to them
over HTTP with the run's tokens.
"""
