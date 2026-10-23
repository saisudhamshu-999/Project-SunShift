"""Operations that must hold in production: no duplicate SMS, one dispatch at a time,
farmer commands that hand freed capacity to other farms, and rate limits behind a proxy.

API tests run on SQLite and on PostgreSQL (see conftest.py)."""

from __future__ import annotations

import asyncio
import threading
import time
from datetime import datetime
from datetime import time as dtime

import pytest
from fastapi.testclient import TestClient

from app import db, messaging, scheduler
from app.engine import planner
from app.engine.scenario import load_scenario, window_label
from app.engine.weather import climatology_day
from app.jobs import distributed_job_lock, distributed_job_lock_async

KEY = {"X-API-Key": "k"}
SC = load_scenario()
DAY = "2030-01-15"  # beyond the forecast horizon: climatology, no network, and no "now" slot


@pytest.fixture
def offline_weather(monkeypatch):
    monkeypatch.setattr(planner, "_weather_for", lambda day, sc, loc_id, params: (climatology_day(day, sc.locations[loc_id], sc.feeder), []))


def _plan(c) -> dict:
    r = c.post("/api/plan", json={"date": DAY, "persist": False})
    assert r.status_code == 200, r.text
    return r.json()


# ------------------------------------------------------------------- locks


def test_job_lock_is_exclusive(database):
    db.init_db()
    with distributed_job_lock("dispatch:F07:x") as first:
        with distributed_job_lock("dispatch:F07:x") as second:
            assert first and not second  # one holder at a time, across sessions on PostgreSQL
        with distributed_job_lock("dispatch:F07:y") as other:
            assert other  # different names do not block each other
    with distributed_job_lock("dispatch:F07:x") as again:
        assert again  # released on exit


def test_async_lock_waits_for_the_holder(database):
    db.init_db()
    released = threading.Event()

    def hold():
        with distributed_job_lock("replan:F07:x"):
            time.sleep(0.4)
        released.set()

    holder = threading.Thread(target=hold)
    holder.start()
    time.sleep(0.1)

    async def take():
        async with distributed_job_lock_async("replan:F07:x", wait_s=5) as got:
            return got, released.is_set()

    got, after_release = asyncio.run(take())
    holder.join()
    assert got and after_release


# ---------------------------------------------------------------- dispatch


def test_dispatch_never_sends_the_same_schedule_twice(make_client, offline_weather):
    with make_client(api_key="k") as c:
        for fid in (7, 8):
            c.patch(f"/api/farms/{fid}", json={"phone": f"+9100000000{fid:02d}", "smsOptIn": True, "language": "en"}, headers=KEY)
        first = c.post("/api/dispatch", json={"date": DAY}, headers=KEY).json()
        assert first["counts"]["simulated"] == 2
        again = c.post("/api/dispatch", json={"date": DAY}, headers=KEY).json()  # a retry, a second cron, a double click
        assert again["counts"]["duplicate"] == 2 and again["counts"]["simulated"] == 0
        assert len([m for m in c.get("/api/messages").json() if m["direction"] == "out"]) == 2


def _clock(monkeypatch, *hms):
    monkeypatch.setattr(planner, "ist_now", lambda: datetime(2030, 1, 15, *hms, tzinfo=planner.IST))


def test_dispatch_times_are_parsed_and_scheduled():
    times = scheduler.parse_times(["18:00", " 05:30", "05:30"])
    assert times == [dtime(5, 30), dtime(18, 0)]
    at = lambda *hm: datetime(2030, 1, 15, *hm, tzinfo=planner.IST)  # noqa: E731
    assert scheduler.next_run(at(5, 0), times) == at(5, 30)
    assert scheduler.next_run(at(5, 30), times) == at(18, 0)  # strictly after: never twice for one moment
    assert scheduler.next_run(at(19, 0), times) == datetime(2030, 1, 16, 5, 30, tzinfo=planner.IST)
    with pytest.raises(ValueError):
        scheduler.parse_times(["5.30am"])


def test_the_scheduled_dispatch_sends_once_a_day(make_client, offline_weather, monkeypatch):
    _clock(monkeypatch, 5, 30)  # the morning run: today's plan
    with make_client(api_key="k") as c:
        for fid in (7, 8):
            c.patch(f"/api/farms/{fid}", json={"phone": f"+9100000000{fid:02d}", "smsOptIn": True, "language": "en"}, headers=KEY)
        first = c.portal.call(scheduler.run_once, c.app)
        assert first["status"] == "dispatched" and first["date"] == DAY and first["counts"]["simulated"] == 2
        # Every worker runs the schedule, and an external trigger may fire too: nothing more is sent.
        assert c.portal.call(scheduler.run_once, c.app)["status"] == "already-dispatched"
        again = c.post("/api/dispatch", json={"onlyIfNew": True}, headers=KEY)
        assert again.status_code == 200 and again.json()["status"] == "already-dispatched"
        assert len([m for m in c.get("/api/messages").json() if m["direction"] == "out"]) == 2


def test_the_server_dispatches_at_the_configured_time(make_client, offline_weather, monkeypatch):
    _clock(monkeypatch, 5, 29, 59)  # one second before DISPATCH_TIMES
    with make_client(api_key="k", dispatch_times=["05:30"]) as c:
        deadline = time.monotonic() + 30
        while messaging.latest_dispatch(DAY) is None:
            assert time.monotonic() < deadline, "the scheduled dispatch did not run"
            time.sleep(0.2)
        assert c.get("/api/health").status_code == 200
    with pytest.raises(ValueError):
        with make_client(dispatch_times=["half past five"]):
            pass  # a bad DISPATCH_TIMES stops the server at startup instead of silently never sending


def test_overlapping_dispatches_are_refused(make_client, offline_weather):
    with make_client(api_key="k") as c:
        with distributed_job_lock(f"dispatch:F07:{DAY}") as held:  # another worker is dispatching
            assert held
            r = c.post("/api/dispatch", json={"date": DAY}, headers=KEY)
            assert r.status_code == 409
        assert c.post("/api/dispatch", json={"date": DAY}, headers=KEY).status_code == 200


def test_background_plans_get_the_longer_solver_budget(make_client, offline_weather, monkeypatch):
    budgets = []
    real = planner.plan_day

    def spy(params):
        budgets.append(params.time_limit_s)
        return real(params)

    monkeypatch.setattr(planner, "plan_day", spy)
    with make_client(api_key="k", max_time_limit_s=1.0, background_time_limit_s=2.5) as c:
        assert c.post("/api/plan", json={"date": DAY, "persist": False, "timeLimitS": 9}).status_code == 200
        assert c.post("/api/dispatch", json={"date": DAY}, headers=KEY).status_code == 200
        assert c.post("/api/messaging/webhook", json={"farmId": 7, "command": "SKIP", "date": DAY}, headers=KEY).status_code == 200
    assert budgets == [1.0, 2.5, 2.5]  # a client asking for 9 s gets the cap; dispatch and the re-plan get 2.5 s


# ------------------------------------------------------ farmer commands


def _sent(day: str = DAY) -> dict[int, list[int]]:
    """The schedule farmers last received for ``day``: the baseline commands act on."""
    return {int(k): v for k, v in messaging.latest_dispatch(day).schedule.items()}


def test_skip_hands_the_freed_capacity_to_other_farms(make_client, offline_weather):
    # A short budget: this feeder is deliberately scarce, and a proof within 1% would take the full 15 s.
    with make_client(api_key="k", background_time_limit_s=3.0) as c:
        # A tight feeder: 25 kW and no grid backup, so pumps compete for every slot.
        assert c.patch("/api/feeders/F07", json={"feederLimitKw": 25, "gridBackupKw": 0}, headers=KEY).status_code == 200
        assert c.post("/api/dispatch", json={"date": DAY}, headers=KEY).status_code == 200
        before = _sent()
        target = max(before, key=lambda fid: len(before[fid]))
        others_before = sum(len(v) for fid, v in before.items() if fid != target)

        r = c.post("/api/messaging/webhook", json={"farmId": target, "command": "SKIP", "date": DAY}, headers=KEY)
        assert r.status_code == 200, r.text
        out = r.json()
        assert out["action"] == "skipped" and out["window"] == ""
        assert out["previousWindow"] == window_label(before[target], SC.feeder)
        assert out["slotsGainedByOthers"], "the freed capacity should go to other farms"

        after = _sent()  # the re-plan was sent to the farmers whose windows moved
        assert after.get(target, []) == []
        assert sum(len(v) for fid, v in after.items() if fid != target) > others_before
        replanned = _plan(c)
        assert target not in [f["id"] for f in replanned["farms"]]
        assert max(replanned["sunshift"]["loadKw"]) <= 25 + 1e-6  # still within the feeder limit
        # The change is for that day only.
        other_day = c.post("/api/plan", json={"date": "2030-01-16", "persist": False}).json()
        assert target in [f["id"] for f in other_day["farms"]]


def test_delay_pushes_the_window_back(make_client, offline_weather):
    with make_client(api_key="k") as c:
        assert c.post("/api/dispatch", json={"date": DAY}, headers=KEY).status_code == 200
        before = _sent()
        target = next(fid for fid, slots in sorted(before.items()) if slots and min(slots) < 24)
        start = min(before[target])
        r = c.post("/api/messaging/webhook", json={"farmId": target, "command": "DELAY", "delaySlots": 8, "date": DAY},
                   headers=KEY)
        assert r.status_code == 200, r.text
        out = r.json()
        assert out["action"] == "delayed" and out["previousWindow"] == window_label(before[target], SC.feeder)
        new_slots = _sent()[target]
        assert new_slots and min(new_slots) >= start + 8  # two hours later, and still irrigated
        assert out["window"] == window_label(new_slots, SC.feeder)  # what the farmer was told is what was sent


def test_farmer_commands_are_validated(make_client, offline_weather):
    with make_client(api_key="k") as c:
        body = {"farmId": 7, "command": "CONFIRM", "date": DAY}
        assert c.post("/api/messaging/webhook", json=body).status_code == 401
        confirm = c.post("/api/messaging/webhook", json=body, headers=KEY).json()
        assert confirm["action"] == "confirmed" and confirm["farm"] == "F07"
        assert c.post("/api/messaging/webhook", json={**body, "command": "DELAY"}, headers=KEY).status_code == 422
        assert c.post("/api/messaging/webhook", json={**body, "command": "PANIC"}, headers=KEY).status_code == 422
        assert c.post("/api/messaging/webhook", json={**body, "farmId": 999}, headers=KEY).status_code == 404


# ----------------------------------------------------------- behind a proxy


def test_rate_limits_follow_the_forwarded_client_address(make_client):
    from uvicorn.middleware.proxy_headers import ProxyHeadersMiddleware

    with make_client(rate_limits_enabled=True, rate_read=(1.0, 2)) as c:
        behind_proxy = TestClient(ProxyHeadersMiddleware(c.app, trusted_hosts="*"))

        def health(client, ip):
            return client.get("/api/health", headers={"X-Forwarded-For": ip}).status_code

        assert [health(behind_proxy, "203.0.113.7") for _ in range(3)] == [200, 200, 429]
        assert health(behind_proxy, "198.51.100.4") == 200  # a different client has its own budget

        # An untrusted sender cannot dodge the limit by inventing X-Forwarded-For values.
        direct = TestClient(ProxyHeadersMiddleware(c.app, trusted_hosts="10.0.0.1"))
        codes = [health(direct, f"192.0.2.{i}") for i in range(3)]
        assert codes[-1] == 429
