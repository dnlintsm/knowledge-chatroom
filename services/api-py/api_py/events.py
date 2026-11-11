"""Change events for the workspace, heard through Postgres LISTEN/NOTIFY, as events.ts in apps/agent hears them.

Writers notify inside their transaction (Storage.notify), so nobody hears about
a change that rolled back, and every process hears every change: a file the
TypeScript server or Claude's tools write reaches this server's file watch, and
the other way round. One connection listens for the whole server, opened by the
first subscriber and opened again if it drops.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
from collections.abc import Callable
from typing import Any

from psycopg import AsyncConnection, sql

logger = logging.getLogger("api_py")
RETRY_SECONDS = 1.0

Listener = Callable[[dict[str, Any]], None]


class EventHub:
    def __init__(self, conninfo: str, workspace_id: str, channel: str) -> None:
        self._conninfo = conninfo
        self._workspace_id = workspace_id
        self._channel = channel
        self._listeners: set[Listener] = set()
        self._task: asyncio.Task[None] | None = None
        self._ready: asyncio.Future[None] | None = None

    async def subscribe(self, listener: Listener) -> Callable[[], None]:
        """Calls `listener` with each event of this workspace; returns the unsubscribe function."""
        if self._task is None or self._task.done():
            self._ready = asyncio.get_running_loop().create_future()
            self._task = asyncio.create_task(self._listen(self._ready))
        assert self._ready is not None
        # Fails here, so the request gets a normal error answer, when the first LISTEN can't be set up.
        await asyncio.shield(self._ready)
        self._listeners.add(listener)
        return lambda: self._listeners.discard(listener)

    async def _listen(self, ready: asyncio.Future[None]) -> None:
        while True:
            try:
                async with await AsyncConnection.connect(self._conninfo, autocommit=True) as conn:
                    await conn.execute(sql.SQL("LISTEN {}").format(sql.Identifier(self._channel)))
                    if not ready.done():
                        ready.set_result(None)
                    async for note in conn.notifies():
                        self._deliver(note.payload)
            except asyncio.CancelledError:
                raise
            except Exception as err:  # noqa: BLE001 - reported, then listened for again
                if not ready.done():
                    ready.set_exception(err)
                    return  # The next subscriber tries again.
                logger.warning("lost the change events connection (%s); listening again", err)
            await asyncio.sleep(RETRY_SECONDS)

    def _deliver(self, payload: str) -> None:
        try:
            event = json.loads(payload)
        except ValueError:
            return
        if not isinstance(event, dict) or event.pop("workspaceId", None) != self._workspace_id:
            return
        for listener in list(self._listeners):
            listener(event)

    async def close(self) -> None:
        if self._task:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await self._task
