"""Persistence: plan runs, the weather cache, solver jobs and the farm registry.

PostgreSQL in deployment (``DATABASE_URL=postgresql+psycopg://...``); SQLite by
default for local development. The schema is managed by Alembic migrations, applied
at startup. Persistence is best-effort: if the database is unreachable the planner
keeps working, the API reports ``db: unavailable``, and the connection is retried.
"""

from __future__ import annotations

import logging
import os
import threading
import time
import uuid
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterator

from sqlalchemy import (
    JSON,
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    String,
    create_engine,
    delete,
    event,
    false,
    inspect,
    select,
    text,
)
from sqlalchemy.engine import Engine
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column, sessionmaker

log = logging.getLogger("sunshift.db")

BACKEND_DIR = Path(__file__).resolve().parents[1]
DATA_DIR = BACKEND_DIR / "data"
MIGRATIONS_DIR = BACKEND_DIR / "migrations"
RETRY_AFTER_S = 30.0


def database_url() -> str:
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


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def aware(dt: datetime | None) -> datetime | None:
    """SQLite returns naive datetimes; everything stored here is UTC."""
    if dt is None:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


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


class Job(Base):
    """A solver request. Shared through the database so any process can answer a poll."""

    __tablename__ = "jobs"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    kind: Mapped[str] = mapped_column(String(16))
    key: Mapped[str] = mapped_column(String(64), index=True)
    status: Mapped[str] = mapped_column(String(10), index=True)  # queued | running | done | failed
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    result: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)
    error: Mapped[str | None] = mapped_column(String(300), nullable=True)


class FeederRow(Base):
    __tablename__ = "feeders"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    name: Mapped[str] = mapped_column(String(80))
    location_id: Mapped[str] = mapped_column(String(32))
    pv_kwp: Mapped[float] = mapped_column(Float)
    inverter_kw: Mapped[float] = mapped_column(Float)
    feeder_limit_kw: Mapped[float] = mapped_column(Float)
    grid_backup_kw: Mapped[float] = mapped_column(Float)
    simulated: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class FarmRow(Base):
    __tablename__ = "farms"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=False)
    feeder_id: Mapped[str] = mapped_column(String(32), ForeignKey("feeders.id"), index=True)
    label: Mapped[str | None] = mapped_column(String(60), nullable=True)
    crop: Mapped[str] = mapped_column(String(20))
    area_ha: Mapped[float] = mapped_column(Float)
    soil: Mapped[str] = mapped_column(String(30))
    method: Mapped[str] = mapped_column(String(20))
    das: Mapped[int | None] = mapped_column(Integer, nullable=True)  # days after sowing, if no sowing date
    sowing_date: Mapped[str | None] = mapped_column(String(10), nullable=True)
    available: Mapped[list[list[float]]] = mapped_column(JSON)  # [[start_hour, end_hour], ...]
    habit_start: Mapped[str] = mapped_column(String(5))
    dr0_frac: Mapped[float] = mapped_column(Float)
    served_yesterday: Mapped[float] = mapped_column(Float)
    last_irrigated_days: Mapped[int] = mapped_column(Integer)
    map_x: Mapped[float | None] = mapped_column(Float, nullable=True)
    map_y: Mapped[float | None] = mapped_column(Float, nullable=True)
    simulated: Mapped[bool] = mapped_column(Boolean, default=True)
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    # Messaging. The phone number is personal data: stored here only, never returned by the API.
    phone: Mapped[str | None] = mapped_column(String(20), nullable=True, index=True)
    language: Mapped[str] = mapped_column(String(2), default="te", server_default="te")
    sms_opt_in: Mapped[bool] = mapped_column(Boolean, default=False, server_default=false())
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class Dispatch(Base):
    """A schedule as sent to farmers; replies re-plan from it."""

    __tablename__ = "dispatches"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    feeder_id: Mapped[str] = mapped_column(String(32))
    plan_date: Mapped[str] = mapped_column(String(10), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    schedule: Mapped[dict[str, Any]] = mapped_column(JSON)  # {farm id: [slots]}
    reason: Mapped[str] = mapped_column(String(40))  # morning | reply from F07 | ...


class Message(Base):
    __tablename__ = "messages"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    dispatch_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    farm_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    direction: Mapped[str] = mapped_column(String(3))  # out | in
    phone_masked: Mapped[str] = mapped_column(String(20))
    language: Mapped[str] = mapped_column(String(2))
    body: Mapped[str] = mapped_column(String(1000))
    status: Mapped[str] = mapped_column(String(12))  # simulated | sent | failed | received
    provider: Mapped[str] = mapped_column(String(12))
    provider_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    error: Mapped[str | None] = mapped_column(String(300), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    # Idempotency: the same schedule for the same farm and day is sent once, however often
    # the planner or a dispatch is re-run (failed sends may be retried).
    plan_date: Mapped[str | None] = mapped_column(String(10), nullable=True)
    dedupe_key: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)


class FarmOverride(Base):
    """A farmer's change for one day, from an SMS reply: skip the day, or start no earlier than an hour."""

    __tablename__ = "farm_overrides"

    farm_id: Mapped[int] = mapped_column(Integer, ForeignKey("farms.id"), primary_key=True)
    plan_date: Mapped[str] = mapped_column(String(10), primary_key=True)
    skip: Mapped[bool] = mapped_column(Boolean)
    earliest_hour: Mapped[float | None] = mapped_column(Float, nullable=True)
    source: Mapped[str] = mapped_column(String(12))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class PumpRow(Base):
    __tablename__ = "pumps"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    farm_id: Mapped[int] = mapped_column(Integer, ForeignKey("farms.id"), unique=True)
    hp: Mapped[float] = mapped_column(Float)
    head_m: Mapped[float] = mapped_column(Float)
    controller: Mapped[str] = mapped_column(String(12), default="advisory")  # advisory | automatic
    measured_kw: Mapped[float | None] = mapped_column(Float, nullable=True)
    measured_flow_m3h: Mapped[float | None] = mapped_column(Float, nullable=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


_engine: Engine | None = None
_session_factory: sessionmaker[Session] | None = None
_status = "uninitialised"
_last_attempt = 0.0
_init_lock = threading.Lock()
_on_ready: list[Any] = []


def on_ready(callback) -> None:
    """Run ``callback()`` every time a database connection is established (seeding etc.)."""
    if callback not in _on_ready:
        _on_ready.append(callback)


def _alembic_config():
    from alembic.config import Config

    cfg = Config()
    cfg.set_main_option("script_location", MIGRATIONS_DIR.as_posix())
    return cfg


def migrate(engine: Engine) -> None:
    """Bring the schema to the latest migration. Databases created before migrations
    existed (runs and weather_cache only) are stamped at the first revision first."""
    from alembic import command

    cfg = _alembic_config()
    logging.getLogger("alembic.runtime.plugins").setLevel(logging.WARNING)
    with engine.begin() as connection:
        if connection.dialect.name == "postgresql":
            # Several processes may start at once: let one of them migrate.
            connection.execute(text("SELECT pg_advisory_xact_lock(727274)"))
        tables = set(inspect(connection).get_table_names())
        cfg.attributes["connection"] = connection
        if "runs" in tables and "alembic_version" not in tables:
            command.stamp(cfg, "0001")
        command.upgrade(cfg, "head")


def _sqlite_pragmas(dbapi_connection, _record) -> None:
    cur = dbapi_connection.cursor()
    cur.execute("PRAGMA journal_mode=WAL")  # readers do not block the solver threads' writes
    cur.execute("PRAGMA foreign_keys=ON")
    cur.close()


def init_db() -> str:
    global _engine, _session_factory, _status, _last_attempt
    with _init_lock:
        _last_attempt = time.monotonic()
        url = database_url()
        try:
            kwargs: dict[str, Any] = {"pool_pre_ping": True}
            if url.startswith("sqlite"):
                kwargs["connect_args"] = {"check_same_thread": False, "timeout": 15}
            engine = create_engine(url, **kwargs)
            if url.startswith("sqlite"):
                event.listen(engine, "connect", _sqlite_pragmas)
            migrate(engine)
            _engine = engine
            _session_factory = sessionmaker(engine, expire_on_commit=False)
            _status = "postgresql" if url.startswith("postgresql") else "sqlite"
        except Exception as exc:
            log.warning("database unavailable, continuing without persistence: %s", exc)
            _engine, _session_factory, _status = None, None, "unavailable"
            return _status
    for callback in _on_ready:
        try:
            callback()
        except Exception:  # pragma: no cover - seeding must never take the API down
            log.exception("database ready hook failed")
    return _status


def dispose() -> None:
    """Close all connections (tests, shutdown)."""
    global _engine, _session_factory, _status
    with _init_lock:
        if _engine is not None:
            _engine.dispose()
        _engine, _session_factory, _status = None, None, "uninitialised"


def status() -> str:
    return _status


def engine() -> Engine | None:
    """The database engine, or None while the database is unavailable."""
    _factory()
    return _engine


def _factory() -> sessionmaker[Session] | None:
    # Retry a lost database now and then instead of staying offline until a restart.
    if _session_factory is None and _status == "unavailable" and time.monotonic() - _last_attempt > RETRY_AFTER_S:
        init_db()
    return _session_factory


@contextmanager
def session() -> Iterator[Session | None]:
    """A session, or None when the database is unavailable. Commits on success."""
    factory = _factory()
    if factory is None:
        yield None
        return
    s = factory()
    try:
        yield s
        s.commit()
    except Exception:
        s.rollback()
        raise
    finally:
        s.close()


# ------------------------------------------------------------------- plan runs


def _run_dict(r: Run) -> dict[str, Any]:
    return {
        "id": r.id, "createdAt": aware(r.created_at).isoformat(), "kind": r.kind, "date": r.plan_date,
        "location": r.location, "engine": r.engine, "solveSeconds": r.solve_seconds,
        "params": r.params, "summary": r.summary,
    }


def save_run(
    *, kind: str, plan_date: str, location: str, engine: str, solve_seconds: float,
    params: dict[str, Any], summary: dict[str, Any],
) -> str | None:
    run_id = uuid.uuid4().hex[:12]
    try:
        with session() as s:
            if s is None:
                return None
            s.add(Run(
                id=run_id, created_at=utcnow(), kind=kind, plan_date=plan_date,
                location=location, engine=engine, solve_seconds=solve_seconds, params=params, summary=summary,
            ))
        return run_id
    except Exception as exc:
        log.warning("could not persist run: %s", exc)
        return None


def list_runs(limit: int = 20) -> list[dict[str, Any]]:
    try:
        with session() as s:
            if s is None:
                return []
            return [_run_dict(r) for r in s.scalars(select(Run).order_by(Run.created_at.desc()).limit(limit)).all()]
    except Exception as exc:
        log.warning("could not list runs: %s", exc)
        return []


def get_run(run_id: str) -> dict[str, Any] | None:
    try:
        with session() as s:
            if s is None:
                return None
            r = s.get(Run, run_id)
            return _run_dict(r) if r else None
    except Exception as exc:
        log.warning("could not read run: %s", exc)
        return None


# --------------------------------------------------------------- weather cache


def cache_get(key: str) -> tuple[datetime, dict[str, Any]] | None:
    try:
        with session() as s:
            if s is None:
                return None
            row = s.get(WeatherCache, key)
            return (aware(row.fetched_at), row.payload) if row else None
    except Exception:
        return None


def cache_put(key: str, payload: dict[str, Any]) -> None:
    try:
        with session() as s:
            if s is None:
                return
            row = s.get(WeatherCache, key)
            if row is None:
                s.add(WeatherCache(key=key, fetched_at=utcnow(), payload=payload))
            else:
                row.fetched_at = utcnow()
                row.payload = payload
    except Exception as exc:
        log.warning("could not write weather cache: %s", exc)


# ---------------------------------------------------------------- housekeeping


def prune(runs_retention: int, jobs_retention_h: int) -> None:
    """Keep the newest ``runs_retention`` runs and drop finished jobs older than the window."""
    try:
        with session() as s:
            if s is None:
                return
            cutoff = s.scalars(select(Run.created_at).order_by(Run.created_at.desc()).offset(runs_retention).limit(1)).first()
            if cutoff is not None:
                s.execute(delete(Run).where(Run.created_at <= cutoff))
            old = utcnow() - timedelta(hours=jobs_retention_h)
            s.execute(delete(Job).where(Job.created_at < old))
    except Exception as exc:
        log.warning("could not prune old rows: %s", exc)
