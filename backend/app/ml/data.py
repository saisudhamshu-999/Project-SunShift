"""Training data: Open-Meteo day-ahead forecasts paired with ERA5 reanalysis.

- Forecast: the Previous Runs API's ``*_previous_day1`` variables, i.e. what the model
  run of the day before said about each hour (archived from 19 January 2024).
- Observed: ERA5 reanalysis from the Historical Weather API. ERA5 is a model-based
  reconstruction of what happened, not station measurements; it is the best freely
  available record for these locations.

Responses are cached under ``backend/ml_data/`` so retraining does not refetch.
"""

from __future__ import annotations

import json
import time
from datetime import date as Date
from datetime import timedelta
from pathlib import Path

import httpx
import numpy as np
import pandas as pd

from ..engine.scenario import Location
from ..engine.weather import TZ

CACHE_DIR = Path(__file__).resolve().parents[2] / "ml_data"
PREVIOUS_RUNS_URL = "https://previous-runs-api.open-meteo.com/v1/forecast"
ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive"
FORECAST_VARS = ["shortwave_radiation_previous_day1", "cloud_cover_previous_day1", "precipitation_previous_day1"]
OBSERVED_VARS = ["shortwave_radiation", "precipitation"]


def _get(url: str, params: dict, cache_name: str) -> dict:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    path = CACHE_DIR / cache_name
    if path.is_file():
        return json.loads(path.read_text(encoding="utf-8"))
    for attempt in range(4):
        try:
            r = httpx.get(url, params=params, timeout=60)
            r.raise_for_status()
            data = r.json()
            path.write_text(json.dumps(data), encoding="utf-8")
            return data
        except Exception:
            if attempt == 3:
                raise
            time.sleep(2 * (attempt + 1))
    raise RuntimeError("unreachable")


def _chunks(start: str, end: str, days: int = 120):
    d0, d1 = Date.fromisoformat(start), Date.fromisoformat(end)
    while d0 <= d1:
        e = min(d1, d0 + timedelta(days=days - 1))
        yield d0.isoformat(), e.isoformat()
        d0 = e + timedelta(days=1)


def hourly_frame(loc: Location, start: str, end: str) -> pd.DataFrame:
    """Hourly forecast and observed values for one location, indexed by local hour-ending time."""
    parts = []
    for a, b in _chunks(start, end):
        common = {"latitude": loc.lat, "longitude": loc.lon, "timezone": TZ, "start_date": a, "end_date": b}
        fc = _get(PREVIOUS_RUNS_URL, {**common, "hourly": ",".join(FORECAST_VARS)}, f"fc_{loc.id}_{a}_{b}.json")["hourly"]
        ob = _get(ARCHIVE_URL, {**common, "hourly": ",".join(OBSERVED_VARS), "models": "era5"}, f"era5_{loc.id}_{a}_{b}.json")["hourly"]
        assert fc["time"] == ob["time"], "forecast and observed hours differ"
        parts.append(pd.DataFrame({
            "fc_ghi": fc["shortwave_radiation_previous_day1"],
            "fc_cloud": fc["cloud_cover_previous_day1"],
            "fc_precip": fc["precipitation_previous_day1"],
            "obs_ghi": ob["shortwave_radiation"],
            "obs_precip": ob["precipitation"],
        }, index=pd.DatetimeIndex(fc["time"]).tz_localize(TZ)))
    df = pd.concat(parts).astype(float)
    df["location"] = loc.id
    return df


def complete_days(df: pd.DataFrame) -> pd.DataFrame:
    """Keep only local days where every hour has both a forecast and an observation."""
    ok = df[["fc_ghi", "fc_cloud", "fc_precip", "obs_ghi", "obs_precip"]].notna().all(axis=1)
    full = ok.groupby(df.index.date).transform("all")
    return df[full.to_numpy()]


def rain_windows(df: pd.DataFrame, lookahead_h: int, start_hour: int) -> pd.DataFrame:
    """One row per day: forecast and observed rain over [start_hour, start_hour + lookahead_h)."""
    rows = []
    hours = df.index
    by_time = {t: i for i, t in enumerate(hours)}
    for day in sorted(set(hours.date)):
        t0 = pd.Timestamp(f"{day} {start_hour:02d}:00").tz_localize(TZ) + pd.Timedelta(hours=1)  # hour-ending
        idx = [by_time.get(t0 + pd.Timedelta(hours=k)) for k in range(lookahead_h)]
        if any(i is None for i in idx):
            continue
        w = df.iloc[idx]
        rows.append({
            "day": str(day), "fc_precip": w["fc_precip"].to_numpy(), "fc_cloud": w["fc_cloud"].to_numpy(),
            "obs_sum": float(w["obs_precip"].sum()),
        })
    return pd.DataFrame(rows)


def window_arrays(windows: pd.DataFrame) -> tuple[np.ndarray, np.ndarray]:
    return np.stack(windows["fc_precip"].to_numpy()), np.stack(windows["fc_cloud"].to_numpy())
