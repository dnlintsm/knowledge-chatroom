from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest

from api_py.access import AccessService, Principal, at_least
from api_py.nodes import NodeNotFoundError
from api_py.search import SearchService
from api_py.session import Session
from api_py.storage import Storage


@pytest.mark.parametrize(
    ("role", "minimum", "allowed"),
    [
        ("viewer", "viewer", True),
        ("viewer", "editor", False),
        ("editor", "viewer", True),
        ("editor", "owner", False),
        ("owner", "owner", True),
        (None, "viewer", False),
        ("administrator", "viewer", False),
        ("", "viewer", False),
    ],
)
def test_role_comparison_denies_unknown_roles(role, minimum, allowed):
    assert at_least(role, minimum) is allowed


@pytest.mark.anyio
async def test_invalid_database_roles_do_not_grant_or_reveal_access(caplog):
    cursor = MagicMock()
    cursor.fetchone = AsyncMock(return_value=("administrator",))
    cursor.fetchall = AsyncMock(return_value=[("node", "administrator"), ("visible", "viewer")])
    conn = MagicMock()
    conn.execute = AsyncMock(return_value=cursor)
    pool = MagicMock()
    pool.connection.return_value.__aenter__ = AsyncMock(return_value=conn)
    pool.connection.return_value.__aexit__ = AsyncMock(return_value=False)
    access = AccessService(pool, "workspace")
    storage = Storage(pool, "workspace", False, access)
    session = Session(storage, access, Principal("user"))

    assert await access.role("user", None) is None
    assert await access.node_roles("user") == {"node": None, "visible": "viewer"}
    assert "Unexpected effective role" in caplog.text
    with pytest.raises(NodeNotFoundError):
        await session.need("00000000-0000-0000-0000-000000000001", "viewer")


@pytest.mark.anyio
async def test_missing_role_query_row_is_an_invariant_failure():
    cursor = MagicMock()
    cursor.fetchone = AsyncMock(return_value=None)
    conn = MagicMock()
    conn.execute = AsyncMock(return_value=cursor)
    pool = MagicMock()
    pool.connection.return_value.__aenter__ = AsyncMock(return_value=conn)
    pool.connection.return_value.__aexit__ = AsyncMock(return_value=False)
    with pytest.raises(RuntimeError, match="effective_role query returned no row"):
        await AccessService(pool, "workspace").role("user", None)


def test_required_storage_resources_are_explicit():
    storage = Storage(MagicMock(), "workspace", False, MagicMock())
    with pytest.raises(RuntimeError, match="Blob store is not configured"):
        storage.require_blobs()
    with pytest.raises(RuntimeError, match="Event hub is not configured"):
        storage.require_events()
    blobs, events = MagicMock(), MagicMock()
    storage.blobs, storage.events = blobs, events
    assert storage.require_blobs() is blobs
    assert storage.require_events() is events


@pytest.mark.anyio
async def test_search_indexer_refuses_missing_blob_store_before_database_work():
    pool = MagicMock()
    with pytest.raises(RuntimeError, match="Blob store is not configured"):
        await SearchService("workspace", None).index_pending(pool)
    pool.connection.assert_not_called()
