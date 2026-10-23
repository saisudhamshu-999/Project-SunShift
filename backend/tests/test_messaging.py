"""Farmer SMS: composing, the Twilio client, dispatch, and replies that re-plan the day."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
from datetime import datetime, timedelta
from urllib.parse import urlencode

import httpx
import pytest

from app import messaging
from app.engine import planner
from app.engine.scenario import load_scenario
from app.engine.weather import climatology_day

KEY = {"X-API-Key": "k"}
PHONE = "+919876543210"
SC = load_scenario()


def test_indian_number_formatting():
    assert messaging.fmt(1234567) == "12,34,567"
    assert messaging.fmt(1234.5) == "1,235"  # half away from zero, as Intl does
    assert messaging.fmt(12.5) == "13"
    assert messaging.fmt(999) == "999"
    assert messaging.fmt(2.345, 1) == "2.3"


@pytest.mark.parametrize("text,kind,hour", [
    ("1", "confirm", None), (" OK ", "confirm", None), ("సరే", "confirm", None), ("2", "change", None),
    ("0", "skip", None), ("nahi", "skip", None), ("14:00", "time", 14.0), ("9.30", "time", 9.5), ("15", "time", 15.0),
    ("23:00", "unknown", None), ("hello", "unknown", None),
])
def test_reply_parsing(text, kind, hour):
    r = messaging.parse_reply(text)
    assert r.kind == kind and r.hour == hour


def test_twilio_client_sends_and_reports_errors():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"], seen["auth"], seen["form"] = str(request.url), request.headers["authorization"], dict(
            httpx.QueryParams(request.content.decode()))
        if seen["form"]["To"] == "+910000000000":
            return httpx.Response(400, json={"message": "The 'To' number is not a valid phone number."})
        return httpx.Response(201, json={"sid": "SM123"})

    gw = messaging.TwilioGateway("AC1", "secret", "+15005550006", transport=httpx.MockTransport(handler))
    ok = gw.send(PHONE, "hello")
    assert ok.status == "sent" and ok.provider_id == "SM123"
    assert seen["url"].endswith("/Accounts/AC1/Messages.json")
    assert seen["form"] == {"To": PHONE, "From": "+15005550006", "Body": "hello"}
    assert seen["auth"] == "Basic " + base64.b64encode(b"AC1:secret").decode()
    bad = gw.send("+910000000000", "hello")
    assert bad.status == "failed" and "not a valid phone number" in bad.error


# ------------------------------------------------------------- API flow


@pytest.fixture
def offline_weather(monkeypatch):
    """Dispatch plans the real day; use climatology instead of the network, and a fixed
    evening clock so the planning day is tomorrow with no pump slots already run (in the
    afternoon a re-plan keeps the morning's slots, and the outcome would depend on the hour)."""
    monkeypatch.setattr(planner, "_weather_for", lambda day, sc, loc_id, params: (climatology_day(day, sc.locations[loc_id], sc.feeder), []))
    monkeypatch.setattr(planner, "ist_now", lambda: datetime(2030, 1, 14, 18, 0, tzinfo=planner.IST))


def _register(c, farm_id=7, lang="te"):
    r = c.patch(f"/api/farms/{farm_id}", json={"phone": PHONE, "language": lang, "smsOptIn": True}, headers=KEY)
    assert r.status_code == 200, r.text
    return r.json()


def _reply(c, text, headers=KEY):
    return c.post("/api/sms/inbound", content=urlencode({"From": PHONE, "Body": text}),
                  headers={"content-type": "application/x-www-form-urlencoded", **headers})


def test_phones_are_stored_but_never_returned(make_client):
    with make_client(api_key="k") as c:
        farm = _register(c)
        assert farm["phone"] == "+91••••••3210" and farm["smsOptIn"] is True
        everything = json.dumps([c.get("/api/feeders/F07").json(), c.get("/api/farms/7").json(), c.get("/api/messages").json()])
        assert PHONE not in everything
        assert c.patch("/api/farms/7", json={"phone": "98765"}, headers=KEY).status_code == 422


def test_dispatch_sends_each_opted_in_farmer_their_window(make_client, offline_weather):
    with make_client(api_key="k") as c:
        _register(c, lang="hi")
        assert c.post("/api/dispatch", json={}).status_code == 401  # no key
        assert c.post("/api/dispatch", json={}, headers={"X-API-Key": "wrong"}).status_code == 401
        dry = c.post("/api/dispatch", json={"dryRun": True}, headers=KEY).json()
        assert dry["dryRun"] and c.get("/api/messages").json() == []  # a dry run records nothing
        out = c.post("/api/dispatch", json={}, headers=KEY).json()
        assert out["provider"] == "simulated"
        assert out["counts"]["simulated"] == 1 and out["counts"]["noPhone"] == 19
        msg = out["messages"][0]
        assert msg["code"] == "F07" and msg["language"] == "hi" and msg["body"].startswith("सनशिफ्ट · खेत 07")
        logged = c.get("/api/messages").json()
        assert len(logged) == 1 and logged[0]["status"] == "simulated" and "phone" not in json.dumps(logged).lower()


def test_replies_confirm_ask_and_need_auth(make_client, offline_weather):
    with make_client(api_key="k") as c:
        _register(c, lang="en")
        c.post("/api/dispatch", json={}, headers=KEY)
        assert _reply(c, "1", headers={}).status_code in (401, 403)  # simulated mode: key required
        r = _reply(c, "1").json()
        assert r["action"] == "confirmed" and (r["reply"].startswith("Confirmed. Pump window") or "No irrigation" in r["reply"])
        assert _reply(c, "2").json()["action"] == "asked-time"
        assert _reply(c, "what?").json()["action"] == "help"
        inbound = [m for m in c.get("/api/messages").json() if m["direction"] == "in"]
        assert [m["body"] for m in inbound] == ["what?", "2", "1"]


def test_a_new_time_replans_the_day_and_notifies_moved_farmers(make_client, offline_weather):
    with make_client(api_key="k") as c:
        for fid in (7, 8, 9):
            c.patch(f"/api/farms/{fid}", json={"phone": f"+9198765432{fid:02d}", "smsOptIn": True, "language": "en"}, headers=KEY)
        _register(c, lang="en")  # farm 7 gets the test phone
        first = c.post("/api/dispatch", json={}, headers=KEY).json()
        assert first["counts"]["simulated"] == 3
        r = _reply(c, "15:00").json()  # the background re-plan runs before the test client returns
        assert r["action"] == "replanning"
        day = first["date"]
        plan = c.post("/api/plan", json={"date": day, "persist": False}).json()
        f7 = next(f for f in plan["farms"] if f["id"] == 7)
        assert f7["schedule"]["slots"] and min(f7["schedule"]["slots"]) >= 36  # served, but not before 15:00 (slot 36)
        updates = [m for m in c.get("/api/messages").json() if m["direction"] == "out" and "updated" in m["body"].lower()]
        assert "F07" in [m["code"] for m in updates]  # the farmer hears their new window
        assert all(m["code"] in ("F07", "F08", "F09") for m in updates)  # only registered, moved farms are messaged


def test_skipping_removes_the_farm_for_the_day(make_client, offline_weather):
    with make_client(api_key="k") as c:
        _register(c, lang="te")
        day = c.post("/api/dispatch", json={}, headers=KEY).json()["date"]
        r = _reply(c, "0").json()
        assert r["action"] == "skipped" and r["reply"] == messaging.T["te"]["skipped"]
        plan = c.post("/api/plan", json={"date": day, "persist": False}).json()
        assert 7 not in [f["id"] for f in plan["farms"]]
        next_day = (datetime.fromisoformat(day) + timedelta(days=1)).date().isoformat()
        other_day = c.post("/api/plan", json={"date": next_day, "persist": False}).json()
        assert 7 in [f["id"] for f in other_day["farms"]]  # the change is for that day only


def test_twilio_webhook_requires_a_valid_signature(make_client, offline_weather):
    with make_client(api_key="k", sms_provider="twilio", twilio_sid="AC1", twilio_token="tok", twilio_from="+15005550006",
                     public_base_url="https://sunshift.example") as c:
        c.app.state.gateway._client = httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(201, json={"sid": "SM1"})))
        _register(c, lang="en")
        params = {"From": PHONE, "Body": "2"}

        def signed(sig):
            return c.post("/api/sms/inbound", content=urlencode(params),
                          headers={"content-type": "application/x-www-form-urlencoded", "X-Twilio-Signature": sig})

        payload = "https://sunshift.example/api/sms/inbound" + "".join(k + params[k] for k in sorted(params))
        good = base64.b64encode(hmac.new(b"tok", payload.encode(), hashlib.sha1).digest()).decode()
        assert signed("forged").status_code == 403
        r = signed(good)
        assert r.status_code == 200 and r.headers["content-type"].startswith("application/xml")
        assert "<Message>Reply with a time" in r.text
        out = c.post("/api/dispatch", json={}, headers=KEY).json()
        assert out["provider"] == "twilio" and out["counts"]["sent"] == 1
