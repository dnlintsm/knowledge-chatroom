"""Shared pieces for Python services that work with the knowledge chatroom.

- identity: who is calling (the agent's signed X-Knowledge-User header)
- storage: the user's workspace files through the agent's storage API
- memory: the user's memory in the calling chat (/memory/agent)

Only the standard library and `cryptography`: no MCP or web framework, so any
server (MCP or not) can use them.
"""
