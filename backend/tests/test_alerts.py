"""Operator alerts: formats, cooldown, and the failures that must reach a person.

API tests run on SQLite and on PostgreSQL (see conftest.py)."""

from __future__ import annotations

import json
from datetime import datetime

import httpx
import pytest
from fastapi.testclient import TestClient

from app import alerts, db, messaging, scheduler
from app.engine import planner
from app.engine.weather import climatology_day

KEY = {"X-API-Key": "k"}
HOOK = "https://hooks.example/sunshift"  # a generic JSON webhook
PHONE = "+919876543210"
DAY = "2030-01-15"


@pytest.fixture
def captured(monkeypatch):
    """Every app built in the test sends its alerts here instead of the network."""
    calls: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return httpx.Response(200)

    transport = httpx.MockTransport(handler)
    real = alerts.configure
    monkeypatch.setattr(alerts, "configure", lambda url, cooldown_s=1800.0, _t=None: real(url, cooldown_s, transport))
    yield calls
    real(None)


@pytest.fixture
def offline(monkeypatch):
    """Climatology instead of the network, on the evening before DAY (so DAY is tomorrow)."""
    monkeypatch.setattr(planner, "_weather_for", lambda day, sc, loc_id, params: (climatology_day(day, sc.locations[loc_id], sc.feeder), []))
    monkeypatch.setattr(planner, "ist_now", lambda: datetime(2030, 1, 14, 18, 0, tzinfo=planner.IST))


def events(calls) -> list[dict]:
    alerts.drain()
    return [json.loads(r.content) for r in calls]


# ------------------------------------------------------------------- the module


def test_formats_cooldown_and_failures_never_raise():
    seen: list[httpx.Request] = []
    ok = httpx.MockTransport(lambda r: seen.append(r) or httpx.Response(200))

    alerts.configure(None)
    assert not alerts.enabled() and alerts.kind() == "off"
    assert alerts.alert("x", "t", "text") is False  # off: nothing queued

    alerts.configure("https://ntfy.sh/sunshift-test", 1800, ok)
    assert alerts.alert("dispatch-failed", "SunShift: test", "body text", key="2030-01-15")
    assert not alerts.alert("dispatch-failed", "SunShift: test", "body text", key="2030-01-15")  # cooling down
    assert alerts.alert("dispatch-failed", "SunShift: test", "body text", key="2030-01-16")  # another day
    alerts.drain()
    assert len(seen) == 2 and seen[0].content == b"body text" and seen[0].headers["Title"] == "SunShift: test"

    for url, field in (("https://hooks.slack.com/services/T/B/X", "text"), ("https://discord.com/api/webhooks/1/x", "content")):
        seen.clear()
        alerts.configure(url, 1800, ok)
        alerts.alert("e", "Title", "Text")
        alerts.drain()
        assert "Title" in json.loads(seen[0].content)[field] and "Text" in json.loads(seen[0].content)[field]

    def broken(request):
        raise httpx.ConnectError("unreachable")

    for transport in (httpx.MockTransport(broken), httpx.MockTransport(lambda r: httpx.Response(500))):
        alerts.configure(HOOK, 1800, transport)
        assert alerts.alert("e", "t", "x")
        alerts.drain()  # logged, never raised
    alerts.configure(None)


# ------------------------------------------------------------- what must alert


def test_unsent_sms_and_a_missing_forecast_alert_without_phone_numbers(make_client, captured, offline):
    with make_client(api_key="k", sms_provider="twilio", twilio_sid="AC1", twilio_token="tok", twilio_from="+15005550006",
                     alert_webhook_url=HOOK) as c:
        rejected = httpx.Response(400, json={"message": f"The 'To' number {PHONE} is not a valid phone number."})
        c.app.state.gateway._client = httpx.Client(transport=httpx.MockTransport(lambda r: rejected))
        c.patch("/api/farms/7", json={"phone": PHONE, "language": "en", "smsOptIn": True}, headers=KEY)
        out = c.post("/api/dispatch", json={}, headers=KEY).json()
        assert out["counts"]["failed"] == 1
        sent = {e["event"]: e for e in events(captured)}
        assert set(sent) == {"sms-failed", "weather-fallback"}  # DAY is tomorrow, planned on climatology
        assert "F07" in sent["sms-failed"]["text"] and sent["sms-failed"]["details"]["farms"] == ["F07"]
        assert sent["weather-fallback"]["details"] == {"date": DAY, "source": "climatology"}
        raw = b"".join(r.content for r in captured)
        assert PHONE.encode() not in raw and b"9876543210" not in raw and b"3210" not in raw


def test_a_failed_morning_dispatch_alerts(make_client, captured, offline, monkeypatch):
    from app import api

    async def broken(*args, **kwargs):
        raise RuntimeError("solver crashed")

    with make_client(api_key="k", alert_webhook_url=HOOK) as c:
        monkeypatch.setattr(api, "dispatch_day", broken)
        assert c.portal.call(scheduler.run_scheduled, c.app) is None  # logged, not raised: the loop carries on
        (alert,) = events(captured)
        assert alert["event"] == "dispatch-failed" and DAY in alert["text"] and "POST /api/dispatch" in alert["text"]


def test_a_farmer_change_that_cannot_be_replanned_alerts(make_client, captured, offline, monkeypatch):
    with make_client(api_key="k", alert_webhook_url=HOOK) as c:
        assert c.post("/api/dispatch", json={}, headers=KEY).status_code == 200
        events(captured)
        captured.clear()

        def boom(params):
            raise RuntimeError("internal detail")

        monkeypatch.setattr(planner, "plan_day", boom)
        r = c.post("/api/messaging/webhook", json={"farmId": 7, "command": "SKIP"}, headers=KEY)
        assert r.status_code == 503
        sent = events(captured)
        assert {e["event"] for e in sent} == {"solve-failed", "replan-failed"}
        assert all("internal detail" not in e["text"] for e in sent)


def test_unexpected_errors_and_a_missing_database_alert(make_client, captured, monkeypatch):
    def boom(limit):
        raise RuntimeError("secret internal detail")

    with make_client(alert_webhook_url=HOOK) as c:
        monkeypatch.setattr(messaging, "recent_messages", boom)
        client = TestClient(c.app, raise_server_exceptions=False)  # as a real client sees it: a 500
        for _ in range(3):
            assert client.get("/api/messages").status_code == 500
        (alert,) = events(captured)  # three failures, one alert: the rest are cooling down
        assert alert["event"] == "server-error" and "/api/messages" in alert["text"] and "secret" not in alert["text"]

    captured.clear()
    monkeypatch.setattr(db, "init_db", lambda: "unavailable")
    with make_client(alert_webhook_url=HOOK):
        pass
    assert [e["event"] for e in events(captured)] == ["database-unavailable"]


def test_operators_can_send_a_test_alert(make_client, captured):
    with make_client(api_key="k") as c:
        assert c.get("/api/health").json()["alerts"] == "off"
        assert c.post("/api/alerts/test", headers=KEY).status_code == 409
    with make_client(api_key="k", alert_webhook_url="https://ntfy.sh/sunshift-test") as c:
        assert c.get("/api/health").json()["alerts"] == "ntfy"  # the kind, never the secret URL
        assert c.post("/api/alerts/test").status_code == 401
        assert c.post("/api/alerts/test", headers=KEY).json() == {"queued": True, "to": "ntfy"}
        assert c.post("/api/alerts/test", headers=KEY).status_code == 200  # tests are never held back
        alerts.drain()
        assert len(captured) == 2 and captured[0].headers["Title"] == "SunShift: test alert"
