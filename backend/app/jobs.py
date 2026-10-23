"""Solver jobs: CP-SAT work runs on a bounded worker pool, never inside a web request.

- Each process runs at most ``solver_workers`` solves at once and holds at most
  ``max_queued_jobs`` more; beyond that, submissions are refused (HTTP 429) instead of
  piling up until every request times out.
- Identical requests share one solve: a request that matches a job already queued or
  running joins it, and one that matches a recent finished job reuses its result.
- Jobs are stored in the database so any process can answer a poll. Without a database
  they are kept in memory for this process.
"""

from __future__ import annotations

import asyncio
import hashlib
from contextlib import asynccontextmanager, contextmanager
import json
import logging
import threading
import time
import uuid
from collections import OrderedDict
from concurrent.futures import Future, ThreadPoolExecutor
from dataclasses import dataclass
from datetime import timedelta
from typing import Any, AsyncIterator, Callable, Iterator

from sqlalchemy import select, text

from . import alerts, db

log = logging.getLogger("sunshift.jobs")

STALE_AFTER_S = 300  # a job queued or running this long has lost its worker
GENERIC_ERROR = "The solver failed on this request"


class QueueFull(Exception):
    def __init__(self, retry_after_s: int):
        super().__init__("solver queue is full")
        self.retry_after_s = retry_after_s


@dataclass(frozen=True)
class Kind:
    run: Callable[[dict[str, Any]], dict[str, Any]]
    cache_s: int


def cache_key(kind: str, payload: dict[str, Any], context: str) -> str:
    """Stable hash of everything that changes the answer."""
    body = json.dumps({"kind": kind, "payload": payload, "context": context}, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(body.encode()).hexdigest()


def _view(job: db.Job | dict[str, Any], cached: bool = False) -> dict[str, Any]:
    if isinstance(job, dict):
        return {**job, "cached": cached or job.get("cached", False)}
    iso = lambda dt: db.aware(dt).isoformat() if dt else None  # noqa: E731
    return {
        "id": job.id, "kind": job.kind, "status": job.status, "createdAt": iso(job.created_at),
        "startedAt": iso(job.started_at), "finishedAt": iso(job.finished_at), "result": job.result,
        "error": job.error, "cached": cached,
    }


class JobManager:
    def __init__(self, kinds: dict[str, Kind], workers: int, max_queued: int, *, prune: Callable[[], None] | None = None):
        self.kinds = kinds
        self.workers = workers
        self.max_queued = max_queued
        self._pool = ThreadPoolExecutor(max_workers=workers, thread_name_prefix="solver")
        self._lock = threading.Lock()
        self._inflight: dict[str, str] = {}  # cache key -> job id (this process)
        self._futures: dict[str, Future] = {}  # job id -> future (this process)
        self._mem: OrderedDict[str, dict[str, Any]] = OrderedDict()  # jobs when there is no database
        self._running = 0
        self._prune = prune
        self._last_prune = 0.0
        self._done = 0
        self._failed = 0

    # ------------------------------------------------------------- storage

    def _store_new(self, job: dict[str, Any]) -> None:
        with db.session() as s:
            if s is None:
                self._mem[job["id"]] = job
                while len(self._mem) > 512:
                    self._mem.popitem(last=False)
                return
            s.add(db.Job(id=job["id"], kind=job["kind"], key=job["key"], status="queued", created_at=db.utcnow()))

    def _store_update(self, job_id: str, **fields: Any) -> None:
        if job_id in self._mem:
            self._mem[job_id].update({_camel(k): (v.isoformat() if hasattr(v, "isoformat") else v) for k, v in fields.items()})
            return
        try:
            with db.session() as s:
                if s is None:
                    return
                row = s.get(db.Job, job_id)
                if row is not None:
                    for k, v in fields.items():
                        setattr(row, k, v)
        except Exception as exc:
            log.warning("could not update job %s: %s", job_id, exc)

    def get(self, job_id: str) -> dict[str, Any] | None:
        if job_id in self._mem:
            return _view(self._mem[job_id])
        with db.session() as s:
            if s is None:
                return None
            row = s.get(db.Job, job_id)
            if row is None:
                return None
            view = _view(row)
        if view["status"] in ("queued", "running") and job_id not in self._futures:
            created = db.aware(row.created_at)
            if db.utcnow() - created > timedelta(seconds=STALE_AFTER_S):
                view.update(status="failed", error="The worker running this job stopped")
        return view

    def _find_reusable(self, key: str, max_age_s: int) -> dict[str, Any] | None:
        """A finished job with the same key young enough to reuse, or one still in progress."""
        now = db.utcnow()
        for job in reversed(self._mem.values()):
            if job["key"] == key and job["status"] == "done" and max_age_s > 0:
                if (now - db.aware(_parse(job["finishedAt"]))).total_seconds() <= max_age_s:
                    return _view(job, cached=True)
        with db.session() as s:
            if s is None:
                return None
            if max_age_s > 0:
                done = s.scalars(
                    select(db.Job).where(db.Job.key == key, db.Job.status == "done",
                                         db.Job.finished_at >= now - timedelta(seconds=max_age_s))
                    .order_by(db.Job.finished_at.desc()).limit(1)
                ).first()
                if done is not None:
                    return _view(done, cached=True)
            # Another process may be solving the same request right now.
            live = s.scalars(
                select(db.Job).where(db.Job.key == key, db.Job.status.in_(("queued", "running")),
                                     db.Job.created_at >= now - timedelta(seconds=STALE_AFTER_S))
                .order_by(db.Job.created_at.desc()).limit(1)
            ).first()
            return _view(live) if live is not None else None

    # ------------------------------------------------------------ lifecycle

    def submit(self, kind: str, payload: dict[str, Any], *, key_payload: dict[str, Any] | None = None,
               context: str = "", fresh: bool = False) -> dict[str, Any]:
        """Queue ``payload`` for ``kind``. ``key_payload`` (default: the payload) and ``context``
        decide which requests count as identical."""
        spec = self.kinds[kind]
        key = cache_key(kind, payload if key_payload is None else key_payload, context)
        with self._lock:
            live = self._inflight.get(key)
            if live is not None:
                view = self.get(live)
                if view is not None:
                    return view
            try:
                reuse = self._find_reusable(key, 0 if fresh else spec.cache_s)
            except Exception as exc:
                log.warning("job lookup failed: %s", exc)
                reuse = None
            if reuse is not None:
                return reuse
            pending = len(self._futures)
            if pending >= self.workers + self.max_queued:
                # Rough wait: queued solves ahead of this one, a few seconds each.
                raise QueueFull(retry_after_s=max(2, int(3 * (pending - self.workers + 1) / self.workers)))
            job_id = uuid.uuid4().hex[:16]
            job = {"id": job_id, "kind": kind, "key": key, "status": "queued", "createdAt": db.utcnow().isoformat(),
                   "startedAt": None, "finishedAt": None, "result": None, "error": None}
            try:
                self._store_new(job)
            except Exception as exc:  # the database failed mid-request: keep the job in memory
                log.warning("could not store job, keeping it in memory: %s", exc)
                self._mem[job_id] = job
            self._inflight[key] = job_id
            self._futures[job_id] = self._pool.submit(self._execute, job_id, key, spec, payload)
        return self.get(job_id) or _view(job)

    def _execute(self, job_id: str, key: str, spec: Kind, payload: dict[str, Any]) -> dict[str, Any] | None:
        with self._lock:
            self._running += 1
        self._store_update(job_id, status="running", started_at=db.utcnow())
        try:
            result = spec.run(payload)
            self._store_update(job_id, status="done", finished_at=db.utcnow(), result=result)
            self._done += 1
            return result
        except Exception:
            ref = uuid.uuid4().hex[:8]
            log.exception("job %s failed (ref %s)", job_id, ref)
            alerts.alert("solve-failed", "SunShift: a solve failed",
                         f"Job {job_id} failed with an error (ref {ref}); the details are in the server log.")
            self._store_update(job_id, status="failed", finished_at=db.utcnow(), error=f"{GENERIC_ERROR} (ref {ref})")
            self._failed += 1
            return None
        finally:
            with self._lock:
                self._running -= 1
                self._inflight.pop(key, None)
                self._futures.pop(job_id, None)
            self._maybe_prune()

    def _maybe_prune(self) -> None:
        if self._prune is None or time.monotonic() - self._last_prune < 600:
            return
        self._last_prune = time.monotonic()
        try:
            self._prune()
        except Exception:  # pragma: no cover
            log.exception("prune failed")

    async def wait(self, job_id: str, timeout_s: float = 60.0) -> dict[str, Any] | None:
        """Wait for a job without holding a thread: await the local future, else poll."""
        fut = self._futures.get(job_id)
        if fut is not None:
            try:
                await asyncio.wait_for(asyncio.shield(asyncio.wrap_future(fut)), timeout_s)
            except asyncio.TimeoutError:
                return self.get(job_id)
            return self.get(job_id)
        deadline = time.monotonic() + timeout_s
        while True:
            view = self.get(job_id)
            if view is None or view["status"] in ("done", "failed") or time.monotonic() > deadline:
                return view
            await asyncio.sleep(0.25)

    def stats(self) -> dict[str, Any]:
        with self._lock:
            pending = len(self._futures)
            return {
                "workers": self.workers, "running": self._running, "queued": max(0, pending - self._running),
                "capacity": self.workers + self.max_queued, "completed": self._done, "failed": self._failed,
            }

    def shutdown(self) -> None:
        self._pool.shutdown(wait=False, cancel_futures=True)


def _camel(name: str) -> str:
    head, *rest = name.split("_")
    return head + "".join(w.title() for w in rest)


def _parse(iso: str):
    from datetime import datetime

    return datetime.fromisoformat(iso)


# --------------------------------------------------------------- locking

_local_locks: dict[str, threading.Lock] = {}
_local_guard = threading.Lock()


@dataclass
class _Held:
    lock: threading.Lock | None = None
    connection: Any = None
    key: int = 0


def _advisory_key(lock_id: str) -> int:
    return int.from_bytes(hashlib.sha256(lock_id.encode()).digest()[:8], "big", signed=True)


def _try_acquire(lock_id: str) -> _Held | None:
    """PostgreSQL: a session advisory lock, held across every worker process and server.
    SQLite or no database (one process): a per-name thread lock."""
    engine = db.engine()
    if engine is not None and engine.dialect.name == "postgresql":
        key = _advisory_key(lock_id)
        conn = engine.connect()
        try:
            got = conn.execute(text("SELECT pg_try_advisory_lock(:k)"), {"k": key}).scalar()
            conn.commit()  # the lock belongs to the session, not the transaction
        except Exception:
            conn.close()
            raise
        if got:
            return _Held(connection=conn, key=key)
        conn.close()
        return None
    with _local_guard:
        lock = _local_locks.setdefault(lock_id, threading.Lock())
    return _Held(lock=lock) if lock.acquire(blocking=False) else None


def _release(held: _Held) -> None:
    if held.connection is not None:
        try:
            held.connection.execute(text("SELECT pg_advisory_unlock(:k)"), {"k": held.key})
            held.connection.commit()
        finally:
            held.connection.close()
    elif held.lock is not None:
        held.lock.release()


@contextmanager
def distributed_job_lock(lock_id: str, wait_s: float = 0.0) -> Iterator[bool]:
    """Run a critical section once across workers: yields True if the lock was taken
    (waiting up to ``wait_s``), False if someone else holds it."""
    deadline = time.monotonic() + wait_s
    held = _try_acquire(lock_id)
    while held is None and time.monotonic() < deadline:
        time.sleep(0.1)
        held = _try_acquire(lock_id)
    try:
        yield held is not None
    finally:
        if held is not None:
            _release(held)


@asynccontextmanager
async def distributed_job_lock_async(lock_id: str, wait_s: float = 0.0) -> AsyncIterator[bool]:
    """``distributed_job_lock`` for async handlers: waits without blocking the event loop."""
    deadline = time.monotonic() + wait_s
    held = _try_acquire(lock_id)
    while held is None and time.monotonic() < deadline:
        await asyncio.sleep(0.1)
        held = _try_acquire(lock_id)
    try:
        yield held is not None
    finally:
        if held is not None:
            _release(held)
