"""ensure_bucket against a fake S3 client: both servers create the bucket at
startup, and the one that loses the race must still start (issue #243)."""

from __future__ import annotations

import asyncio
from typing import Any

import pytest
from botocore.exceptions import ClientError

from api_py.blobs import BlobStore, S3Settings


def s3_error(code: str, status: int, op: str) -> ClientError:
    return ClientError(
        {"Error": {"Code": code}, "ResponseMetadata": {"HTTPStatusCode": status}}, op
    )


class FakeClient:
    def __init__(self, replies: dict[str, list[ClientError]]) -> None:
        self.replies = replies
        self.calls: list[str] = []

    def _reply(self, op: str) -> dict[str, Any]:
        self.calls.append(op)
        queue = self.replies.get(op, [])
        if queue:
            raise queue.pop(0)
        return {}

    def head_bucket(self, **_: Any) -> dict[str, Any]:
        return self._reply("head_bucket")

    def create_bucket(self, **_: Any) -> dict[str, Any]:
        return self._reply("create_bucket")


def store_with(replies: dict[str, list[ClientError]]) -> tuple[BlobStore, FakeClient]:
    # Credentials up front, so boto3 doesn't look for them (instance metadata) on the network.
    settings = S3Settings(
        endpoint="http://s3.test", bucket="kb", access_key_id="test", secret_access_key="test"
    )
    store = BlobStore(settings)
    fake = FakeClient(replies)
    store._client = fake
    return store, fake


def test_creates_the_bucket_when_missing() -> None:
    store, fake = store_with({"head_bucket": [s3_error("404", 404, "HeadBucket")]})
    asyncio.run(store.ensure_bucket())
    assert fake.calls == ["head_bucket", "create_bucket"]


@pytest.mark.parametrize("code", ["BucketAlreadyOwnedByYou", "BucketAlreadyExists"])
def test_starts_when_another_server_created_it_first(code: str) -> None:
    store, fake = store_with(
        {
            "head_bucket": [s3_error("404", 404, "HeadBucket")],
            "create_bucket": [s3_error(code, 409, "CreateBucket")],
        }
    )
    asyncio.run(store.ensure_bucket())
    assert fake.calls == ["head_bucket", "create_bucket", "head_bucket"]


def test_fails_when_the_existing_bucket_belongs_to_someone_else() -> None:
    store, _ = store_with(
        {
            "head_bucket": [s3_error("404", 404, "HeadBucket"), s3_error("403", 403, "HeadBucket")],
            "create_bucket": [s3_error("BucketAlreadyExists", 409, "CreateBucket")],
        }
    )
    with pytest.raises(ClientError, match="403"):
        asyncio.run(store.ensure_bucket())


def test_fails_on_any_other_create_error() -> None:
    store, _ = store_with(
        {
            "head_bucket": [s3_error("404", 404, "HeadBucket")],
            "create_bucket": [s3_error("AccessDenied", 403, "CreateBucket")],
        }
    )
    with pytest.raises(ClientError, match="AccessDenied"):
        asyncio.run(store.ensure_bucket())
