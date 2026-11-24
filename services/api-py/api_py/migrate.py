"""Applies the SQL migrations and exits: `python -m api_py.migrate`.

For deployments that run api-py with MIGRATIONS=off (several replicas, or a
database account for the server that may not change the schema): a deploy
step runs this once, with DATABASE_URL (and MIGRATIONS_DIR when not the
repository's), and the servers start serving storage when it is done. It
takes the same advisory lock a server does, so running both is safe.
"""

from __future__ import annotations

import asyncio
import os
from collections.abc import Mapping
from pathlib import Path

from . import db
from .config import DEFAULT_MIGRATIONS_DIR


async def apply(database_url: str, directory: Path) -> list[str]:
    """Applies what is missing; the names applied. RuntimeError for a database newer than this code."""
    pool = db.open_pool(database_url)
    await pool.open()
    try:
        found = await db.schema(pool, directory)
        if found.state is db.SchemaState.AHEAD:
            raise RuntimeError(
                f"The database has migrations this version doesn't know ({', '.join(found.unknown)}): update api-py"
            )
        return await db.migrate(pool, directory)
    finally:
        await pool.close()


def main(env: Mapping[str, str] = os.environ) -> None:
    database_url = (env.get("DATABASE_URL") or "").strip()
    if not database_url:
        raise SystemExit("[api-py] DATABASE_URL is not set: there is no database to migrate")
    directory = Path(env.get("MIGRATIONS_DIR") or DEFAULT_MIGRATIONS_DIR)
    try:
        applied = asyncio.run(apply(database_url, directory))
    except Exception as err:
        raise SystemExit(f"[api-py] couldn't apply the migrations: {err}") from err
    print(
        f"applied: {', '.join(applied)}"
        if applied
        else "nothing to apply: the database is up to date"
    )


if __name__ == "__main__":
    main()
