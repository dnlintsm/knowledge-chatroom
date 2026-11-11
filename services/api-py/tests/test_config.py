from __future__ import annotations

import pytest

from api_py.config import DEFAULT_MIGRATIONS_DIR, ConfigError, auth_secret, settings_from_env

SECRET = "0123456789abcdef0123456789abcdef"


def test_defaults_put_this_server_where_the_app_looks():
    settings = settings_from_env({})
    assert (settings.host, settings.port) == ("127.0.0.1", 8000)
    assert settings.ts_agent_url == "http://127.0.0.1:8100"
    assert settings.database_url is None and settings.auth_secret is None
    assert (DEFAULT_MIGRATIONS_DIR / "001_init.sql").exists() or any(DEFAULT_MIGRATIONS_DIR.glob("001_*.sql"))
    assert settings_from_env({"TS_AGENT_URL": "http://agent:8000/"}).ts_agent_url == "http://agent:8000"


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
