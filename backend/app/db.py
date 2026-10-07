"""Persistence: plan runs and a weather cache.

PostgreSQL in deployment (``DATABASE_URL=postgresql+psycopg://...``); SQLite by
default for local development. Persistence is best-effort: if the database is
unreachable the planner keeps working and the API reports ``db: unavailable``.
"""

from __future__ import annotations

import logging
import os
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from sqlalchemy import JSON, DateTime, Float, String, create_engine, select
from sqlalchemy.engine import Engine
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column, sessionmaker

log = logging.getLogger("sunshift.db")

DATA_DIR = Path(__file__).resolve().parents[1] / "data"


def _database_url() -> str:
    url = os.environ.get("DATABASE_URL", "").strip()
    if not url:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        return f"sqlite:///{(DATA_DIR / 'sunshift.db').as_posix()}"
    # Hosted Postgres providers often hand out postgres:// URLs.
    if url.startswith("postgres://"):
        url = "postgresql+psycopg://" + url[len("postgres://") :]
    elif url.startswith("postgresql://"):
        url = "postgresql+psycopg://" + url[len("postgresql://") :]
    return url


class Base(DeclarativeBase):
    pass


class Run(Base):
    __tablename__ = "runs"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    kind: Mapped[str] = mapped_column(String(16))  # plan | season
    plan_date: Mapped[str] = mapped_column(String(10))
    location: Mapped[str] = mapped_column(String(32))
    engine: Mapped[str] = mapped_column(String(16))
    solve_seconds: Mapped[float] = mapped_column(Float, default=0.0)
    params: Mapped[dict[str, Any]] = mapped_column(JSON)
    summary: Mapped[dict[str, Any]] = mapped_column(JSON)


class WeatherCache(Base):
    __tablename__ = "weather_cache"

    key: Mapped[str] = mapped_column(String(160), primary_key=True)
    fetched_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    payload: Mapped[dict[str, Any]] = mapped_column(JSON)


_engine: Engine | None = None
_session_factory: sessionmaker[Session] | None = None
_status = "uninitialised"


def init_db() -> str:
    global _engine, _session_factory, _status
    url = _database_url()
    try:
        kwargs: dict[str, Any] = {"pool_pre_ping": True}
        if url.startswith("sqlite"):
            kwargs["connect_args"] = {"check_same_thread": False}
        _engine = create_engine(url, **kwargs)
        Base.metadata.create_all(_engine)
        _session_factory = sessionmaker(_engine, expire_on_commit=False)
        _status = "postgresql" if url.startswith("postgresql") else "sqlite"
    except Exception as exc:  # pragma: no cover - depends on deployment
        log.warning("database unavailable, continuing without persistence: %s", exc)
        _engine, _session_factory, _status = None, None, "unavailable"
    return _status


def status() -> str:
    return _status


def _session() -> Session | None:
    if _session_factory is None:
        return None
    return _session_factory()


def save_run(
    *, kind: str, plan_date: str, location: str, engine: str, solve_seconds: float,
    params: dict[str, Any], summary: dict[str, Any],
) -> str | None:
    s = _session()
    if s is None:
        return None
    run_id = uuid.uuid4().hex[:12]
    try:
        with s.begin():
            s.add(Run(
                id=run_id, created_at=datetime.now(timezone.utc), kind=kind, plan_date=plan_date,
                location=location, engine=engine, solve_seconds=solve_seconds, params=params, summary=summary,
            ))
        return run_id
    except Exception as exc:  # pragma: no cover
        log.warning("could not persist run: %s", exc)
        return None
    finally:
        s.close()


def list_runs(limit: int = 20) -> list[dict[str, Any]]:
    s = _session()
    if s is None:
        return []
    try:
        rows = s.scalars(select(Run).order_by(Run.created_at.desc()).limit(limit)).all()
        return [
            {
                "id": r.id, "createdAt": r.created_at.isoformat(), "kind": r.kind, "date": r.plan_date,
                "location": r.location, "engine": r.engine, "solveSeconds": r.solve_seconds,
                "params": r.params, "summary": r.summary,
            }
            for r in rows
        ]
    finally:
        s.close()


def get_run(run_id: str) -> dict[str, Any] | None:
    s = _session()
    if s is None:
        return None
    try:
        r = s.get(Run, run_id)
        if r is None:
            return None
        return {
            "id": r.id, "createdAt": r.created_at.isoformat(), "kind": r.kind, "date": r.plan_date,
            "location": r.location, "engine": r.engine, "solveSeconds": r.solve_seconds,
            "params": r.params, "summary": r.summary,
        }
    finally:
        s.close()


def cache_get(key: str) -> tuple[datetime, dict[str, Any]] | None:
    s = _session()
    if s is None:
        return None
    try:
        row = s.get(WeatherCache, key)
        if row is None:
            return None
        fetched = row.fetched_at if row.fetched_at.tzinfo else row.fetched_at.replace(tzinfo=timezone.utc)
        return fetched, row.payload
    except Exception:  # pragma: no cover
        return None
    finally:
        s.close()


def cache_put(key: str, payload: dict[str, Any]) -> None:
    s = _session()
    if s is None:
        return
    try:
        with s.begin():
            row = s.get(WeatherCache, key)
            now = datetime.now(timezone.utc)
            if row is None:
                s.add(WeatherCache(key=key, fetched_at=now, payload=payload))
            else:
                row.fetched_at = now
                row.payload = payload
    except Exception as exc:  # pragma: no cover
        log.warning("could not write weather cache: %s", exc)
    finally:
        s.close()
