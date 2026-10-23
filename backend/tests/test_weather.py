"""The live forecast must never hold planning hostage when Open-Meteo is slow or down."""

from __future__ import annotations

import time

import httpx
import pytest

from app.engine import weather
from app.engine.scenario import load_scenario

LOC = load_scenario().locations["warangal"]


@pytest.fixture(autouse=True)
def clean_state(monkeypatch):
    monkeypatch.setattr(weather, "_mem", {})
    monkeypatch.setattr(weather, "_live_failed_at", {})
    monkeypatch.setattr(weather.time, "sleep", lambda s: None)  # no back-off waits in tests
    monkeypatch.setattr(weather.db, "cache_get", lambda key: None)
    monkeypatch.setattr(weather.db, "cache_put", lambda key, data: None)


def test_forecast_requests_use_short_timeouts(monkeypatch):
    seen = []

    def fake_get(self, url, params=None):
        seen.append(self.timeout)
        raise httpx.ConnectTimeout("simulated")

    monkeypatch.setattr(httpx.Client, "get", fake_get)
    with pytest.raises(weather.WeatherUnavailable):
        weather.fetch_forecast(LOC)
    assert seen and all(t.connect <= 3.0 and t.read <= 5.0 for t in seen)


def test_an_outage_is_not_retried_on_every_request(monkeypatch):
    calls = []

    def failing_get(self, url, params=None):
        calls.append(url)
        raise httpx.ConnectError("simulated outage")

    monkeypatch.setattr(httpx.Client, "get", failing_get)
    cached_payload = {"hourly": {"time": []}}
    weather._mem["forecast:warangal:%.3f:%.3f" % (LOC.lat, LOC.lon)] = (time.time() - 3600, cached_payload)

    data, source, _ = weather.fetch_forecast(LOC)  # live fails, the stale copy is served
    assert source == "cached" and data is cached_payload
    first_attempts = len(calls)
    for _ in range(5):  # within the back-off window: straight to the fallback, no network
        assert weather.fetch_forecast(LOC)[1] == "cached"
    assert len(calls) == first_attempts

    # After the back-off window the live forecast is tried again, and recovers.
    weather._live_failed_at = {k: v - weather.LIVE_RETRY_AFTER_S - 1 for k, v in weather._live_failed_at.items()}
    monkeypatch.setattr(httpx.Client, "get", lambda self, url, params=None: httpx.Response(200, json={"hourly": {"time": ["x"]}}, request=httpx.Request("GET", url)))
    data, source, _ = weather.fetch_forecast(LOC)
    assert source == "live" and data["hourly"]["time"] == ["x"]
