"""Shared pieces for Python services that work with the knowledge chatroom.

- identity: who is calling (the agent's signed X-Knowledge-User header)
- storage: the user's workspace files through the agent's storage API
- memory: the user's memory in the calling chat (/memory/agent)
- api: pydantic models of the agent server's API, generated from the OpenAPI spec

Only the standard library and `cryptography` (plus pydantic for `api`, with the
`api` extra): no MCP or web framework, so any server (MCP or not) can use them.
"""
