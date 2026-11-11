"""The agent server's HTTP API in Python, in front of the TypeScript server (issue #190).

    uv run python -m api_py.app    # http://127.0.0.1:8000, the app's LOCAL_AGENT_URL

It serves the route groups ported so far (routes.py) and passes every other
request to the TypeScript agent server at TS_AGENT_URL (proxy.py), so the app,
the Python chat agent and the MCP servers keep one address while routes move.
Settings: config.py.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import os
from collections.abc import AsyncIterator, Mapping
from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response
from psycopg_pool import AsyncConnectionPool

from . import db
from .config import ConfigError, Settings, settings_from_env
from .proxy import client, forward
from .routes import ROUTERS, STORAGE_PREFIXES
from .storage import open_storage

logger = logging.getLogger("api_py")
METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]
SCHEMA_POLL_SECONDS = 2.0


async def _try_storage(app: FastAPI, pool: AsyncConnectionPool, settings: Settings) -> bool:
    """
    Opens the storage routes moved to Python once the database has exactly the
    migrations this server knows (the TypeScript server applies them). Returns
    whether they are served; until then they pass through to the TypeScript server.
    """
    if app.state.storage is not None:
        return True
    async with app.state.storage_lock:
        if app.state.storage is not None:
            return True
        try:
            found = await db.schema(pool, settings.migrations_dir)
        except Exception as err:  # noqa: BLE001 - a database that is down is reported, not fatal
            app.state.schema = None
            logger.warning("can't read the database's migrations yet: %s", err)
            return False
        app.state.schema = found
        if found.state is not db.SchemaState.READY:
            return False
        try:
            app.state.storage = await open_storage(pool)
        except Exception as err:  # noqa: BLE001 - tried again, as the database may still be settling
            logger.warning("can't open storage yet: %s", err)
            return False
        logger.info("serving storage routes: %s", ", ".join(STORAGE_PREFIXES))
        return True


async def _serve_storage_when_ready(app: FastAPI, pool: AsyncConnectionPool, settings: Settings) -> None:
    """Follows the database until the storage routes can be served (or it turns out newer than this server)."""
    while not await _try_storage(app, pool, settings):
        found = app.state.schema
        if found and found.state is db.SchemaState.AHEAD:
            logger.error(
                "the database has migrations this server doesn't know (%s); update api-py", ", ".join(found.unknown)
            )
            return
        await asyncio.sleep(SCHEMA_POLL_SECONDS)


def create_app(settings: Settings, transport: httpx.AsyncBaseTransport | None = None) -> FastAPI:
    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        app.state.http = client(settings.ts_agent_url, transport)
        app.state.settings = settings
        app.state.pool = None
        app.state.schema = None
        # The ported storage routes; None while they pass through (no database, or not ready yet).
        app.state.storage = None
        app.state.storage_lock = asyncio.Lock()

        async def storage_ready() -> bool:
            # A request in between polls checks too, so the first one after the
            # TypeScript server has migrated is already served here.
            if app.state.storage is not None:
                return True
            if not app.state.pool or (app.state.schema and app.state.schema.state is db.SchemaState.AHEAD):
                return False
            return await _try_storage(app, app.state.pool, settings)

        app.state.storage_ready = storage_ready
        watcher = None
        if settings.database_url:
            pool = db.open_pool(settings.database_url)
            await pool.open(wait=False)
            app.state.pool = pool
            try:
                found = await db.schema(pool, settings.migrations_dir)
            except Exception as err:  # noqa: BLE001 - not up yet: /health says so until it is
                logger.warning("can't read the database's migrations yet: %s", err)
                found = None
            if found and found.state is db.SchemaState.AHEAD:
                await pool.close()
                raise RuntimeError(
                    f"The database has migrations this server doesn't know ({', '.join(found.unknown)}): "
                    "update api-py to the TypeScript server's version"
                )
            app.state.schema = found
            if found and found.state is not db.SchemaState.READY:
                logger.info("waiting for the TypeScript server to apply %s", ", ".join(found.missing))
            watcher = asyncio.create_task(_serve_storage_when_ready(app, pool, settings))
        try:
            yield
        finally:
            if watcher:
                watcher.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await watcher
            await app.state.http.aclose()
            if app.state.pool:
                await app.state.pool.close()

    app = FastAPI(
        title="knowledge-chatroom API (Python)", lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None
    )

    @app.get("/health")
    async def health(request: Request) -> Response:
        """Up, with the TypeScript server behind it and a database this server knows; 503 with what isn't."""
        try:
            answer = await request.app.state.http.get("/health", timeout=5.0)
            upstream = "ok" if answer.status_code == 200 else "down"
        except httpx.HTTPError:
            upstream = "down"
        found: db.Schema | None = request.app.state.schema
        database = "off" if not settings.database_url else found.state.value if found else "down"
        if upstream == "ok" and database in ("off", "ready", "behind"):
            return JSONResponse({"status": "ok"})  # the spec's answer (getHealth), as the TypeScript server gives it
        return JSONResponse({"status": "degraded", "upstream": upstream, "database": database}, status_code=503)

    for router in ROUTERS:
        app.include_router(router)

    @app.api_route("/{path:path}", methods=METHODS, include_in_schema=False)
    async def pass_through(request: Request) -> Response:
        return await forward(request, request.app.state.http)

    return app


def main(env: Mapping[str, str] = os.environ) -> None:
    import uvicorn

    logging.basicConfig(level=logging.INFO)
    # uvicorn logs each request already; httpx would log each one again on its way through.
    logging.getLogger("httpx").setLevel(logging.WARNING)
    try:
        settings = settings_from_env(env)
    except ConfigError as err:
        raise SystemExit(f"[api-py] {err}") from err
    logger.info("passing routes not ported yet to %s", settings.ts_agent_url)
    uvicorn.run(create_app(settings), host=settings.host, port=settings.port, log_level="info")


if __name__ == "__main__":
    main()
