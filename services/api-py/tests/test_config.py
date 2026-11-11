from __future__ import annotations

import pytest
from api_py.config import DEFAULT_MIGRATIONS_DIR, ConfigError, auth_secret, settings_from_env

SECRET = "0123456789abcdef0123456789abcdef"


def test_defaults_put_this_server_where_the_app_looks():
    settings = settings_from_env({})
    assert (settings.host, settings.port) == ("127.0.0.1", 8000)
    assert settings.ts_agent_url == "http://127.0.0.1:8100"
    assert settings.database_url is None and settings.auth_secret is None
    assert (DEFAULT_MIGRATIONS_DIR / "001_init.sql").exists() or any(
        DEFAULT_MIGRATIONS_DIR.glob("001_*.sql")
    )
    assert (
        settings_from_env({"TS_AGENT_URL": "http://agent:8000/"}).ts_agent_url
        == "http://agent:8000"
    )


def test_login_follows_the_typescript_rules():
    assert auth_secret({"AUTH_SECRET": SECRET}) == SECRET
    assert auth_secret({"AUTH_MODE": "oidc", "AUTH_SECRET": SECRET}) == SECRET
    assert auth_secret({"AUTH_MODE": "local"}) is None
    for env in (
        {"AUTH_MODE": "oidc"},
        {"AUTH_MODE": "local", "AUTH_SECRET": SECRET},
        {"AUTH_SECRET": "short"},
        {"AUTH_MODE": "maybe"},
        {"NODE_ENV": "production"},
    ):
        with pytest.raises(ConfigError):
            auth_secret(env)
    with pytest.raises(ConfigError):
        settings_from_env({"API_PY_PORT": "eighty"})


def test_the_blob_store_reads_the_typescript_settings():
    s3 = settings_from_env({}).s3
    assert s3 is not None
    assert (s3.endpoint, s3.region, s3.bucket, s3.force_path_style, s3.public_url) == (
        None,
        "us-east-1",
        "knowledge",
        True,
        None,
    )
    env = {
        "S3_ENDPOINT": "http://s3:8333",
        "S3_FORCE_PATH_STYLE": "false",
        "S3_PUBLIC_URL": "https://files.example",
    }
    s3 = settings_from_env(env).s3
    assert s3 is not None and (s3.endpoint, s3.force_path_style, s3.public_url) == (
        "http://s3:8333",
        False,
        "https://files.example",
    )
    assert settings_from_env({}).max_upload_bytes == 50 * 1024 * 1024
    # Number.parseInt, as the TypeScript server reads it.
    assert settings_from_env({"MAX_UPLOAD_BYTES": " 1048576 bytes"}).max_upload_bytes == 1048576
    for bad in ("lots", "0", "-5"):
        with pytest.raises(ConfigError):
            settings_from_env({"MAX_UPLOAD_BYTES": bad})
