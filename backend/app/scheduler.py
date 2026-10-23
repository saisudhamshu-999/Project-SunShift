"""The daily dispatch, without an external cron.

``DISPATCH_TIMES="05:30"`` (India time; several allowed, e.g. ``"05:30,18:00"``) makes the
server plan the day and text every opted-in farmer at those times. Before 16:00 that is
today's plan, after it tomorrow's (``planner.default_plan_date``).

Every worker runs the loop. The dispatch lock and the already-dispatched check make sure
exactly one of them sends, once per day, and a later trigger (another time in the list,
or an external scheduler calling ``/api/dispatch`` with ``onlyIfNew``) changes nothing.

A server that sleeps when idle (Render's free tier, for example) cannot wake itself: use
the scheduled GitHub Actions workflow (``.github/workflows/daily-dispatch.yml``) there.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, time, timedelta

from fastapi import FastAPI

from . import alerts
from .engine import planner

log = logging.getLogger("sunshift.scheduler")


def parse_times(values: list[str]) -> list[time]:
    """``["05:30", "18:00"]`` -> sorted times. Invalid entries are a configuration error."""
    out = set()
    for v in values:
        try:
            hh, mm = v.strip().split(":")
            out.add(time(int(hh), int(mm)))
        except ValueError:
            raise ValueError(f"DISPATCH_TIMES: {v!r} is not a time like 05:30") from None
    return sorted(out)


def next_run(now: datetime, times: list[time]) -> datetime:
    """The first scheduled moment strictly after ``now`` (same timezone as ``now``)."""
    for days in (0, 1):
        d = now.date() + timedelta(days=days)
        for t in times:
            at = datetime.combine(d, t, tzinfo=now.tzinfo)
            if at > now:
                return at
    raise ValueError("no dispatch times")


async def run_once(app: FastAPI) -> dict:
    from .api import dispatch_day  # the API module builds on the app; import late

    day = planner.default_plan_date()
    out = await dispatch_day(app, day, only_if_new=True)
    if out["status"] == "dispatched":
        counts = {k: v for k, v in out["counts"].items() if v}
        log.info("scheduled dispatch for %s: %s", day, counts)
    else:
        log.info("scheduled dispatch for %s: %s", day, out["status"])
    return out


async def run_scheduled(app: FastAPI) -> dict | None:
    """One scheduled dispatch; a failure is logged and sent to the operator as an alert."""
    try:
        return await run_once(app)
    except asyncio.CancelledError:
        raise
    except Exception as exc:
        log.exception("scheduled dispatch failed; the next one runs at the next scheduled time")
        detail = getattr(exc, "detail", None) or type(exc).__name__
        alerts.alert("dispatch-failed", "SunShift: the morning message was not sent",
                     f"The scheduled dispatch for {planner.default_plan_date()} failed ({detail}). Farmers have "
                     "not been told their pump times. Send it by hand with POST /api/dispatch once the cause "
                     "is fixed; the server log has the details.", key=planner.default_plan_date())
        return None


async def run_daily(app: FastAPI, times: list[time]) -> None:
    log.info("daily dispatch at %s IST", ", ".join(t.strftime("%H:%M") for t in times))
    while True:
        now = planner.ist_now()
        at = next_run(now, times)
        await asyncio.sleep((at - now).total_seconds())
        await run_scheduled(app)
        await asyncio.sleep(1)  # never fire twice for the same minute
