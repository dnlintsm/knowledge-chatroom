"""Content-addressed bytes in the S3-compatible store, as apps/agent/src/storage/blobs.ts keeps them.

A blob's key is the sha256 of its bytes (blobs/<first two hex>/<sha256>), so
blobs never change once written and identical content is stored once. Both
servers read and write the same bucket. boto3 is blocking, so each call runs
in a worker thread.
"""

from __future__ import annotations

import asyncio
import hashlib
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any
from urllib.parse import quote

# How long a download link works. Access is checked when the link is made.
DOWNLOAD_LINK_SECONDS = 300
# encodeURIComponent leaves these as they are.
_URI_COMPONENT_SAFE = "-_.!~*'()"


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


@dataclass(frozen=True)
class S3Settings:
    """The S3_* settings, read as config.ts in apps/agent reads them."""

    endpoint: str | None = None
    region: str = "us-east-1"
    bucket: str = "knowledge"
    access_key_id: str | None = None
    secret_access_key: str | None = None
    force_path_style: bool = True
    # The store as browsers reach it, for signed download links; None: bytes go through the app.
    public_url: str | None = None

    @classmethod
    def from_env(cls, env: Mapping[str, str]) -> S3Settings:
        return cls(
            endpoint=env.get("S3_ENDPOINT") or None,
            region=env.get("S3_REGION") or "us-east-1",
            bucket=env.get("S3_BUCKET") or "knowledge",
            access_key_id=env.get("S3_ACCESS_KEY_ID") or None,
            secret_access_key=env.get("S3_SECRET_ACCESS_KEY") or None,
            force_path_style=env.get("S3_FORCE_PATH_STYLE", "true") != "false",
            public_url=env.get("S3_PUBLIC_URL") or None,
        )


def _not_found(err: Exception) -> bool:
    """Whether a store error means the object (or bucket) isn't there, as opposed to a failure."""
    response: dict[str, Any] = getattr(err, "response", None) or {}
    code = str(response.get("Error", {}).get("Code", ""))
    status = response.get("ResponseMetadata", {}).get("HTTPStatusCode")
    return code in ("404", "NotFound", "NoSuchKey", "NoSuchBucket") or status == 404


class BlobStore:
    def __init__(self, settings: S3Settings) -> None:
        import boto3
        from botocore.config import Config

        self.bucket = settings.bucket

        def client(endpoint: str | None):
            # Without keys, boto3 looks for credentials as the AWS SDK does (environment, profile, instance role).
            keys = (
                {"aws_access_key_id": settings.access_key_id, "aws_secret_access_key": settings.secret_access_key}
                if settings.access_key_id and settings.secret_access_key
                else {}
            )
            return boto3.session.Session().client(
                "s3",
                endpoint_url=endpoint,
                region_name=settings.region,
                config=Config(
                    signature_version="s3v4",
                    s3={"addressing_style": "path" if settings.force_path_style else "auto"},
                    # As many uploads at once as the thread pool runs.
                    max_pool_connections=32,
                    # Checksums only where S3 requires them, as not every S3-compatible store
                    # takes the ones newer AWS SDKs add to every upload.
                    request_checksum_calculation="when_required",
                    response_checksum_validation="when_required",
                ),
                **keys,
            )

        self._client = client(settings.endpoint)
        # Signs links for the address browsers use (S3_PUBLIC_URL).
        self._public = client(settings.public_url) if settings.public_url else None

    @staticmethod
    def key(sha256: str) -> str:
        return f"blobs/{sha256[:2]}/{sha256}"

    async def ensure_bucket(self) -> None:
        """Creates the bucket when missing, as the TypeScript server does at startup."""

        def run() -> None:
            try:
                self._client.head_bucket(Bucket=self.bucket)
            except Exception as err:
                if not _not_found(err):
                    raise
                self._client.create_bucket(Bucket=self.bucket)

        await asyncio.to_thread(run)

    async def put(self, sha256: str, data: bytes, mime: str) -> None:
        key = self.key(sha256)

        def run() -> None:
            try:
                self._client.head_object(Bucket=self.bucket, Key=key)
                return  # Same hash, same bytes: already stored.
            except Exception as err:
                if not _not_found(err):
                    raise
            self._client.put_object(Bucket=self.bucket, Key=key, Body=data, ContentType=mime, ContentLength=len(data))

        await asyncio.to_thread(run)

    async def get(self, sha256: str) -> bytes:
        def run() -> bytes:
            answer = self._client.get_object(Bucket=self.bucket, Key=self.key(sha256))
            return answer["Body"].read()

        return await asyncio.to_thread(run)

    async def download_url(self, sha256: str, mime: str, filename: str) -> str | None:
        """A short-lived link browsers can download the blob from, or None when the store isn't public."""
        public = self._public
        if public is None:
            return None
        params = {
            "Bucket": self.bucket,
            "Key": self.key(sha256),
            "ResponseContentType": mime,
            "ResponseContentDisposition": f"inline; filename*=UTF-8''{quote(filename, safe=_URI_COMPONENT_SAFE)}",
        }
        # Signing is local (no request), so it needn't leave the event loop.
        return public.generate_presigned_url("get_object", Params=params, ExpiresIn=DOWNLOAD_LINK_SECONDS)
