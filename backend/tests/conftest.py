"""Fixtures for API tests: each runs on SQLite and on a real PostgreSQL server.

PostgreSQL comes from ``TEST_DATABASE_URL`` when set (CI), otherwise from the
``pgserver`` package, which bundles a local PostgreSQL. If neither is available the
PostgreSQL variants are skipped, never silently passed.
"""

from __future__ import annotations

import os
import tempfile
import time
from contextlib import contextmanager
from pathlib import Path

import pytest
from sqlalchemy import create_engine, text

from app import db, registry
from app.settings import Settings


@pytest.fixture(scope="session")
def postgres_url():
    url = os.environ.get("TEST_DATABASE_URL")
    if url:
        yield db_url_normalise(url)
        return
    try:
        import pgserver
    except ImportError:
        yield None
        return
    data_dir = tempfile.mkdtemp(prefix="sunshift-pg-")
    server = pgserver.get_server(data_dir, cleanup_mode="stop")
    yield db_url_normalise(server.get_uri())
    server.cleanup()


def db_url_normalise(url: str) -> str:
    return url.replace("postgresql://", "postgresql+psycopg://", 1) if url.startswith("postgresql://") else url


def _reset_postgres(url: str) -> None:
    engine = create_engine(url)
    with engine.begin() as conn:
        conn.execute(text("DROP SCHEMA public CASCADE"))
        conn.execute(text("CREATE SCHEMA public"))
    engine.dispose()


@pytest.fixture(params=["sqlite", "postgresql"])
def database(request, postgres_url, tmp_path, monkeypatch):
    """Point the app at a fresh, empty database of the requested kind."""
    db.dispose()
    registry.clear_cache()
    if request.param == "sqlite":
        url = f"sqlite:///{(tmp_path / 'test.db').as_posix()}"
    else:
        if postgres_url is None:
            pytest.skip("no PostgreSQL available (install pgserver or set TEST_DATABASE_URL)")
        url = postgres_url
        _reset_postgres(url)
    monkeypatch.setenv("DATABASE_URL", url)
    yield request.param
    db.dispose()
    registry.clear_cache()


@pytest.fixture
def make_client(database):
    """Build an app with test settings (rate limits off unless asked for) and start it."""
    from fastapi.testclient import TestClient

    from app.main import create_app

    @contextmanager
    def factory(**overrides):
        settings = Settings(rate_limits_enabled=False, plan_cache_s=120, study_cache_s=600)
        for k, v in overrides.items():
            setattr(settings, k, v)
        app = create_app(settings, static_dir=Path(tempfile.mkdtemp()))  # an empty dir: no built site in tests
        with TestClient(app) as client:
            yield client

    return factory


def wait_for_job(client, job: dict, timeout_s: float = 60) -> dict:
    deadline = time.monotonic() + timeout_s
    while job["status"] in ("queued", "running"):
        assert time.monotonic() < deadline, f"job {job['id']} did not finish"
        time.sleep(0.1)
        r = client.get(f"/api/jobs/{job['id']}")
        assert r.status_code == 200
        job = r.json()
    return job
