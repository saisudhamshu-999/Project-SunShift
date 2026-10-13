"""The shipped ML models must keep their held-out performance and plug into planning safely."""

from __future__ import annotations

import json
from dataclasses import replace

import numpy as np
import pandas as pd
import pytest

from app.engine import planner
from app.engine.optimiser import Job, Problem, solve
from app.engine.scenario import load_scenario
from app.engine.weather import climatology_day, slot_times
from app.ml import features as F
from app.ml import models as ml_models

SC = load_scenario()
LOC = SC.locations[SC.default_location]
DAY = (planner.ist_now().date() + pd.Timedelta(days=10)).isoformat()


@pytest.fixture(scope="module")
def holdout():
    path = ml_models.ARTIFACTS / "holdout.npz"
    assert path.is_file(), "missing holdout sample: run python -m app.ml.train"
    return dict(np.load(path))


def forecast_day(day: str = DAY, rain_window: list[float] | None = None):
    """A forecast-shaped day without network: climatology, relabelled as a live forecast."""
    clim = climatology_day(day, LOC, SC.feeder)
    window = rain_window if rain_window is not None else [0.0] * 30
    return replace(clim, source="live", lookahead_precip=window, lookahead_cloud=[40.0] * 30,
                   lookahead_rain_mm=float(sum(window)), lookahead_rain_prob=60.0)


# ------------------------------------------------------------- the artifacts


def test_models_and_card_are_shipped():
    st = ml_models.status()
    assert st["solar"] and st["rain"]
    card = ml_models.card()
    assert card["data"]["test"][0] > card["data"]["train"][0]
    assert card["backtest"] and card["backtest"]["days"] > 100
    assert any("ERA5" in s for s in card["limitations"])


def test_solar_model_beats_the_raw_forecast_on_held_out_data(holdout):
    art = ml_models._load()["solar"]
    X = pd.DataFrame(holdout["solar_X"], columns=F.SOLAR_FEATURES)
    cs, y, raw = holdout["solar_cs"], holdout["solar_obs"], holdout["solar_raw"]
    k50 = np.clip(art["p50"].predict(X), 0, F.K_MAX)
    k10 = np.minimum(np.clip(art["p10"].predict(X) - art["q_lo"], 0, None), k50)
    p50, p10 = k50 * cs, k10 * cs
    rmse = lambda a: float(np.sqrt(np.mean((a - y) ** 2)))  # noqa: E731
    assert rmse(p50) < 0.9 * rmse(raw)  # at least 10% better
    assert np.mean(np.abs(p50 - y)) < np.mean(np.abs(raw - y))
    assert abs(np.mean(p50 - y)) < abs(np.mean(raw - y))  # less biased
    assert np.all(p10 <= p50 + 1e-9) and np.all(p10 >= 0)
    below = float(np.mean(y < p10))
    assert 0.05 <= below <= 0.16, below  # target 10%; the card reports the exact figure


def test_rain_model_is_better_calibrated_than_the_forecast(holdout):
    art = ml_models._load()["rain"]
    rows = pd.DataFrame(holdout["rain_X"], columns=F.RAIN_FEATURES)
    y = holdout["rain_y"].astype(float)
    p = art["model"].predict_proba(F.rain_matrix(rows))[:, 1]
    assert np.all((p >= 0) & (p <= 1))
    yes_no = (rows.fc_sum >= SC.policy.rain_min_mm).astype(float).to_numpy()
    brier = lambda q: float(np.mean((q - y) ** 2))  # noqa: E731
    assert brier(p) < 0.8 * brier(yes_no)
    assert brier(p) < brier(np.full_like(y, y.mean()))  # better than knowing only the base rate


def test_more_forecast_rain_means_higher_probability():
    base = forecast_day()
    probs = [ml_models.rain_probability(replace(base, lookahead_precip=[mm / 6] * 6 + [0.0] * 24), LOC.lat)
             for mm in (0, 2, 8, 30)]
    assert probs == sorted(probs) and probs[-1] > 0.5 > probs[0]


# ------------------------------------------------------------ live planning


def test_solar_curves_are_physical():
    dw = forecast_day()
    p50, p10 = ml_models.solar_curves(dw, LOC, SC.feeder)
    cs = F.clear_sky(LOC, slot_times(DAY, SC.feeder))["ghi"].to_numpy()
    assert len(p50) == SC.feeder.slots
    assert np.all(p10 >= 0) and np.all(p10 <= p50 + 1e-9)
    assert np.all(p50 <= F.K_MAX * cs + 1e-6)
    assert np.all(p50[cs < F.DAYLIGHT_CS] == 0)  # no sun at night


def test_corrections_apply_only_to_forecasts():
    clim = climatology_day(DAY, LOC, SC.feeder)
    same, ratio, info = ml_models.apply_to_forecast(clim, LOC, SC.feeder)
    assert same is clim and ratio is None
    assert not info["solar"]["applied"] and "climatology" in info["solar"]["reason"]

    dw = forecast_day(rain_window=[2.0] * 10 + [0.0] * 20)
    out, ratio, info = ml_models.apply_to_forecast(dw, LOC, SC.feeder)
    assert info["solar"]["applied"] and info["rain"]["applied"]
    assert out.lookahead_rain_prob == pytest.approx(info["rain"]["calibratedProb"], abs=0.1)
    assert info["rain"]["forecastProb"] == 60.0
    assert np.all((ratio >= 0) & (ratio <= 1))
    assert not np.allclose(out.ghi, dw.ghi)
    assert out.et0 != dw.et0  # ET0 follows the corrected radiation


def _plan_with_forecast(monkeypatch, **extra):
    monkeypatch.setattr(planner, "_weather_for", lambda day, sc, loc_id, params: (forecast_day(day), []))
    return planner.plan_day(planner.PlanParams(date=DAY, persist=False, time_limit_s=1.0, **extra))


def test_plans_use_the_likely_curve_and_report_the_cautious_one(monkeypatch):
    plan = _plan_with_forecast(monkeypatch)
    ml = plan["meta"]["ml"]
    assert ml["solar"]["applied"] and ml["rain"]["applied"]
    assert plan["meta"]["sources"]["solar"] == "pvlib + ML correction"
    solar = plan["solar"]
    assert all(lo <= hi + 1e-6 for lo, hi in zip(solar["cautiousAcKw"], solar["acKw"]))
    assert solar["loadAboveCautiousKwh"] >= 0
    assert max(plan["sunshift"]["loadKw"]) <= plan["feeder"]["limitKw"] + 1e-6
    json.dumps(plan)  # serialisable


def test_scenario_modes_do_not_use_the_cautious_curve(monkeypatch):
    plan = _plan_with_forecast(monkeypatch, weather_mode="clear")
    assert "cautiousAcKw" not in plan["solar"]
    assert "scenario" in plan["meta"]["ml"]["solar"]["riskNote"]


def test_planning_without_models_falls_back(monkeypatch):
    monkeypatch.setattr(ml_models, "_load", lambda: {"solar": None, "rain": None, "card": None})
    plan = _plan_with_forecast(monkeypatch)
    assert not plan["meta"]["ml"]["solar"]["applied"]
    assert plan["meta"]["ml"]["solar"]["reason"] == "model not available"
    assert plan["meta"]["sources"]["solar"] == "pvlib"
    assert "cautiousAcKw" not in plan["solar"]


# ---------------------------------------------------------------- optimiser


def test_cautious_curve_steers_pumping_to_dependable_hours():
    """Same expected sun all day, but the morning could fail entirely: pumping should move to the afternoon."""
    slots = 48
    solar = [60.0] * slots
    low = [0.0 if t < 24 else 55.0 for t in range(slots)]
    jobs = [Job(farm_id=i, power_kw=4.8, flow_m3h=12, required_slots=8, allowed=list(range(slots)), weight=20,
                min_run=2, max_starts=2) for i in range(1, 6)]
    common = dict(jobs=jobs, solar_kw=solar, feeder_limit_kw=60, grid_cap_kw=0, slots=slots, time_limit_s=2.0, workers=4)
    plain = solve(Problem(**common))
    aware = solve(Problem(**common, solar_low_kw=low))
    at_risk = lambda sol: sum(max(0.0, sol.load_kw[t] - low[t]) for t in range(slots))  # noqa: E731
    assert at_risk(plain) > 0  # without the curve, the morning gets used
    assert at_risk(aware) < at_risk(plain)
    served = lambda sol: sum(len(s) for s in sol.on.values())  # noqa: E731
    assert served(aware) == served(plain)  # the same water, at safer times
