"""Load the trained models and apply them to a day's forecast.

The artifacts in ``artifacts/`` are produced by ``python -m app.ml.train``. They are
joblib (pickle) files, so they are only ever loaded from this package directory, never
from user input. If they are missing or cannot be loaded, every function here returns
None and planning carries on with the raw forecast, labelled as such.
"""

from __future__ import annotations

import json
import logging
from functools import lru_cache
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

from ..engine.scenario import Feeder, Location
from ..engine.weather import DayWeather, slot_times
from . import features as F

log = logging.getLogger("sunshift.ml")
ARTIFACTS = Path(__file__).resolve().parent / "artifacts"


@lru_cache(maxsize=1)
def _load() -> dict[str, Any]:
    out: dict[str, Any] = {"solar": None, "rain": None, "card": None}
    try:
        import joblib
        import sklearn
    except ImportError:  # pragma: no cover - scikit-learn is a runtime dependency
        log.warning("scikit-learn unavailable: ML corrections disabled")
        return out
    for name in ("solar", "rain"):
        path = ARTIFACTS / f"{name}.joblib"
        if not path.is_file():
            continue
        try:
            art = joblib.load(path)
            if art.get("sklearn") != sklearn.__version__:
                log.warning("%s model was trained with scikit-learn %s, running %s", name, art.get("sklearn"), sklearn.__version__)
            out[name] = art
        except Exception:
            log.exception("could not load the %s model", name)
    card = ARTIFACTS / "model_card.json"
    if card.is_file():
        out["card"] = json.loads(card.read_text(encoding="utf-8"))
    return out


def status() -> dict[str, Any]:
    m = _load()
    return {
        "solar": m["solar"]["version"] if m["solar"] else None,
        "rain": m["rain"]["version"] if m["rain"] else None,
    }


def card() -> dict[str, Any] | None:
    return _load()["card"]


def solar_curves(dw: DayWeather, loc: Location, feeder: Feeder) -> tuple[np.ndarray, np.ndarray] | None:
    """Likely (P50) and cautious (P10) GHI per planning slot, or None without a model."""
    art = _load()["solar"]
    if art is None:
        return None
    times = slot_times(dw.date, feeder)
    precip_per_h = np.asarray(dw.precip, dtype=float) / feeder.slot_hours
    cloud_day = F.daylight_mean(dw.cloud, F.clear_sky(loc, times)["ghi"].to_numpy())
    X, cs = F.solar_features(times, dw.ghi, dw.cloud, precip_per_h, np.full(len(times), cloud_day), loc)
    k50 = np.clip(art["p50"].predict(X[art["features"]]), 0, F.K_MAX)
    k10 = np.clip(art["p10"].predict(X[art["features"]]) - art["q_lo"], 0, None)
    k10 = np.minimum(k10, k50)
    night = cs < F.DAYLIGHT_CS
    p50 = np.where(night, 0.0, k50 * cs)
    p10 = np.where(night, 0.0, k10 * cs)
    return p50, p10


def rain_probability(dw: DayWeather, lat: float) -> float | None:
    """Calibrated probability (0-1) of at least the policy's minimum rain in the look-ahead."""
    art = _load()["rain"]
    if art is None or not dw.lookahead_precip:
        return None
    row = pd.DataFrame([F.rain_features(dw.lookahead_precip, dw.lookahead_cloud, dw.date, lat)])
    return float(art["model"].predict_proba(F.rain_matrix(row)[art["features"]])[0, 1])


def apply_to_forecast(dw: DayWeather, loc: Location, feeder: Feeder) -> tuple[DayWeather, np.ndarray | None, dict[str, Any]]:
    """Apply both models to a forecast day.

    Returns the corrected day (calibrated rain probability, likely-solar GHI with ET0
    recomputed), the per-slot ratio of cautious to likely solar (None without a solar
    model), and a description of what was done for the plan's metadata.
    """
    import pvlib
    from dataclasses import replace

    from ..engine.weather import _recompute_et0, _scale_rs_by_slots

    info: dict[str, Any] = {"solar": {"applied": False}, "rain": {"applied": False}}
    if dw.source not in ("live", "cached"):
        reason = f"nothing to correct: weather is {dw.source}, not a forecast"
        info["solar"]["reason"] = info["rain"]["reason"] = reason
        return dw, None, info
    versions = status()
    out = dw
    p = rain_probability(dw, loc.lat)
    if p is None:
        info["rain"]["reason"] = "model not available"
    else:
        out = replace(out, lookahead_rain_prob=100 * p)
        info["rain"] = {"applied": True, "model": versions["rain"], "forecastProb": round(dw.lookahead_rain_prob, 1),
                        "calibratedProb": round(100 * p, 1), "forecastMm": round(dw.lookahead_rain_mm, 1)}
    curves = solar_curves(out, loc, feeder)
    if curves is None:
        info["solar"]["reason"] = "model not available"
        return out, None, info
    p50, p10 = curves
    times = slot_times(dw.date, feeder)
    zen = pvlib.solarposition.get_solarposition(times, loc.lat, loc.lon, altitude=loc.elevation_m)["zenith"].to_numpy()
    split = pvlib.irradiance.erbs(p50, zen, times)
    old = np.asarray(dw.ghi, dtype=float)
    out = replace(out, ghi=p50, dni=np.nan_to_num(np.asarray(split["dni"])), dhi=np.nan_to_num(np.asarray(split["dhi"])))
    _scale_rs_by_slots(out, old)  # the day's radiation follows the corrected curve, and so does ET0
    _recompute_et0(out, loc)
    h = feeder.slot_hours / 1000
    info["solar"] = {
        "applied": True, "model": versions["solar"],
        "forecastKwhM2": round(float(old.sum() * h), 3), "likelyKwhM2": round(float(p50.sum() * h), 3),
        "cautiousKwhM2": round(float(p10.sum() * h), 3),
    }
    ratio = np.where(p50 > 1e-6, p10 / np.maximum(p50, 1e-6), 1.0)
    return out, np.clip(ratio, 0, 1), info
