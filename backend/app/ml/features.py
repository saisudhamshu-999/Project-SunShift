"""Feature construction shared by training and live planning."""

from __future__ import annotations

import numpy as np
import pandas as pd
import pvlib

from ..engine.scenario import Location
from ..engine.weather import clear_sky

SOLAR_FEATURES = [
    "k_fc",  # forecast clear-sky index
    "fc_ghi",  # forecast GHI, W/m2
    "cloud_fc",  # forecast cloud cover, %
    "cloud_day_fc",  # forecast cloud cover averaged over the day's daylight hours, %
    "precip_fc",  # forecast precipitation, mm/h
    "elevation",  # solar elevation, degrees
    "hour",  # local solar-day hour of the interval midpoint
    "doy_sin",
    "doy_cos",
    "lat",
]
RAIN_FEATURES = [
    "fc_sum",  # forecast rain over the look-ahead window, mm
    "fc_max",  # largest forecast hourly rain, mm
    "fc_wet_hours",  # forecast hours with at least 0.1 mm
    "fc_first12",  # forecast rain in the first 12 hours, mm
    "cloud_mean",  # forecast cloud cover over the window, %
    "doy_sin",
    "doy_cos",
    "lat",
]
DAYLIGHT_CS = 20.0  # W/m2 of clear-sky GHI below which an interval counts as night
K_MAX = 1.3  # clear-sky index cap (cloud enhancement rarely exceeds this for hourly means)


def _doy(times: pd.DatetimeIndex) -> tuple[np.ndarray, np.ndarray]:
    angle = 2 * np.pi * (times.dayofyear.to_numpy() - 1) / 365.25
    return np.sin(angle), np.cos(angle)


def solar_features(
    times_mid: pd.DatetimeIndex, fc_ghi, fc_cloud, fc_precip, cloud_day, loc: Location
) -> tuple[pd.DataFrame, np.ndarray]:
    """Features for intervals centred on ``times_mid`` (tz-aware). Returns (X, clear-sky GHI)."""
    cs = clear_sky(loc, times_mid)["ghi"].to_numpy()
    elev = pvlib.solarposition.get_solarposition(times_mid, loc.lat, loc.lon, altitude=loc.elevation_m)["apparent_elevation"].to_numpy()
    fc_ghi = np.asarray(fc_ghi, dtype=float)
    s, c = _doy(times_mid)
    X = pd.DataFrame({
        "k_fc": np.clip(fc_ghi / np.maximum(cs, 1.0), 0, 1.5),
        "fc_ghi": fc_ghi,
        "cloud_fc": np.asarray(fc_cloud, dtype=float),
        "cloud_day_fc": np.asarray(cloud_day, dtype=float),
        "precip_fc": np.asarray(fc_precip, dtype=float),
        "elevation": elev,
        "hour": times_mid.hour.to_numpy() + times_mid.minute.to_numpy() / 60,
        "doy_sin": s,
        "doy_cos": c,
        "lat": np.full(len(times_mid), loc.lat),
    })[SOLAR_FEATURES]
    return X, cs


def daylight_mean(values, cs) -> float:
    values, cs = np.asarray(values, dtype=float), np.asarray(cs, dtype=float)
    day = cs >= DAYLIGHT_CS
    return float(values[day].mean()) if day.any() else float(values.mean())


def rain_matrix(rows: pd.DataFrame) -> pd.DataFrame:
    """Model inputs for the rain model: rain amounts on a log scale, everything roughly unit-scaled."""
    X = rows[RAIN_FEATURES].astype(float).copy()
    for k in ("fc_sum", "fc_max", "fc_first12"):
        X[k] = np.log1p(X[k])
    X["fc_wet_hours"] = X["fc_wet_hours"] / 30.0
    X["cloud_mean"] = X["cloud_mean"] / 100.0
    X["lat"] = (X["lat"] - 18.0) / 5.0
    return X


def rain_features(window_precip, window_cloud, day: str, lat: float) -> dict[str, float]:
    """Features of the forecast for a rain look-ahead window (hourly values from 06:00)."""
    p = np.nan_to_num(np.asarray(window_precip, dtype=float))
    cloud = np.nan_to_num(np.asarray(window_cloud, dtype=float))
    angle = 2 * np.pi * (pd.Timestamp(day).dayofyear - 1) / 365.25
    return {
        "fc_sum": float(p.sum()),
        "fc_max": float(p.max()) if len(p) else 0.0,
        "fc_wet_hours": float((p >= 0.1).sum()),
        "fc_first12": float(p[:12].sum()),
        "cloud_mean": float(cloud.mean()) if len(cloud) else 0.0,
        "doy_sin": float(np.sin(angle)),
        "doy_cos": float(np.cos(angle)),
        "lat": float(lat),
    }
