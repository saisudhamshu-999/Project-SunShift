"""Runtime settings, read from environment variables when the app is created."""

from __future__ import annotations

import os
from dataclasses import dataclass, field


def _int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, default))
    except ValueError:
        return default


def _float(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, default))
    except ValueError:
        return default


def _rate(name: str, default: str) -> tuple[float, int]:
    """'30/12' means 30 requests per minute with bursts of up to 12."""
    raw = os.environ.get(name, default)
    try:
        per_min, burst = raw.split("/")
        return float(per_min), int(burst)
    except ValueError:
        per_min, burst = default.split("/")
        return float(per_min), int(burst)


@dataclass
class Settings:
    # Solver capacity, per process
    solver_workers: int = 2
    max_queued_jobs: int = 16
    max_time_limit_s: float = 5.0
    # Solver budget for plans the server makes on its own (dispatch, farmer re-plans). They
    # are not interactive, and scarce days need 7-20 s to prove a schedule within 1% of the
    # best possible; the solver stops as soon as it has.
    background_time_limit_s: float = 15.0
    max_concurrent_seasons: int = 1
    # Result reuse: identical requests within these windows share one solve
    plan_cache_s: int = 120
    study_cache_s: int = 600
    # Rate limits per client IP: (requests per minute, burst)
    rate_limits_enabled: bool = True
    rate_compute: tuple[float, int] = (30.0, 12)
    rate_season: tuple[float, int] = (6.0, 2)
    rate_admin: tuple[float, int] = (60.0, 20)
    rate_read: tuple[float, int] = (1200.0, 200)
    # Security
    api_key: str | None = None
    allowed_origins: list[str] = field(default_factory=list)
    # India-time moments the server dispatches the day's plan to farmers itself ("05:30");
    # empty means off, and something outside calls /api/dispatch (see scheduler.py).
    dispatch_times: list[str] = field(default_factory=list)
    # Farmer SMS: 'simulated' (record only) or 'twilio'
    sms_provider: str = "simulated"
    twilio_sid: str | None = None
    twilio_token: str | None = None
    twilio_from: str | None = None
    # The public URL Twilio calls (behind a proxy the request URL differs; signatures use this)
    public_base_url: str | None = None
    # Housekeeping
    runs_retention: int = 5000
    jobs_retention_h: int = 24

    @classmethod
    def from_env(cls) -> Settings:
        origins = [o.strip() for o in os.environ.get("ALLOWED_ORIGINS", "").split(",") if o.strip()]
        return cls(
            solver_workers=max(1, _int("SOLVER_WORKERS", 2)),
            max_queued_jobs=max(0, _int("MAX_QUEUED_JOBS", 16)),
            max_time_limit_s=max(0.2, _float("MAX_TIME_LIMIT_S", 5.0)),
            background_time_limit_s=max(0.2, min(30.0, _float("BACKGROUND_TIME_LIMIT_S", 15.0))),
            max_concurrent_seasons=max(1, _int("MAX_CONCURRENT_SEASONS", 1)),
            plan_cache_s=max(0, _int("PLAN_CACHE_S", 120)),
            study_cache_s=max(0, _int("STUDY_CACHE_S", 600)),
            rate_limits_enabled=os.environ.get("RATE_LIMITS", "on").lower() not in ("0", "off", "false", "no"),
            rate_compute=_rate("RATE_LIMIT_COMPUTE", "30/12"),
            rate_season=_rate("RATE_LIMIT_SEASON", "6/2"),
            rate_admin=_rate("RATE_LIMIT_ADMIN", "60/20"),
            rate_read=_rate("RATE_LIMIT_READ", "1200/200"),
            api_key=os.environ.get("SUNSHIFT_API_KEY") or None,
            dispatch_times=[t.strip() for t in os.environ.get("DISPATCH_TIMES", "").split(",") if t.strip()],
            allowed_origins=origins,
            sms_provider=os.environ.get("SMS_PROVIDER", "simulated").strip().lower(),
            twilio_sid=os.environ.get("TWILIO_ACCOUNT_SID") or None,
            twilio_token=os.environ.get("TWILIO_AUTH_TOKEN") or None,
            twilio_from=os.environ.get("TWILIO_FROM") or None,
            public_base_url=os.environ.get("PUBLIC_BASE_URL") or None,
            runs_retention=max(100, _int("RUNS_RETENTION", 5000)),
            jobs_retention_h=max(1, _int("JOBS_RETENTION_H", 24)),
        )
