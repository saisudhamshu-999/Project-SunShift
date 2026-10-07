"""End-to-end planning without the network: weather falls back to climatology."""

import pytest

from app.engine import planner, weather
from app.engine.scenario import load_scenario
from app.engine.solar import pv_profile


@pytest.fixture(autouse=True)
def offline(monkeypatch):
    def boom(*_a, **_k):
        raise weather.WeatherUnavailable("offline test")

    monkeypatch.setattr(weather, "_get_json", boom)
    monkeypatch.setattr(weather, "_mem", {})
    monkeypatch.setattr(weather.db, "cache_get", lambda key: None)
    monkeypatch.setattr(weather.db, "cache_put", lambda key, payload: None)


def test_pv_profile_is_physical():
    sc = load_scenario()
    loc = sc.locations["warangal"]
    dw = weather.climatology_day("2026-03-15", loc, sc.feeder)
    pv = pv_profile(dw, loc, sc.feeder)
    assert pv.ac_kw.max() <= sc.feeder.inverter_kw + 1e-6
    assert pv.ac_kw[0] < pv.ac_kw[24]  # dawn below noon
    assert 200 < pv.energy_kwh(sc.feeder.slot_hours) < sc.feeder.pv_kwp * 7


def test_plan_day_offline_uses_climatology_and_respects_limits():
    r = planner.plan_day(planner.PlanParams(date="2026-03-15", persist=False, time_limit_s=1.5))
    assert r["meta"]["sources"]["weather"] == "climatology"
    feeder = r["feeder"]
    load = r["sunshift"]["loadKw"]
    solar = r["solar"]["acKw"]
    assert max(load) <= feeder["limitKw"] + 1e-6
    assert all(l <= s + feeder["gridBackupKw"] + 0.2 for l, s in zip(load, solar))
    assert r["binding"]["constraint"] in ("NONE", "SOLAR", "FEEDER", "AVAILABILITY")
    assert len(r["farms"]) == 20


def test_uncoordinated_overloads_where_sunshift_does_not():
    r = planner.plan_day(planner.PlanParams(date="2026-03-15", weather_mode="heatwave", persist=False, time_limit_s=1.5))
    assert r["sunshift"]["metrics"]["overloadSlots"] == 0
    assert r["uncoordinated"]["metrics"]["peakDemandKw"] >= r["sunshift"]["metrics"]["peakDemandKw"]


def test_rain_injection_defers_irrigation():
    dry = planner.plan_day(planner.PlanParams(date="2026-03-15", weather_mode="clear", persist=False, time_limit_s=1.0))
    wet = planner.plan_day(planner.PlanParams(date="2026-03-15", weather_mode="rain", rain_mm=30, persist=False,
                                              time_limit_s=1.0))
    assert wet["totals"]["farmsDeferred"] > 0
    assert wet["totals"]["demandM3"] < dry["totals"]["demandM3"]
